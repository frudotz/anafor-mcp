import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
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

export interface CodexAdapterOptions {
  /** codex çalıştırılabilir dosyası; varsayılan ANAFOR_CODEX_BIN veya PATH'teki `codex`. */
  bin?: string;
  maxConcurrency?: number;
}

export class CodexAdapter implements WorkerAdapter {
  readonly id = 'codex';
  private readonly bin: string;
  private readonly maxConcurrency: number;

  constructor(opts: CodexAdapterOptions = {}) {
    this.bin = opts.bin ?? process.env.ANAFOR_CODEX_BIN ?? 'codex';
    this.maxConcurrency = opts.maxConcurrency ?? 2;
  }

  async detect(): Promise<WorkerAvailability> {
    const v = spawnSync(this.bin, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (v.error || v.status !== 0) {
      return { available: false, reason: v.error?.message ?? `codex --version: ${v.status}` };
    }
    const auth = spawnSync(this.bin, ['login', 'status'], { encoding: 'utf8', windowsHide: true });
    return {
      available: true,
      version: v.stdout.trim(),
      authOk: auth.status === 0,
      ...(auth.status === 0 ? {} : { reason: 'codex oturum açılmamış: `codex login`' }),
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
