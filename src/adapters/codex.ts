import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
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

/** Codex `exec --json` olaylarını normalize olaylara çevirir. Bkz. vault F0 bulguları. */
export function parseCodexLine(line: string): WorkerEvent[] {
  if (!line.trim().startsWith('{')) return [];
  const ev = JSON.parse(line) as Record<string, unknown>;
  const type = ev.type;
  if (type === 'thread.started' && typeof ev.thread_id === 'string') {
    return [{ type: 'session', sessionRef: ev.thread_id }];
  }
  if (type === 'item.completed' && ev.item && typeof ev.item === 'object') {
    const item = ev.item as Record<string, unknown>;
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      return [{ type: 'message', text: item.text }];
    }
    if (item.type === 'command_execution') {
      return [
        {
          type: 'command',
          command: String(item.command ?? ''),
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        },
      ];
    }
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      return (item.changes as Record<string, unknown>[]).map((c) => ({
        type: 'file_change' as const,
        path: String(c.path ?? ''),
        kind: String(c.kind ?? 'update'),
      }));
    }
    return [];
  }
  if (type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
    const u = ev.usage as Record<string, unknown>;
    const n = (k: string) => (typeof u[k] === 'number' ? u[k] : undefined);
    return [
      {
        type: 'usage',
        inputTokens: n('input_tokens'),
        cachedInputTokens: n('cached_input_tokens'),
        outputTokens: n('output_tokens'),
        reasoningOutputTokens: n('reasoning_output_tokens'),
      },
    ];
  }
  if (type === 'error') {
    return [{ type: 'error', message: String(ev.message ?? 'bilinmeyen hata'), fatal: false }];
  }
  if (type === 'turn.failed') {
    const err = (ev.error ?? {}) as Record<string, unknown>;
    return [{ type: 'error', message: String(err.message ?? 'tur başarısız'), fatal: true }];
  }
  return [];
}

export type CodexWindowsSandbox = 'elevated' | 'unelevated';

/**
 * `~/.codex/config.toml` içindeki `[windows] sandbox` değeri (yalnızca bu anahtar okunur;
 * kimlik bilgisine dokunulmaz). Yoksa null.
 */
export function readCodexWindowsSandbox(
  env: NodeJS.ProcessEnv = process.env,
): CodexWindowsSandbox | null {
  try {
    const toml = readFileSync(
      join(env.CODEX_HOME ?? join(homedir(), '.codex'), 'config.toml'),
      'utf8',
    );
    return parseWindowsSandbox(toml);
  } catch {
    return null;
  }
}

export function parseWindowsSandbox(toml: string): CodexWindowsSandbox | null {
  let section = '';
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.trim();
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1]!.trim();
      continue;
    }
    const m = /^sandbox\s*=\s*"([^"]*)"/.exec(line);
    if (m && section === 'windows' && (m[1] === 'elevated' || m[1] === 'unelevated')) return m[1];
    const dotted = /^windows\.sandbox\s*=\s*"([^"]*)"/.exec(line);
    if (dotted && section === '' && (dotted[1] === 'elevated' || dotted[1] === 'unelevated'))
      return dotted[1];
  }
  return null;
}

/**
 * Windows'ta Codex'in "unelevated" (restricted token) sandbox'ı isimli pipe oluşturmaya izin
 * vermez: pipe'lı stdio ile her alt süreç `spawn EPERM` verir (vitest forks, npm betikleri,
 * test koşucuları). "elevated" sandbox (ayrı CodexSandbox* hesapları) bunu engellemez. Bkz. F16.
 */
export function windowsSandboxWarning(effective: CodexWindowsSandbox | null): string | null {
  if (effective === 'elevated') return null;
  return (
    `Windows sandbox "${effective ?? 'varsayılan'}": işçi alt süreç başlatamayabilir (spawn EPERM), ` +
    'testler çalışmaz. Öneri: anafor.config.json → workers.codex.windows_sandbox = "elevated"'
  );
}

