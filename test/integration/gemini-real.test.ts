import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createGoogleParser,
  GeminiAdapter,
  geminiAuthSelected,
} from '../../src/adapters/google.js';
import { git } from '../../src/git/git.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

// gemini-cli 0.68.0 `-p --output-format stream-json` ile kaydedilen GERÇEK satırlar.
const REAL = [
  '{"type":"init","timestamp":"t","session_id":"65d541b8-acae-42de-9c75-ba93fe728d3f","model":"gemini-2.5-flash"}',
  '{"type":"message","timestamp":"t","role":"user","content":"# Anafor iş emri"}',
  '{"type":"message","timestamp":"t","role":"assistant","delta":true,"content":"{\\"a\\":"}',
  '{"type":"message","timestamp":"t","role":"assistant","delta":true,"content":"1}"}',
  '{"type":"tool_use","timestamp":"t","tool_name":"write_file","tool_id":"w1","parameters":{"file_path":"x.txt","content":"y"}}',
  '{"type":"tool_result","timestamp":"t","tool_id":"w1","status":"success"}',
  '{"type":"result","timestamp":"t","status":"success","stats":{"total_tokens":85,"input_tokens":60,"output_tokens":25,"cached":0,"input":60,"duration_ms":60,"tool_calls":0}}',
];

describe('gemini gerçek olay biçimi', () => {
  it('delta parçaları birleşir; kullanıcı yankısı atlanır; write_file → file_change; stats → kullanım', () => {
    const p = createGoogleParser();
    const evs = REAL.flatMap(p);
    expect(evs).toEqual([
      { type: 'session', sessionRef: '65d541b8-acae-42de-9c75-ba93fe728d3f' },
      { type: 'message', text: '{"a":' },
      { type: 'message', text: '{"a":1}' },
      { type: 'file_change', path: 'x.txt', kind: 'write_file' },
      { type: 'usage', inputTokens: 60, cachedInputTokens: 0, outputTokens: 25 },
    ]);
    expect(p.sawSuccess()).toBe(true);
  });

  it('başarılı result yoksa sawSuccess false', () => {
    const p = createGoogleParser();
    p('{"type":"result","status":"error","error":{"message":"kota"}}');
    expect(p.sawSuccess()).toBe(false);
  });

  it('kimlik yöntemi ayarı kontrolü', () => {
    const t = tempDir();
    try {
      expect(geminiAuthSelected({ GEMINI_CLI_HOME: t.dir })).toBe(false);
      mkdirSync(join(t.dir, '.gemini'));
      writeFileSync(
        join(t.dir, '.gemini', 'settings.json'),
        JSON.stringify({ security: { auth: { selectedType: 'gemini-api-key' } } }),
      );
      expect(geminiAuthSelected({ GEMINI_CLI_HOME: t.dir })).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});

/**
 * Gerçek gemini ikilisi + sahte Gemini API (hesap/anahtar gerekmez).
 * Çalıştırma: ANAFOR_E2E_GEMINI_BIN=<gemini yolu> npx vitest run test/integration/gemini-real.test.ts
 */
describe.skipIf(!process.env.ANAFOR_E2E_GEMINI_BIN)('gemini gerçek ikili + sahte API', () => {
  it('implementation işi: parçalı yanıt + write_file worktree içinde, sonuç doğrulanır', async () => {
    const t = tempDir();
    const port = 18300 + Math.floor(Math.random() * 600);
    const mock: ChildProcess = spawn(
      process.execPath,
      [
        fileURLToPath(new URL('../fixtures/gemini-mock.mjs', import.meta.url)),
        '',
        String(port),
        'tools',
      ],
      { stdio: 'ignore' },
    );
    await new Promise((r) => setTimeout(r, 800));
    const home = join(t.dir, 'home');
    mkdirSync(join(home, '.gemini'), { recursive: true });
    writeFileSync(
      join(home, '.gemini', 'settings.json'),
      JSON.stringify({
        security: { auth: { selectedType: 'gemini-api-key' }, folderTrust: { enabled: false } },
      }),
    );
    Object.assign(process.env, {
      GEMINI_API_KEY: 'sahte-anahtar',
      GOOGLE_GEMINI_BASE_URL: `http://127.0.0.1:${port}`,
      GEMINI_CLI_HOME: home,
    });
    const repo = join(t.dir, 'repo');
    mkdirSync(repo);
    git(repo, ['init', '-q', '-b', 'main']);
    writeFileSync(join(repo, '.gitignore'), '.anafor/\n');
    git(repo, ['add', '-A']);
    git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    const adapter = new GeminiAdapter({
      bin: process.env.ANAFOR_E2E_GEMINI_BIN!,
      model: 'gemini-2.5-flash',
    });
    expect((await adapter.detect()).available).toBe(true);
    const adapters = new Map([['gemini', adapter]]);
    const store = new Store(repo);
    try {
      const svc = new AnaforService(store, adapters, inProcessLauncher(adapters), 'gemini');
      const task = svc.taskCreate({ title: 'uyum', objective: 'yaz' });
      const d = await svc.jobDispatch({
        taskId: task.task_id,
        role: 'implementation',
        instructions: 'yaz',
        timeoutS: 240,
      });
      let w = await svc.jobWait([d.job_id], 50);
      for (let i = 0; i < 5 && w.still_running.length; i++) w = await svc.jobWait([d.job_id], 50);
      const job = store.mustGetJob(d.job_id);
      expect(job.error).toBeNull();
      expect(job.state).toBe('needs_review');
      expect(job.usage?.inputTokens).toBeGreaterThan(0);
      expect(store.listEvents(d.job_id).map((e) => e.type)).toContain('file_change');
      expect(existsSync(join(job.workdir, 'ANAFOR_GEMINI_TEST.txt'))).toBe(true);
    } finally {
      store.close();
      mock.kill();
      t.cleanup();
    }
  }, 300_000);
});
