import { createServer, type Server } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import { AntigravityAdapter, GeminiAdapter, parseGoogleLine } from '../../src/adapters/google.js';
import { LocalApiAdapter } from '../../src/adapters/local-api.js';
import { OpenCodeAdapter, parseOpenCodeLine } from '../../src/adapters/opencode.js';
import { quoteCmdArg } from '../../src/adapters/process.js';
import { defaultAdapters } from '../../src/adapters/registry.js';
import type { WorkerAdapter } from '../../src/adapters/types.js';
import { git } from '../../src/git/git.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { sampleResult, tempDir } from '../helpers.js';

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# t\n');
  writeFileSync(join(dir, '.gitignore'), '.anafor/\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

/** OpenAI uyumlu sahte sunucu: prompt'taki kimliklerle geçerli WorkerResult döner. */
function mockOpenAI(opts: { rejectSchema?: boolean } = {}) {
  const calls: { body: Record<string, unknown> }[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (req.url?.endsWith('/models')) {
        res.end(JSON.stringify({ data: [{ id: 'qwen-test' }] }));
        return;
      }
      const body = JSON.parse(raw) as Record<string, unknown>;
      calls.push({ body });
      const rf = body.response_format as { type: string };
      if (opts.rejectSchema && rf.type === 'json_schema') {
        res.statusCode = 400;
        res.end('json_schema desteklenmiyor');
        return;
      }
      const user = (body.messages as { content: string }[])[1]!.content;
      const pick = (k: string) => new RegExp(`${k}: ([\\w.-]+)`).exec(user)?.[1] ?? '?';
      const result = sampleResult({
        task_id: pick('task_id'),
        job_id: pick('job_id'),
        agent_role: 'review',
        changed_files: [],
        summary: user.includes('git diff HEAD') ? 'diff görüldü' : 'bağlam yok',
      });
      res.end(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(result) } }],
          usage: { prompt_tokens: 120, completion_tokens: 40 },
        }),
      );
    });
  });
  return new Promise<{ url: string; calls: typeof calls; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      resolve({ url: `http://127.0.0.1:${port}/v1`, calls, close: () => server.close() });
    });
  });
}

describe('yerel API işçisi (OpenAI uyumlu)', () => {
  let t: ReturnType<typeof tempDir>;
  let store: Store;
  beforeEach(() => {
    t = tempDir();
    initRepo(t.dir);
    store = new Store(t.dir);
  });
  afterEach(() => {
    store.close();
    t.cleanup();
  });

  const run = async (url: string) => {
    const local = new LocalApiAdapter({ baseUrl: url, model: 'qwen-test' });
    const adapters = new Map<string, WorkerAdapter>([['local', local]]);
    const svc = new AnaforService(store, adapters, inProcessLauncher(adapters), 'local');
    const task = svc.taskCreate({ title: 'İncele', objective: 'diff incele' });
    const d = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'review',
      instructions: 'incele',
    });
    await svc.jobWait([d.job_id], 30);
    return store.mustGetJob(d.job_id);
  };

  it('detect: model listesi', async () => {
    const m = await mockOpenAI();
    try {
      expect(
        (await new LocalApiAdapter({ baseUrl: m.url, model: 'qwen-test' }).detect()).available,
      ).toBe(true);
      expect((await new LocalApiAdapter({ baseUrl: m.url, model: 'yok' }).detect()).available).toBe(
        false,
      );
      expect(
        (await new LocalApiAdapter({ baseUrl: 'http://127.0.0.1:9/v1', model: 'x' }).detect())
          .available,
      ).toBe(false);
    } finally {
      m.close();
    }
  });

  it('review işi: json_schema ile doğrulanmış sonuç, diff bağlamı, token kullanımı', async () => {
    const m = await mockOpenAI();
    try {
      writeFileSync(join(t.dir, 'README.md'), '# değişti\n');
      const job = await run(m.url);
      expect(job.error).toBeNull();
      expect(job.state).toBe('needs_review');
      expect(job.result?.summary).toBe('diff görüldü');
      expect(job.usage?.inputTokens).toBe(120);
      expect((m.calls[0]!.body.response_format as { type: string }).type).toBe('json_schema');
    } finally {
      m.close();
    }
  });

  it('json_schema desteklemeyen sunucuda json_object ile yeniden dener', async () => {
    const m = await mockOpenAI({ rejectSchema: true });
    try {
      const job = await run(m.url);
      expect(job.state).toBe('needs_review');
      expect(m.calls.map((c) => (c.body.response_format as { type: string }).type)).toEqual([
        'json_schema',
        'json_object',
      ]);
    } finally {
      m.close();
    }
  });

  it('yazma rolleri desteklenmez', () => {
    expect(new LocalApiAdapter({ model: 'x' }).capabilities().roles).toEqual([
      'analysis',
      'review',
    ]);
  });
});

