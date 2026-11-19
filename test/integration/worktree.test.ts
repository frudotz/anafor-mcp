import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import { git } from '../../src/git/git.js';
import { branchExists, commitWorktree } from '../../src/git/worktree.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# t\n');
  writeFileSync(join(dir, '.gitignore'), '.anafor/\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  mkdirSync(join(dir, '.anafor'), { recursive: true });
  writeFileSync(
    join(dir, '.anafor', 'config.json'),
    JSON.stringify({ review: { require_for: 'none' } }),
  );
}

describe('worktree paralelliği (F3)', () => {
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

  const accept = (taskId: string, jobId: string) => {
    const r = svc.taskAccept(taskId, jobId);
    expect(r.failed_gates).toEqual([]);
    return r;
  };

  it('.anafor-tmp dosyaları iş commitine alınmaz', () => {
    mkdirSync(join(t.dir, '.anafor-tmp'), { recursive: true });
    writeFileSync(join(t.dir, '.anafor-tmp', 'scratch.txt'), 'temporary');
    writeFileSync(join(t.dir, 'result.txt'), 'result');

    expect(commitWorktree(t.dir, 'test temporary exclusion')).not.toBeNull();
    const committed = git(t.dir, ['ls-tree', '-r', '--name-only', 'HEAD']).stdout;
    expect(committed).toContain('result.txt');
    expect(committed).not.toContain('.anafor-tmp');
    expect(existsSync(join(t.dir, '.anafor-tmp', 'scratch.txt'))).toBe(true);
  });

  it('iki işçi aynı anda ayrı worktree’lerde çalışır, kullanıcı ağacı temiz kalır, çakışmasız birleşir', async () => {
    const a = svc.taskCreate({ title: 'A', objective: 'a.txt' });
    const b = svc.taskCreate({ title: 'B', objective: 'b.txt' });
    const ja = await svc.jobDispatch({
      taskId: a.task_id,
      role: 'implementation',
      instructions: '[fake-file:a.txt]',
    });
    const jb = await svc.jobDispatch({
      taskId: b.task_id,
      role: 'implementation',
      instructions: '[fake-file:b.txt]',
    });
    const w = await svc.jobWait([ja.job_id, jb.job_id], 30, 'all');
    expect(w.finished.map((j) => j.state)).toEqual(['needs_review', 'needs_review']);

    const wa = store.mustGetJob(ja.job_id);
    const wb = store.mustGetJob(jb.job_id);
    expect(wa.workspaceMode).toBe('worktree');
    expect(wa.workdir).not.toBe(wb.workdir);
    expect(existsSync(join(wa.workdir, 'a.txt'))).toBe(true);
    expect(existsSync(join(t.dir, 'a.txt'))).toBe(false); // kullanıcı ağacına dokunulmadı
    expect(git(t.dir, ['status', '--porcelain']).stdout.trim()).toBe('');

    expect(accept(a.task_id, ja.job_id).integration?.task_branch).toBe(`anafor/${a.task_id}`);
    accept(b.task_id, jb.job_id);
    expect(store.mustGetJob(ja.job_id).state).toBe('merged');

    expect(svc.taskMerge(a.task_id).merged).toBe(true);
    expect(svc.taskMerge(b.task_id).merged).toBe(true);
    expect(readFileSync(join(t.dir, 'a.txt'), 'utf8')).toContain(ja.job_id);
    expect(existsSync(join(t.dir, 'b.txt'))).toBe(true);
  });

  it('aynı dosyaya dokunan iki görev: ikinci birleştirme çakışır ve geri alınır', async () => {
    const a = svc.taskCreate({ title: 'A', objective: 'x' });
    const b = svc.taskCreate({ title: 'B', objective: 'x' });
    const ja = await svc.jobDispatch({
      taskId: a.task_id,
      role: 'implementation',
      instructions: '[fake-file:same.txt]',
    });
    const jb = await svc.jobDispatch({
      taskId: b.task_id,
      role: 'implementation',
      instructions: '[fake-file:same.txt]',
    });
    await svc.jobWait([ja.job_id, jb.job_id], 30, 'all');
    accept(a.task_id, ja.job_id);
    accept(b.task_id, jb.job_id);
    expect(svc.taskMerge(a.task_id).merged).toBe(true);
    const second = svc.taskMerge(b.task_id);
    expect(second.merged).toBe(false);
    expect(second.conflicts).toContain('same.txt');
    expect(git(t.dir, ['status', '--porcelain']).stdout.trim()).toBe(''); // geri alındı
  });

  it('task_merge: izlenmeyen dosyalar (ör. kanıtlar) birleştirmeyi engellemez', async () => {
    const a = svc.taskCreate({ title: 'A', objective: 'x' });
    const ja = await svc.jobDispatch({
      taskId: a.task_id,
      role: 'implementation',
      instructions: '[fake-file:u.txt]',
    });
    await svc.jobWait([ja.job_id], 30);
    accept(a.task_id, ja.job_id);
    writeFileSync(join(t.dir, 'evidence-tests.md'), 'npm test → 0\n');
    expect(svc.taskMerge(a.task_id).merged).toBe(true);
    expect(readFileSync(join(t.dir, 'evidence-tests.md'), 'utf8')).toContain('npm test');
  });

  it('task_merge kirli çalışma ağacında reddedilir', async () => {
    const a = svc.taskCreate({ title: 'A', objective: 'x' });
    const ja = await svc.jobDispatch({
      taskId: a.task_id,
      role: 'implementation',
      instructions: '[fake-file:k.txt]',
    });
    await svc.jobWait([ja.job_id], 30);
    accept(a.task_id, ja.job_id);
    writeFileSync(join(t.dir, 'README.md'), 'kullanıcı değişikliği\n');
    expect(() => svc.taskMerge(a.task_id)).toThrow(/commit edilmemiş/);
    expect(readFileSync(join(t.dir, 'README.md'), 'utf8')).toBe('kullanıcı değişikliği\n');
  });

  it('düzeltme ve devam aynı worktree’de, review hedef işi salt okunur görür', async () => {
    const a = svc.taskCreate({ title: 'A', objective: 'x' });
    const j1 = await svc.jobDispatch({
      taskId: a.task_id,
      role: 'implementation',
      instructions: '[fake-file:c.txt]',
    });
    await svc.jobWait([j1.job_id], 30);
    const c = await svc.jobRequestChanges(j1.job_id, [
      { severity: 'low', title: 't', file: null, line: null, evidence: 'e' },
    ]);
    await svc.jobWait([c.job_id], 30);
    store.patchJob(c.job_id, {
      autoCheck: {
        command: 'npm test',
        passed: true,
        exit_code: 0,
        summary: 'npm test → 0',
        evidence: '.anafor/evidence/check.txt',
        workdir: store.mustGetJob(c.job_id).workdir,
      },
    });
    expect(store.mustGetJob(c.job_id).workdir).toBe(store.mustGetJob(j1.job_id).workdir);
    const r = await svc.jobDispatch({
      taskId: a.task_id,
      role: 'review',
      instructions: '[fake-file:review-note.txt]',
      newSession: true,
      targetJobId: c.job_id,
    });
    const rj = store.mustGetJob(r.job_id);
    expect(rj.workspaceMode).toBe('readonly');
    expect(rj.workdir).toBe(store.mustGetJob(c.job_id).workdir);
    expect(rj.inputs.reviewContext?.diffSummary).toContain('FAKE_OUTPUT.txt');
    expect(rj.inputs.reviewContext?.autoCheck?.command).toBe('npm test');
    await svc.jobWait([r.job_id], 30);
  });

  it('workspace_cleanup: birleşmiş işin worktree ve dalı silinir, aktif olana dokunulmaz', async () => {
    const a = svc.taskCreate({ title: 'A', objective: 'x' });
    const ja = await svc.jobDispatch({
      taskId: a.task_id,
      role: 'implementation',
      instructions: '[fake-file:z.txt]',
    });
    await svc.jobWait([ja.job_id], 30);
    accept(a.task_id, ja.job_id);
    const job = store.mustGetJob(ja.job_id);
    const res = svc.workspaceCleanup(a.task_id);
    expect(res.removed).toContain(job.workdir);
    expect(existsSync(job.workdir)).toBe(false);
    expect(branchExists(t.dir, job.branch!)).toBe(false);
    expect(branchExists(t.dir, `anafor/${a.task_id}`)).toBe(true); // görev dalı korunur

    const b = svc.taskCreate({ title: 'B', objective: 'x' });
    const jb = await svc.jobDispatch({
      taskId: b.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    await new Promise((r) => setTimeout(r, 500));
    expect(svc.workspaceCleanup(b.task_id).kept[0]?.reason).toContain('aktif');
    svc.jobCancel(jb.job_id, 'test sonu');
  });
});
