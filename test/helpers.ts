import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerResultV1 } from '../src/contracts/worker-result.js';

type CleanupOptions = {
  recursive?: boolean;
  force?: boolean;
  maxRetries?: number;
  retryDelay?: number;
};

export function tempDir(
  prefix = 'anafor-test-',
  opts: { maxRetries?: number; retryDelay?: number } = {},
): { dir: string; cleanup: () => void } {
  const base = process.env.ANAFOR_TEST_TMP ?? tmpdir();
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, prefix));
  return {
    dir,
    cleanup: () =>
      cleanupTempDir(dir, {
        recursive: true,
        force: true,
        maxRetries: opts.maxRetries ?? 5,
        retryDelay: opts.retryDelay ?? 100,
      }),
  };
}

export function cleanupTempDir(
  dir: string,
  options: CleanupOptions,
  remove: (path: string, options: CleanupOptions) => void = rmSync,
): void {
  const maxRetries = options.maxRetries ?? 0;
  const retryDelay = options.retryDelay ?? 100;
  for (let attempt = 0; ; attempt++) {
    try {
      remove(dir, options);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt < maxRetries) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retryDelay);
        continue;
      }
      if (code === 'EPERM' || code === 'EBUSY' || code === 'ENOTEMPTY') {
        process.stderr.write(`geçici dizin bırakıldı: ${dir}\n`);
        return;
      }
      throw error;
    }
  }
}

export function sampleResult(over: Partial<WorkerResultV1> = {}): WorkerResultV1 {
  return {
    schema_version: '1',
    task_id: 'T-1',
    job_id: 'J-1',
    agent_role: 'implementation',
    status: 'completed',
    summary: 'tamam',
    changed_files: ['a.ts'],
    requirements_completed: ['r1'],
    requirements_missing: [],
    tests: { executed: ['npm test'], passed: 3, failed: 0, exit_codes: [0] },
    review: { level: 'none', critical_count: 0, findings: [] },
    evidence_locations: [],
    blockers: [],
    recommended_next_action: 'incele',
    ...over,
  };
}
