import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import { git } from '../../src/git/git.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';
import { runJob } from '../../src/runner/run-job.js';

const adapters: AdapterRegistry = new Map([['fake', new FakeAdapter()]]);

async function run(
  config: Record<string, unknown>,
  instruction = '[fake:ok] [fake-file:auto.txt]',
  role: 'implementation' | 'review' | 'analysis' = 'implementation',
  deferAuto = false,
) {
  const t = tempDir();
  git(t.dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(t.dir, '.gitignore'), '.anafor/\n');
  git(t.dir, ['add', '.gitignore']);
  git(t.dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  mkdirSync(join(t.dir, '.anafor'), { recursive: true });
  writeFileSync(
    join(t.dir, '.anafor', 'config.json'),
    JSON.stringify({ auto_continue: { enabled: false, max: 1 }, ...config }),
  );
  const store = new Store(t.dir);
  let deferredRun: Promise<unknown> | undefined;
  const launcher = deferAuto
    ? (s: Store, job: import('../../src/store/store.js').Job) => {
        deferredRun = runJob(s, job.id, adapters);
      }
    : inProcessLauncher(adapters);
  const svc = new AnaforService(store, adapters, launcher, 'fake');
  const task = svc.taskCreate({ title: 'auto check', objective: 'verify' });
  const dispatched = await svc.jobDispatch({
    taskId: task.task_id,
    role,
    instructions: instruction,
  });
  if (deferAuto) {
    await deferredRun;
  } else {
    await svc.jobWait([dispatched.job_id], 30);
  }
  return { t, store, svc, task, jobId: dispatched.job_id, waitRunner: () => deferredRun };
}

describe('auto_check via service and fake worker', () => {
  it('automatically continues eligible partial implementation and does not count it as a manual correction', async () => {
    const x = await run({ auto_continue: { enabled: true, max: 1 } }, '[fake:partial]');
    try {
      const parent = x.store.mustGetJob(x.jobId);
      expect(parent.state).toBe('changes_requested');
      expect(x.store.getTask(x.task.task_id)?.correctionCount).toBe(0);
      const event = x.store.listEvents(x.jobId).find((e) => e.type === 'auto_continue');
      expect(event?.summary).toMatch(/J-/);
      expect(x.svc.jobStatus(x.jobId).continued_by).toMatch(/J-/);
      const waited = await x.svc.jobWait([x.jobId], 1);
      expect(waited.note).toContain(waited.continued_by[x.jobId]);
      expect(
        x.store.listJobs({ taskId: x.task.task_id }).filter((j) => j.autoContinued),
      ).toHaveLength(1);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('blockers doluysa pending işaretlenmez ve devam etmez', async () => {
    const x = await run(
      { auto_continue: { enabled: true, max: 1 } },
      '[fake:partial]',
      'implementation',
      true,
    );
    try {
      const job = x.store.mustGetJob(x.jobId);
      const result = { ...job.result!, blockers: ['harici engel'] };
      x.store.db
        .prepare('UPDATE jobs SET result_json = ?, auto_continue_pending = 1 WHERE id = ?')
        .run(JSON.stringify(result), x.jobId);
      await x.svc.maybeAutoContinue(x.jobId);
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(1);
      x.store.db
        .prepare('UPDATE jobs SET result_json = ?, auto_continue_pending = 1 WHERE id = ?')
        .run(JSON.stringify({ ...result, blockers: [] }), x.jobId);
      await x.svc.maybeAutoContinue(x.jobId);
      await x.waitRunner();
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(2);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('critical bulgu varsa pending işaretlenmez ve devam etmez', async () => {
    const x = await run(
      { auto_continue: { enabled: true, max: 1 } },
      '[fake:partial]',
      'implementation',
      true,
    );
    try {
      const job = x.store.mustGetJob(x.jobId);
      const result = {
        ...job.result!,
        review: { level: 'deep' as const, critical_count: 1, findings: [] },
      };
      x.store.db
        .prepare('UPDATE jobs SET result_json = ?, auto_continue_pending = 1 WHERE id = ?')
        .run(JSON.stringify(result), x.jobId);
      await x.svc.maybeAutoContinue(x.jobId);
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(1);
      x.store.db
        .prepare('UPDATE jobs SET result_json = ?, auto_continue_pending = 1 WHERE id = ?')
        .run(
          JSON.stringify({ ...result, review: { level: 'deep', critical_count: 0, findings: [] } }),
          x.jobId,
        );
      await x.svc.maybeAutoContinue(x.jobId);
      await x.waitRunner();
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(2);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('max aşımında otomatik devam işi tekrar devam etmez', async () => {
    const x = await run({ auto_continue: { enabled: true, max: 1 } }, '[fake:partial]');
    try {
      const child = x.store.listJobs({ taskId: x.task.task_id }).find((j) => j.autoContinued)!;
      const partial = {
        ...x.store.mustGetJob(x.jobId).result!,
        status: 'partial' as const,
        requirements_missing: ['ikinci eksik'],
      };
      x.store.db
        .prepare(
          "UPDATE jobs SET state = 'needs_review', result_json = ?, auto_continue_pending = 1 WHERE id = ?",
        )
        .run(JSON.stringify(partial), child.id);
      await x.svc.maybeAutoContinue(child.id);
      expect(
        x.store.listJobs({ taskId: x.task.task_id }).filter((j) => j.autoContinued),
      ).toHaveLength(1);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('enabled:false pending üretmez', async () => {
    const x = await run({ auto_continue: { enabled: false, max: 1 } }, '[fake:partial]');
    try {
      expect(x.store.mustGetJob(x.jobId).autoContinuePending).toBe(false);
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(1);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('manuel düzeltme sayılmaz ve otomatik devam kotası kullanılabilir', async () => {
    const x = await run({ auto_continue: { enabled: false, max: 1 } }, '[fake:partial]');
    try {
      writeFileSync(
        join(x.t.dir, '.anafor', 'config.json'),
        JSON.stringify({ auto_continue: { enabled: true, max: 1 } }),
      );
      writeFileSync(
        join(x.t.dir, 'anafor.config.json'),
        JSON.stringify({ auto_continue: { enabled: true, max: 1 } }),
      );
      const manual = await x.svc.jobRequestChanges(x.jobId, [], '[fake:partial]');
      await x.svc.jobWait([manual.job_id], 30);
      expect(x.store.getTask(x.task.task_id)?.correctionCount).toBe(1);
      const child = x.store.mustGetJob(manual.job_id);
      expect(child.state).toBe('changes_requested');
      expect(
        x.store.listJobs({ taskId: x.task.task_id }).filter((j) => j.autoContinued),
      ).toHaveLength(1);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it.each(['review', 'analysis'] as const)('%s rolü otomatik devam etmez', async (role) => {
    const x = await run({ auto_continue: { enabled: true, max: 1 } }, '[fake:partial]', role);
    try {
      expect(x.store.mustGetJob(x.jobId).autoContinuePending).toBe(false);
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(1);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('görev kapalıysa pending talebi tüketip devam işi açmaz', async () => {
    const x = await run(
      { auto_continue: { enabled: true, max: 1 } },
      '[fake:partial]',
      'implementation',
      true,
    );
    try {
      x.svc.taskClose(x.task.task_id, 'abandoned', 'test');
      x.store.db
        .prepare("UPDATE jobs SET state = 'needs_review', auto_continue_pending = 1 WHERE id = ?")
        .run(x.jobId);
      await x.svc.maybeAutoContinue(x.jobId);
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(1);
      x.store.updateTask(x.task.task_id, { state: 'open' });
      x.store.db.prepare('UPDATE jobs SET auto_continue_pending = 1 WHERE id = ?').run(x.jobId);
      await x.svc.maybeAutoContinue(x.jobId);
      await x.waitRunner();
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(2);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('eski pending işaretsiz needs_review partial iş drainQueue ile canlanmaz', async () => {
    const x = await run({ auto_continue: { enabled: false, max: 1 } }, '[fake:partial]');
    try {
      writeFileSync(
        join(x.t.dir, 'anafor.config.json'),
        JSON.stringify({ auto_continue: { enabled: true, max: 1 } }),
      );
      x.svc.drainQueue();
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(1);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('aynı pending işi eşzamanlı sahiplenen çağrılardan yalnız biri iş açar', async () => {
    const x = await run({ auto_continue: { enabled: true, max: 1 } }, '[fake:partial]');
    try {
      const child = x.store.listJobs({ taskId: x.task.task_id }).find((j) => j.autoContinued);
      expect(child).toBeDefined();
      expect(x.store.claimAutoContinuePending(x.jobId)).toBeNull();
      expect(
        x.store.listJobs({ taskId: x.task.task_id }).filter((j) => j.autoContinued),
      ).toHaveLength(1);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('elle düzeltme talebi pending otomatik talebi geçersiz kılar', async () => {
    const x = await run({ auto_continue: { enabled: false, max: 1 } }, '[fake:partial]');
    try {
      x.store.db.prepare('UPDATE jobs SET auto_continue_pending = 1 WHERE id = ?').run(x.jobId);
      await x.svc.jobRequestChanges(x.jobId, [], 'manuel inceleme');
      await x.svc.maybeAutoContinue(x.jobId);
      expect(x.store.mustGetJob(x.jobId).autoContinuePending).toBe(false);
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(2);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });

  it('çocuk iş oluşturma hatasını olay, konsol ve manuel devam notuyla bildirir', async () => {
    const x = await run(
      { auto_continue: { enabled: true, max: 1 } },
      '[fake:partial]',
      'implementation',
      true,
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const createJob = x.store.createJob.bind(x.store);
      x.store.createJob = (() => {
        throw new Error('test create failure');
      }) as typeof x.store.createJob;
      await expect(x.svc.maybeAutoContinue(x.jobId)).rejects.toThrow('test create failure');
      x.store.createJob = createJob;
      const failure = x.store
        .listEvents(x.jobId)
        .find((event) => event.type === 'auto_continue_failed');
      expect(failure?.summary).toContain('test create failure');
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(1);
      expect(x.store.mustGetJob(x.jobId).state).toBe('changes_requested');
      expect(x.store.getTask(x.task.task_id)?.note).toContain('job_request_changes');
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      x.store.close();
      x.t.cleanup();
    }
  });

  it('MAX yarışında otomatik yol atlanır ve kaynak işe devam olayı yazılmaz', async () => {
    const x = await run(
      { auto_continue: { enabled: true, max: 1 } },
      '[fake:partial]',
      'implementation',
      true,
    );
    try {
      const request = x.svc.jobRequestChanges.bind(x.svc);
      x.svc.jobRequestChanges = (async (...args) => {
        x.store.updateTask(x.task.task_id, { correctionCount: 5 });
        return request(...args);
      }) as typeof x.svc.jobRequestChanges;
      expect(x.store.mustGetJob(x.jobId).autoContinuePending).toBe(true);
      const outcome = await x.svc.maybeAutoContinue(x.jobId);
      expect(outcome).toHaveProperty('auto_continue_skipped');
      expect(x.store.listEvents(x.jobId).some((event) => event.type === 'auto_continue')).toBe(
        false,
      );
      expect(x.store.listJobs({ taskId: x.task.task_id })).toHaveLength(1);
    } finally {
      x.store.close();
      x.t.cleanup();
    }
  });
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
