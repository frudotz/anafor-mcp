import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCodexLine } from './codex.js';
import { runLineProcess } from './process.js';
import type {
  JobContext,
  JobSpec,
  RunHandle,
  WorkerAdapter,
  WorkerAvailability,
  WorkerCapabilities,
} from './types.js';

export const FAKE_WORKER_SCRIPT = fileURLToPath(
  new URL('../../scripts/fake-worker.mjs', import.meta.url),
);

/**
 * Gerçek model gerektirmeyen deterministik işçi (testler ve kuru çalıştırma).
 * Senaryo prompt'taki `[fake:<senaryo>]` işaretiyle seçilir.
 */
export class FakeAdapter implements WorkerAdapter {
  readonly id = 'fake';

  async detect(): Promise<WorkerAvailability> {
    return { available: existsSync(FAKE_WORKER_SCRIPT), version: 'fake-1', authOk: true };
  }

  capabilities(): WorkerCapabilities {
    return {
      roles: ['implementation', 'review', 'analysis', 'test'],
      structuredOutput: 'native',
      resume: true,
      sandbox: 'none',
      writesFiles: true,
      costTier: 'low',
      maxConcurrency: 4,
    };
  }

  start(job: JobSpec, ctx: JobContext): RunHandle {
    return this.run([], job, ctx);
  }

  resume(job: JobSpec, ctx: JobContext): RunHandle {
    return this.run(['--resume', job.resumeSessionRef ?? ''], job, ctx);
  }

  private run(extra: string[], job: JobSpec, ctx: JobContext): RunHandle {
    const out = join(ctx.artifactsDir, 'last-message.json');
    return runLineProcess({
      command: process.execPath,
      args: [FAKE_WORKER_SCRIPT, '-o', out, ...extra],
      cwd: job.workdir,
      env: ctx.env,
      stdin: job.prompt,
      artifactsDir: ctx.artifactsDir,
      parseLine: parseCodexLine,
      finalize: ({ lastMessage, sessionRef }) => ({
        finalMessage: existsSync(out) ? readFileSync(out, 'utf8') : lastMessage,
        sessionRef,
      }),
    });
  }
}
