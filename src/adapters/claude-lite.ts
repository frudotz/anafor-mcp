import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseClaudeRateLimitInfo } from '../limits/limits.js';
import { runLineProcess } from './process.js';
import type {
  JobContext,
  JobSpec,
  RunHandle,
  WorkerAdapter,
  WorkerAvailability,
  WorkerCapabilities,
  WorkerEvent,
} from './types.js';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** Claude Code `-p --output-format stream-json --verbose` olaylarını normalize eder. */
export function parseClaudeLine(line: string): WorkerEvent[] {
  if (!line.trim().startsWith('{')) return [];
  const ev = JSON.parse(line) as Record<string, unknown>;
  const type = ev.type;
  if (type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string') {
    return [{ type: 'session', sessionRef: ev.session_id }];
  }
  if (type === 'rate_limit_event' && ev.rate_limit_info && typeof ev.rate_limit_info === 'object') {
    const windows = parseClaudeRateLimitInfo(ev.rate_limit_info as Record<string, unknown>);
    return windows.length ? [{ type: 'limits', windows }] : [];
  }
  if (type === 'system' && ev.subtype === 'permission_denied') {
    return [
      {
        type: 'error',
        message: `izin reddedildi: ${String(ev.tool_name ?? '?')}`,
        fatal: false,
      },
    ];
  }
  if (type === 'assistant' && ev.message && typeof ev.message === 'object') {
    const content = (ev.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return [];
    const out: WorkerEvent[] = [];
    for (const c of content as Record<string, unknown>[]) {
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) {
        out.push({ type: 'message', text: c.text });
      } else if (c.type === 'tool_use') {
        const name = String(c.name ?? '');
        const input = (c.input ?? {}) as Record<string, unknown>;
        if (SHELL_TOOLS.has(name)) {
          out.push({ type: 'command', command: String(input.command ?? ''), exitCode: null });
        } else if (EDIT_TOOLS.has(name)) {
          out.push({
            type: 'file_change',
            path: String(input.file_path ?? input.notebook_path ?? ''),
            kind: name === 'Write' ? 'write' : 'update',
          });
        }
      }
    }
    return out;
  }
  if (type === 'result') {
    const out: WorkerEvent[] = [];
    const u = (ev.usage ?? {}) as Record<string, number | undefined>;
    const cacheRead = u.cache_read_input_tokens ?? 0;
    out.push({
      type: 'usage',
      inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + cacheRead,
      cachedInputTokens: cacheRead,
      outputTokens: u.output_tokens ?? 0,
    });
    if (ev.is_error === true) {
      out.push({ type: 'error', message: String(ev.result ?? ev.subtype ?? 'hata'), fatal: true });
    }
    // Yapılandırılmış çıktı son mesaj olarak iletilir (runner bunu doğrular).
    if (ev.structured_output && typeof ev.structured_output === 'object') {
      out.push({ type: 'message', text: JSON.stringify(ev.structured_output) });
    } else if (typeof ev.result === 'string' && ev.result.trim()) {
      out.push({ type: 'message', text: ev.result });
    }
    return out;
  }
  return [];
}

export interface ClaudeLiteOptions {
  bin?: string;
  model?: string;
  maxConcurrency?: number;
  /** Yazma işlerinde izinli araçlar (Claude Code izin kuralı sözdizimi). */
  allowedTools?: string[];
  userConfig?: 'isolate' | 'inherit';
}

export const DEFAULT_WRITE_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Edit',
  'Write',
  'MultiEdit',
  'Bash(npm:*)',
  'Bash(npx:*)',
  'Bash(node:*)',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'PowerShell(npm:*)',
  'PowerShell(npx:*)',
  'PowerShell(node:*)',
];
const READ_TOOLS = [
  'Read',
  'Grep',
  'Glob',
  'Bash(git diff:*)',
  'Bash(git status:*)',
  'Bash(git log:*)',
];