describe('deneysel işçi ayrıştırıcıları', () => {
  it('OpenCode NDJSON', () => {
    expect(
      parseOpenCodeLine('{"type":"step_start","sessionID":"ses_1","part":{"type":"step-start"}}'),
    ).toContainEqual({
      type: 'session',
      sessionRef: 'ses_1',
    });
    expect(
      parseOpenCodeLine('{"type":"text","sessionID":"s","part":{"type":"text","text":"merhaba"}}'),
    ).toEqual([{ type: 'message', text: 'merhaba' }]);
    expect(
      parseOpenCodeLine(
        '{"type":"tool_use","part":{"type":"tool","tool":"bash","state":{"input":{"command":"npm test"},"metadata":{"exit":0}}}}',
      ),
    ).toEqual([{ type: 'command', command: 'npm test', exitCode: 0 }]);
    expect(
      parseOpenCodeLine(
        '{"type":"step_finish","part":{"type":"step-finish","tokens":{"input":10,"output":5,"cache":{"read":3}}}}',
      ),
    ).toEqual([{ type: 'usage', inputTokens: 10, cachedInputTokens: 3, outputTokens: 5 }]);
    expect(parseOpenCodeLine('{"type":"error","error":{"message":"yetki yok"}}')[0]).toMatchObject({
      fatal: true,
    });
  });

  it('Antigravity/Gemini stream-json', () => {
    expect(parseGoogleLine('{"type":"init","conversation_id":"c1"}')).toEqual([
      { type: 'session', sessionRef: 'c1' },
    ]);
    const r = parseGoogleLine(
      JSON.stringify({
        type: 'result',
        status: 'SUCCESS',
        structured_output: { a: 1 },
        usage: { input_tokens: 9, output_tokens: 2, cache_read_tokens: 1 },
      }),
    );
    expect(r).toEqual([
      { type: 'usage', inputTokens: 9, cachedInputTokens: 1, outputTokens: 2 },
      { type: 'message', text: '{"a":1}' },
    ]);
    expect(
      parseGoogleLine('{"type":"result","status":"ERROR","error":{"message":"kota"}}'),
    ).toContainEqual({
      type: 'error',
      message: 'kota',
      fatal: true,
    });
  });
});

describe('politika kuralları', () => {
  it('antigravity varsayılan kayıtlı değil; açılsa da onaysız kullanılamaz', async () => {
    expect(defaultAdapters({ workers: {} }).has('antigravity')).toBe(false);
    expect(
      defaultAdapters({ workers: { antigravity: { enabled: true } } }).has('antigravity'),
    ).toBe(true);
    const d = await new AntigravityAdapter({}).detect();
    expect(d.available).toBe(false);
    expect(d.reason).toContain('acknowledge_terms');
  });

  it('opencode yalnızca model yapılandırılınca; anthropic/* reddedilir', async () => {
    expect(defaultAdapters({ workers: {} }).has('opencode')).toBe(false);
    expect(
      defaultAdapters({ workers: { opencode: { model: 'ollama/qwen3-coder' } } }).has('opencode'),
    ).toBe(true);
    const d = await new OpenCodeAdapter({
      bin: process.execPath,
      model: 'anthropic/claude-x',
    }).detect();
    expect(d.available).toBe(false);
    expect(d.reason).toContain('cirak');
  });

  it('gemini API anahtarı olmadan kullanılamaz', async () => {
    const saved = { g: process.env.GEMINI_API_KEY, o: process.env.GOOGLE_API_KEY };
    delete process.env.GEMINI_API_KEY;
    delete process.env.GOOGLE_API_KEY;
    try {
      const d = await new GeminiAdapter({ bin: process.execPath }).detect();
      expect(d.available).toBe(false);
      expect(d.reason).toContain('API anahtarı');
    } finally {
      if (saved.g) process.env.GEMINI_API_KEY = saved.g;
      if (saved.o) process.env.GOOGLE_API_KEY = saved.o;
    }
  });

  it('cmd argüman tırnaklama; çok satırlı argüman reddedilir', () => {
    expect(quoteCmdArg('basit')).toBe('basit');
    expect(quoteCmdArg('a b "c"')).toBe('"a b ""c"""');
    expect(() => quoteCmdArg('a\nb')).toThrow();
  });

  it('prompted işçiye şema prompt içinde verilir', async () => {
    const t = tempDir();
    const store = new Store(t.dir);
    try {
      const base = new FakeAdapter();
      const prompted: WorkerAdapter = {
        id: 'p',
        detect: () => base.detect(),
        capabilities: () => ({ ...base.capabilities(), structuredOutput: 'prompted' }),
        start: (j, c) => base.start(j, c),
      };
      const adapters = new Map([['p', prompted]]);
      const svc = new AnaforService(store, adapters, inProcessLauncher(adapters), 'p');
      const task = svc.taskCreate({ title: 'p', objective: 'x' });
      const d = await svc.jobDispatch({
        taskId: task.task_id,
        role: 'analysis',
        instructions: '[fake:ok]',
      });
      await svc.jobWait([d.job_id], 30);
      expect(readFileSync(join(store.paths.jobDir(d.job_id), 'prompt.md'), 'utf8')).toContain(
        '"title": "WorkerResult v1"',
      );
    } finally {
      store.close();
      t.cleanup();
    }
  });
});

