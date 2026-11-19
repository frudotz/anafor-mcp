import { writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import { git } from '../../src/git/git.js';
import { runPreToolUse } from '../../src/hooks/director.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# t\n');
  writeFileSync(join(dir, '.gitignore'), '.anafor/\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

describe('görev devralma (takeover)', () => {
  let t: ReturnType<typeof tempDir>;
  let store: Store;
  let svc: AnaforService;
  const adapters: AdapterRegistry = new Map([['fake', new FakeAdapter()]]);

  beforeEach(() => {
    t = tempDir();
    initRepo(t.dir);
    store = new Store(t.dir);
    svc = new AnaforService(store, adapters, inProcessLauncher(adapters), 'fake');
  });
  afterEach(() => {
    store.close();
    t.cleanup();
  });

  const write = (file: string) =>
    runPreToolUse({ cwd: t.dir, tool_name: 'Write', tool_input: { file_path: file } }, {});

  it('eşik dolmadan devralma reddedilir; 3 başarısızlıktan sonra devralınır, tamamlanır ve kabul edilir', async () => {
    const task = svc.taskCreate({ title: 'Zor iş', objective: 'x' });
    const fail = async () => {
      const d = await svc.jobDispatch({
        taskId: task.task_id,
        role: 'implementation',
        instructions: '[fake:fail]',
        newSession: true,
      });
      await svc.jobWait([d.job_id], 30);
      return d.job_id;
    };
    await fail();
    expect(svc.takeoverStatus(task.task_id).eligible).toBe(false);
    expect(() => svc.taskTakeover(task.task_id, 'deneme amaçlı devralma')).toThrow(/koşulları/);
    await fail();
    await fail();
    const st = svc.taskStatus(task.task_id);
    expect(st.takeover.eligible).toBe(true);

    const tk = svc.taskTakeover(task.task_id, 'işçi üç kez başarısız oldu');
    expect(store.mustGetJob(tk.job_id).worker).toBe('director');
    expect(store.mustGetJob(tk.job_id).state).toBe('running');

    // izin: yalnızca devralınan worktree; proje kökündeki kod hâlâ yasak
    const inWt = join(tk.workdir, 'solution.ts');
    expect(write(inWt)).toBe('');
    expect(write(join(t.dir, 'src', 'other.ts'))).not.toBe('');

    writeFileSync(inWt, 'export const ok = true;\n');
    const done = svc.takeoverComplete(tk.job_id, {
      summary: 'yönetici çözdü',
      testsExecuted: ['npm test'],
      testsPassed: 1,
      testsFailed: 0,
      exitCodes: [0],
      requirementsCompleted: ['çözüm'],
      requirementsMissing: [],
    });
    expect(done.state).toBe('needs_review');
    expect(done.changed_files).toContain('solution.ts');
    // izin kapandı
    expect(write(inWt)).not.toBe('');

    const acc = svc.taskAccept(task.task_id, tk.job_id);
    expect(acc.failed_gates).toEqual([]);
    expect(svc.taskMerge(task.task_id).merged).toBe(true);
    const log = git(t.dir, ['log', '-3', '--format=%B']).stdout;
    expect(log).toContain('Anafor-Worker: director');
  });

  it('reconcile devralma işini öldürmez', async () => {
    const task = svc.taskCreate({ title: 'r', objective: 'x' });
    for (let i = 0; i < 3; i++) {
      const d = await svc.jobDispatch({
        taskId: task.task_id,
        role: 'implementation',
        instructions: '[fake:fail]',
        newSession: true,
      });
      await svc.jobWait([d.job_id], 30);
    }
    const tk = svc.taskTakeover(task.task_id, 'üç başarısızlık sonrası');
    expect(svc.reconcile()).toEqual([]);
    expect(store.mustGetJob(tk.job_id).state).toBe('running');
  });

  it('needs_review işindeki failed worker sonucu başarısız deneme sayılır', async () => {
    const task = svc.taskCreate({ title: 'Raporlanan hata', objective: 'x' });
    const d = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:ok]',
      newSession: true,
    });
    await svc.jobWait([d.job_id], 30);
    const original = store.listJobs.bind(store);
    store.listJobs = ((filter) =>
      original(filter).map((job) =>
        job.id === d.job_id ? { ...job, result: { ...job.result!, status: 'failed' } } : job,
      )) as typeof store.listJobs;
    for (let i = 0; i < 2; i++) {
      const next = await svc.jobDispatch({
        taskId: task.task_id,
        role: 'implementation',
        instructions: '[fake:fail]',
        newSession: true,
      });
      await svc.jobWait([next.job_id], 30);
    }
    expect(svc.takeoverStatus(task.task_id).failed_jobs).toHaveLength(3);
    expect(svc.takeoverStatus(task.task_id).eligible).toBe(true);
    store.listJobs = original;
  });

  it('worktree dosyaları allow_paths ile açılamaz (yalnızca izinle)', () => {
    const wtFile = join(t.dir, '.anafor', 'worktrees', 'J-x', 'src', 'a.ts');
    expect(write(wtFile)).not.toBe('');
    expect(relative(t.dir, wtFile)).toContain('worktrees');
  });
});