/**
 * Claude Code'u (varsayılan: haiku) işçi olarak çalıştırır. Anafor MCP'si yüklenmez
 * (--strict-mcp-config), izin atlatma yok: yazma işlerinde acceptEdits + sınırlı araç listesi.
 */
export class ClaudeLiteAdapter implements WorkerAdapter {
  readonly id = 'claude-lite';
  private readonly bin: string;
  private readonly model: string;
  private readonly maxConcurrency: number;
  private readonly allowedTools: string[];
  private readonly userConfig: 'isolate' | 'inherit';

  constructor(opts: ClaudeLiteOptions = {}) {
    this.bin = opts.bin ?? process.env.ANAFOR_CLAUDE_BIN ?? 'claude';
    this.model = opts.model ?? 'haiku';
    this.maxConcurrency = opts.maxConcurrency ?? 3;
    this.allowedTools = opts.allowedTools ?? DEFAULT_WRITE_TOOLS;
    this.userConfig = opts.userConfig ?? 'isolate';
  }

  async detect(): Promise<WorkerAvailability> {
    const v = spawnSync(this.bin, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (v.error || v.status !== 0) {
      return { available: false, reason: v.error?.message ?? `claude --version: ${v.status}` };
    }
    return { available: true, version: v.stdout.trim(), authOk: true };
  }

  capabilities(): WorkerCapabilities {
    return {
      roles: ['implementation', 'review', 'analysis', 'test'],
      structuredOutput: 'native',
      resume: true,
      sandbox: 'none',
      writesFiles: true,
      costTier: 'low',
      maxConcurrency: this.maxConcurrency,
    };
  }

  start(job: JobSpec, ctx: JobContext): RunHandle {
    return this.run(this.args(job), job, ctx);
  }

  resume(job: JobSpec, ctx: JobContext): RunHandle {
    if (!job.resumeSessionRef) throw new Error('resume için oturum gerekli');
    return this.run([...this.args(job), '--resume', job.resumeSessionRef], job, ctx);
  }

  args(job: JobSpec): string[] {
    // Claude CLI doğrulayıcısı draft 2020-12 meta-şema referansını tanımıyor: $schema/$id çıkarılır.
    const raw = JSON.parse(readFileSync(job.outputSchemaPath, 'utf8')) as Record<string, unknown>;
    delete raw.$schema;
    delete raw.$id;
    const schema = JSON.stringify(raw);
    const readonly = job.sandbox === 'read-only';
    return [
      '-p',
      '--model',
      job.model ?? this.model,
      ...(job.effort ? ['--effort', job.effort] : []),
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      schema,
      '--strict-mcp-config',
      ...(this.userConfig !== 'inherit' ? ['--disable-slash-commands'] : []),
      '--permission-mode',
      readonly ? 'default' : 'acceptEdits',
      '--allowedTools',
      ...(readonly ? READ_TOOLS : this.allowedTools),
      ...(readonly ? ['--disallowedTools', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] : []),
    ];
  }

  private run(args: string[], job: JobSpec, ctx: JobContext): RunHandle {
    return runLineProcess({
      command: this.bin,
      args,
      cwd: job.workdir,
      env: subscriptionEnv(ctx.env),
      stdin: job.prompt,
      artifactsDir: ctx.artifactsDir,
      parseLine: parseClaudeLine,
      finalize: ({ lastMessage, sessionRef }) => ({ finalMessage: lastMessage, sessionRef }),
    });
  }
}

/**
 * `-p` modunda ANTHROPIC_API_KEY varsa abonelik yerine API faturalanır (Claude Code
 * kimlik doğrulama belgesi). İşçi, kullanıcının kendi abonelik oturumuyla çalışsın diye
 * anahtar çıkarılır; bilinçli API kullanımı için ANAFOR_CLAUDE_USE_API_KEY=1.
 */
export function subscriptionEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.ANAFOR_CLAUDE_USE_API_KEY === '1') return env;
  const { ANTHROPIC_API_KEY: _drop, ...rest } = env;
  return rest;
}
