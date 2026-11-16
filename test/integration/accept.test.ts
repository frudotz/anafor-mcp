import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import { git } from '../../src/git/git.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

function initRepo(dir: string): void {
  git(dir, ['init', '-q']);
  writeFileSync(join(dir, 'README.md'), '# t\n');
  writeFileSync(join(dir, '.gitignore'), '.anafor/\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

describe('job_diff ve task_accept', () => {
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

  const run = async (taskId: string, role: 'implementation' | 'review', extra = {}) => {
    const d = await svc.jobDispatch({ taskId, role, instructions: '[fake:ok]', ...extra });
    const w = await svc.jobWait([d.job_id], 30);
    expect(w.finished[0]?.state).toBe('needs_review');
    return d.job_id;
  };

  it('job_diff: taban HEAD, yeni dosya görünür, raporla uyumlu', async () => {
    const task = svc.taskCreate({ title: 'd', objective: 'x' });
    const jobId = await run(task.task_id, 'implementation');
    expect(store.mustGetJob(jobId).baseSha).toMatch(/^[0-9a-f]{40}$/);
    const diff = svc.jobDiff(jobId);
    expect(diff.changed_files).toContain('FAKE_OUTPUT.txt');
    expect(diff.mismatch.changed_but_not_reported).toEqual([]);
    expect(diff.mismatch.reported_but_unchanged).toEqual([]);
  });

  it('job_diff: izlenen dosya değişikliği patch içinde', async () => {
    const task = svc.taskCreate({ title: 'd2', objective: 'x' });
    const jobId = await run(task.task_id, 'implementation');
    writeFileSync(join(store.mustGetJob(jobId).workdir, 'README.md'), '# değişti\n');
    const diff = svc.jobDiff(jobId);
    expect(diff.patch).toContain('değişti');
    expect(diff.mismatch.changed_but_not_reported).toContain('README.md');
  });

  it('standard görev: kapılar geçer, görev accepted, iş approved', async () => {
    const task = svc.taskCreate({ title: 'a', objective: 'x' });
    const jobId = await run(task.task_id, 'implementation');
    const r = svc.taskAccept(task.task_id, jobId);
    expect(r.failed_gates).toEqual([]);
    expect(r.accepted).toBe(true);
    expect(store.mustGetJob(jobId).state).toBe('merged');
    expect(r.integration?.task_branch).toBe(`anafor/${task.task_id}`);
    expect(svc.taskStatus(task.task_id).state).toBe('accepted');
  });

  it('eski uygulama işi kabul edilemez', async () => {
    const task = svc.taskCreate({ title: 'eski', objective: 'x' });
    const first = await run(task.task_id, 'implementation');
    await run(task.task_id, 'implementation');
    const r = svc.taskAccept(task.task_id, first);
    expect(r.accepted).toBe(false);
    expect(r.failed_gates.map((g) => g.gate)).toContain('latest_implementation');
  });

  it('deep görev: review olmadan reddedilir, bağımsız review ile kabul', async () => {
    const task = svc.taskCreate({ title: 'deep', objective: 'x', reviewLevel: 'deep' });
    const impl = await run(task.task_id, 'implementation');
    const noReview = svc.taskAccept(task.task_id, impl);
    expect(noReview.accepted).toBe(false);
    expect(noReview.failed_gates.map((g) => g.gate)).toContain('deep_review');

    const review = await run(task.task_id, 'review', { newSession: true });
    const ok = svc.taskAccept(task.task_id, impl, review);
    expect(ok.failed_gates).toEqual([]);
    expect(ok.accepted).toBe(true);
    expect(store.mustGetJob(review).state).toBe('approved');
  });

  it('task_close: aktif iş varken CONFLICT, sonra kapanır', async () => {
    const task = svc.taskCreate({ title: 'kapat', objective: 'x' });
    const d = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    expect(() => svc.taskClose(task.task_id, 'abandoned', 'vazgeçildi')).toThrow(/aktif/);
    svc.jobCancel(d.job_id, 'kapanış');
    expect(svc.taskClose(task.task_id, 'abandoned', 'vazgeçildi').state).toBe('abandoned');
  });
});