export interface CodexAdapterOptions {
  /** codex çalıştırılabilir dosyası; varsayılan ANAFOR_CODEX_BIN veya PATH'teki `codex`. */
  bin?: string;
  maxConcurrency?: number;
  /** Yalnızca Windows: Codex `windows.sandbox` ayarını Anafor işleri için ezer. */
  windowsSandbox?: CodexWindowsSandbox;
  /** Test için platform ezmesi. */
  platform?: NodeJS.Platform;
}

export class CodexAdapter implements WorkerAdapter {
  readonly id = 'codex';
  private readonly bin: string;
  private readonly maxConcurrency: number;
  private readonly windowsSandbox: CodexWindowsSandbox | undefined;
  private readonly platform: NodeJS.Platform;

  constructor(opts: CodexAdapterOptions = {}) {
    this.bin = opts.bin ?? process.env.ANAFOR_CODEX_BIN ?? 'codex';
    this.maxConcurrency = opts.maxConcurrency ?? 2;
    this.windowsSandbox = opts.windowsSandbox;
    this.platform = opts.platform ?? process.platform;
  }

  /** Windows'ta Anafor ezmesi varsa `-c windows.sandbox=...`. */
  sandboxArgs(): string[] {
    return this.platform === 'win32' && this.windowsSandbox
      ? ['-c', `windows.sandbox="${this.windowsSandbox}"`]
      : [];
  }

  async detect(): Promise<WorkerAvailability> {
    const v = spawnSync(this.bin, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (v.error || v.status !== 0) {
      return { available: false, reason: v.error?.message ?? `codex --version: ${v.status}` };
    }
    const auth = spawnSync(this.bin, ['login', 'status'], { encoding: 'utf8', windowsHide: true });
    const warn =
      this.platform === 'win32'
        ? windowsSandboxWarning(this.windowsSandbox ?? readCodexWindowsSandbox())
        : null;
    const reasons = [auth.status === 0 ? null : 'codex oturum açılmamış: `codex login`', warn];
    const reason = reasons.filter(Boolean).join(' · ');
    return {
      available: true,
      version: v.stdout.trim(),
      authOk: auth.status === 0,
      ...(reason ? { reason } : {}),
    };
  }

  capabilities(): WorkerCapabilities {
    return {
      roles: ['implementation', 'review', 'analysis', 'test'],
      structuredOutput: 'native',
      resume: true,
      sandbox: 'native',
      writesFiles: true,
      costTier: 'medium',
      maxConcurrency: this.maxConcurrency,
    };
  }

  start(job: JobSpec, ctx: JobContext): RunHandle {
    const args = [
      'exec',
      '--json',
      '--output-schema',
      job.outputSchemaPath,
      '-o',
      this.lastMessagePath(ctx),
      '-s',
      job.sandbox,
      '--skip-git-repo-check',
      ...this.sandboxArgs(),
      ...(job.model ? ['-m', job.model] : []),
      '-',
    ];
    return this.run(args, job, ctx);
  }

  resume(job: JobSpec, ctx: JobContext): RunHandle {
    if (!job.resumeSessionRef) throw new Error('resume için oturum gerekli');
    // F0: `exec resume` -s/-C almaz; sandbox config ile, dizin cwd ile verilir.
    const args = [
      'exec',
      'resume',
      job.resumeSessionRef,
      '--json',
      '--output-schema',
      job.outputSchemaPath,
      '-o',
      this.lastMessagePath(ctx),
      '-c',
      `sandbox_mode="${job.sandbox}"`,
      ...this.sandboxArgs(),
      ...(job.model ? ['-m', job.model] : []),
      '-',
    ];
    return this.run(args, job, ctx);
  }

  private lastMessagePath(ctx: JobContext): string {
    return join(ctx.artifactsDir, 'last-message.json');
  }

  private run(args: string[], job: JobSpec, ctx: JobContext): RunHandle {
    const lastPath = this.lastMessagePath(ctx);
    return runLineProcess({
      command: this.bin,
      args,
      cwd: job.workdir,
      env: ctx.env,
      stdin: job.prompt,
      artifactsDir: ctx.artifactsDir,
      parseLine: parseCodexLine,
      finalize: ({ lastMessage, sessionRef }) => ({
        finalMessage: existsSync(lastPath) ? readFileSync(lastPath, 'utf8') : lastMessage,
        sessionRef,
      }),
    });
  }
}
