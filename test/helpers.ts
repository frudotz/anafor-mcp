import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkerResultV1 } from '../src/contracts/worker-result.js';

export function tempDir(prefix = 'anafor-test-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    // job_wait may observe the runner's terminal state just before its finally
    // block closes the SQLite store. On Windows, open DB/WAL handles can keep
    // the temp tree undeletable briefly; allow about 5.5 seconds for shutdown under load.
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  };
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
