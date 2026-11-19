import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import { git } from '../../src/git/git.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

const adapters: AdapterRegistry = new Map([['fake', new FakeAdapter()]]);

async function run(
  config: Record<string, unknown>,
  instruction = '[fake:ok] [fake-file:auto.txt]',
) {
  const t = tempDir();
  git(t.dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(t.dir, '.gitignore'), '.anafor/\n');
  git(t.dir, ['add', '.gitignore']);
  git(t.dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  mkdirSync(join(t.dir, '.anafor'), { recursive: true });
  writeFileSync(join(t.dir, '.anafor', 'config.json'), JSON.stringify(config));
  const store = new Store(t.dir);
  const svc = new AnaforService(store, adapters, inProcessLauncher(adapters), 'fake');
  const task = svc.taskCreate({ title: 'auto check', objective: 'verify' });
  const dispatched = await svc.jobDispatch({
    taskId: task.task_id,
    role: 'implementation',
    instructions: instruction,
  });
  await svc.jobWait([dispatched.job_id], 30);
  return { t, store, svc, task, jobId: dispatched.job_id };
}

describe('auto_check via service and fake worker', () => {
  it('records null and warning when no test command exists', async () => {
    const x = await run({ auto_check: true });
    try {
      const job = x.store.mustGetJob(x.jobId);
      expect(job.autoCheck).toBeNull();
      expect(job.warnings).toContain('auto_check: test komutu bulunamadı');
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('does not run when auto_check is false', async () => {
    const x = await run({ auto_check: false, test_command: 'node -e "process.exit(1)"' });
    try {
      expect(x.store.mustGetJob(x.jobId).autoCheck).toBeNull();
      expect(x.store.listEvents(x.jobId).some((event) => event.type === 'auto_check')).toBe(false);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('successful check passes tests_pass and verified_by_evidence', async () => {
    const x = await run(
      { auto_check: true, test_command: 'node -e "process.exit(0)"' },
      '[fake:partial]',
    );
    try {
      const job = x.store.mustGetJob(x.jobId);
      expect(job.autoCheck?.passed).toBe(true);
      const accepted = x.svc.taskAccept(x.task.task_id, x.jobId);
      expect(accepted.passed_gates).toContain('tests_pass');
      expect(accepted.passed_gates).toContain('verified_by_evidence');
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('failed check leaves tests_pass failed with auto_check detail', async () => {
    const x = await run({ auto_check: true, test_command: 'node -e "process.exit(1)"' });
    try {
      expect(x.store.mustGetJob(x.jobId).autoCheck?.passed).toBe(false);
      const tests = x.svc
        .taskAccept(x.task.task_id, x.jobId)
        .failed_gates.find((gate) => gate.gate === 'tests_pass');
      expect(tests).toBeDefined();
      expect(tests?.detail).toContain('auto_check başarısız');
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('job_result includes diff summary', async () => {
    const x = await run({ auto_check: false });
    try {
      const result = x.svc.jobResult(x.jobId);
      expect(result.diff.changed_files).toContain('auto.txt');
      expect(result.diff).toHaveProperty('stat');
      expect(result.diff.mismatch).toHaveProperty('changed_but_not_reported');
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });
});