describe('antigravity argümanları (agy 1.5.9 --help ile doğrulandı)', () => {
  it('şema dosya yoluyla, mod rol bazlı, print-timeout iş süresinden, izin atlatma yok', () => {
    const t = tempDir();
    try {
      const a = new AntigravityAdapter({ acknowledged: true });
      const job = {
        jobId: 'J',
        taskId: 'T',
        role: 'implementation' as const,
        prompt: 'iş\nemri',
        outputSchemaPath: join(process.cwd(), 'schemas', 'worker-result.v1.json'),
        workdir: t.dir,
        sandbox: 'workspace-write' as const,
        timeoutMs: 600_000,
      };
      const args = a.args(job, { artifactsDir: t.dir, env: {} });
      const schemaPath = args[args.indexOf('--json-schema') + 1]!;
      expect(JSON.parse(readFileSync(schemaPath, 'utf8')).$schema).toBeUndefined();
      expect(args[args.indexOf('--mode') + 1]).toBe('accept-edits');
      expect(args[args.indexOf('--print-timeout') + 1]).toBe('600s');
      expect(args.join(' ')).not.toMatch(/dangerously|--mode auto/);
      const ro = a.args({ ...job, sandbox: 'read-only' }, { artifactsDir: t.dir, env: {} });
      expect(ro[ro.indexOf('--mode') + 1]).toBe('plan');
    } finally {
      t.cleanup();
    }
  });
});

describe('antigravity gerçek olay biçimi (agy 1.5.9)', () => {
  // Gerçek çıktıdan kısaltılmış satırlar: olay adı `event`, veri iç içe.
  const REAL = [
    '{"event":"init","conversation_id":"fafe7991","init":{"cwd":"C:/w","tools":["write_file"]}}',
    '{"event":"step_update","step_update":{"conversation_id":"fafe7991","step_index":1,"state":"DONE","step_type":"agent_response","usage":{"input_tokens":9961,"output_tokens":194}}}',
    '{"event":"step_update","step_update":{"conversation_id":"fafe7991","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"write_file","tool_info":{"name":"write_file","parameters":{"Path":"C:/w/conformance.txt"}}}}',
    '{"event":"step_update","step_update":{"conversation_id":"fafe7991","step_index":2,"state":"DONE","step_type":"tool","tool_name":"write_file","tool_info":{"name":"write_file","parameters":{"Path":"C:/w/conformance.txt"}}}}',
    '{"event":"step_update","step_update":{"conversation_id":"fafe7991","step_index":3,"state":"DONE","step_type":"agent_response","text_delta":"{\\"a\\":1}"}}',
    '{"event":"result","result":{"conversation_id":"fafe7991","status":"SUCCESS","response":"{\\"a\\":1}","structured_output":{"a":1},"usage":{"input_tokens":12289,"output_tokens":402,"thinking_tokens":80,"cache_read_tokens":7907,"total_tokens":12691}}}',
  ];
  it('init → oturum, DONE tool → file_change (ACTIVE yok sayılır), result → kullanım + yapılandırılmış çıktı', async () => {
    const { parseAntigravityLine } = await import('../../src/adapters/google.js');
    expect(REAL.flatMap(parseAntigravityLine)).toEqual([
      { type: 'session', sessionRef: 'fafe7991' },
      { type: 'file_change', path: 'C:/w/conformance.txt', kind: 'write_file' },
      { type: 'message', text: '{"a":1}' },
      {
        type: 'usage',
        inputTokens: 12289,
        cachedInputTokens: 7907,
        outputTokens: 402,
        reasoningOutputTokens: 80,
      },
      { type: 'message', text: '{"a":1}' },
    ]);
  });
  it('başarısız sonuç → fatal hata', async () => {
    const { parseAntigravityLine } = await import('../../src/adapters/google.js');
    const evs = parseAntigravityLine(
      '{"event":"result","result":{"status":"ERROR","error":"authentication failed or timed out","usage":{}}}',
    );
    expect(evs).toContainEqual({
      type: 'error',
      message: 'authentication failed or timed out',
      fatal: true,
    });
  });
});
