import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { FakeAdapter } from '../../src/adapters/fake.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import { AnaforService, inProcessLauncher, ServiceError } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { configStamp, refreshConfigIfChanged } from '../../src/server/config-refresh.js';
import { tempDir } from '../helpers.js';

describe('AnaforService', () => {
  let t: ReturnType<typeof tempDir>;
  let store: Store;
  let svc: AnaforService;
  const adapters: AdapterRegistry = new Map([['fake', new FakeAdapter()]]);

  beforeEach(() => {
    t = tempDir();
    store = new Store(t.dir);
    svc = new AnaforService(store, adapters, inProcessLauncher(adapters), 'fake');
  });
  afterEach(() => {
    store.close();
    t.cleanup();
  });

  const finishedState = async (jobId: string) => {
    const w = await svc.jobWait([jobId], 30);
    expect(w.still_running).toEqual([]);
    return w.finished[0]!.state;
  };

  it('tam akış: görev → dağıt → bekle → sonuç → düzeltme → sonuç', async () => {
    const task = svc.taskCreate({
      title: 'Akış',
      objective: 'dosya oluştur',
      acceptanceCriteria: ['k'],
    });
    const d = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:ok]',
    });
    expect(['queued', 'starting', 'running']).toContain(d.state);
    expect(d.resumed_session).toBe(false);
    expect(await finishedState(d.job_id)).toBe('needs_review');
    expect(svc.taskStatus(task.task_id).state).toBe('in_review');

    const r = svc.jobResult(d.job_id);
    expect(r.result?.status).toBe('completed');
    expect(r.usage?.inputTokens).toBe(100);

    const c = await svc.jobRequestChanges(d.job_id, [
      { severity: 'medium', title: 'eksik', file: 'x', line: null, evidence: 'e' },
    ]);
    expect(c.correction).toBe(true);
    expect(c.correction_number).toBe(1);
    expect(await finishedState(c.job_id)).toBe('needs_review');
    const corr = store.mustGetJob(c.job_id);
    expect(corr.sessionRef).toBe(store.mustGetJob(d.job_id).sessionRef);
    expect(store.mustGetJob(d.job_id).state).toBe('changes_requested');
    const prompt = await import('node:fs').then((fs) =>
      fs.readFileSync(`${store.paths.jobDir(c.job_id)}/prompt.md`, 'utf8'),
    );
    expect(prompt).toContain('Düzeltme istenen bulgular');
  });

  it('aynı görevde ikinci dağıtım önceki oturumu devam ettirir', async () => {
    const task = svc.taskCreate({ title: 'Oturum', objective: 'x' });
    const a = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:ok]',
    });
    await finishedState(a.job_id);
    const b = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:ok]',
    });
    expect(b.resumed_session).toBe(true);
    await finishedState(b.job_id);
    const c = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:ok]',
      newSession: true,
    });
    expect(c.resumed_session).toBe(false);
    await finishedState(c.job_id);
  });

  it('paylaşılan alanda ikinci yazan iş CONFLICT', async () => {
    const task = svc.taskCreate({ title: 'Çakışma', objective: 'x' });
    const a = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    await expect(
      svc.jobDispatch({ taskId: task.task_id, role: 'implementation', instructions: '[fake:ok]' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    // salt okunur analiz paralel çalışabilir
    const r = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'analysis',
      instructions: '[fake:ok]',
    });
    expect(['queued', 'starting', 'running']).toContain(r.state);
    const c = svc.jobCancel(a.job_id, 'test');
    expect(c.state).toBe('cancelled');
    await finishedState(r.job_id);
  });

  it('iptal: süreç öldürülür, runner geri çekilir', async () => {
    const task = svc.taskCreate({ title: 'İptal', objective: 'x' });
    const a = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    await new Promise((r) => setTimeout(r, 800));
    svc.jobCancel(a.job_id, 'kullanıcı vazgeçti');
    await new Promise((r) => setTimeout(r, 1500));
    expect(store.mustGetJob(a.job_id).state).toBe('cancelled');
    expect(svc.taskStatus(task.task_id).state).toBe('in_review');
  });

  it('hatalar: bilinmeyen görev, işçi, worktree', async () => {
    await expect(
      svc.jobDispatch({ taskId: 'T-yok', role: 'implementation', instructions: 'x' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const task = svc.taskCreate({ title: 'h', objective: 'x' });
    await expect(
      svc.jobDispatch({
        taskId: task.task_id,
        role: 'implementation',
        instructions: 'x',
        worker: 'yok',
      }),
    ).rejects.toMatchObject({ code: 'WORKER_UNAVAILABLE' });
    await expect(
      svc.jobDispatch({
        taskId: task.task_id,
        role: 'implementation',
        instructions: 'x',
        workspace: 'worktree',
      }),
    ).rejects.toBeInstanceOf(ServiceError);
  });

  it('düzeltme sınırı aşılınca görev blocked', async () => {
    const task = svc.taskCreate({ title: 'Sınır', objective: 'x' });
    let { job_id: jobId } = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:ok]',
    });
    await finishedState(jobId);
    const f = [{ severity: 'low' as const, title: 't', file: null, line: null, evidence: 'e' }];
    for (let i = 0; i < 5; i++) {
      jobId = (await svc.jobRequestChanges(jobId, f)).job_id;
      await finishedState(jobId);
    }
    await expect(svc.jobRequestChanges(jobId, f)).rejects.toMatchObject({
      code: 'LIMIT_REACHED',
    });
    expect(svc.taskStatus(task.task_id).state).toBe('blocked');
  }, 60_000);

  it('reconcile: ölü süreçli iş orphaned olarak failed, yeniden çalıştırılmaz', () => {
    const task = store.createTask({ title: 'r', objective: 'x' });
    const j = store.createJob({
      taskId: task.id,
      role: 'implementation',
      worker: 'fake',
      workspaceMode: 'shared',
      workdir: t.dir,
      instructions: 'x',
      timeoutS: 10,
    });
    store.transitionJob(j.id, 'starting');
    store.transitionJob(j.id, 'running', { pid: 999_999 });
    expect(svc.reconcile()).toHaveLength(1);
    expect(store.mustGetJob(j.id).state).toBe('failed');
    expect(store.mustGetJob(j.id).error).toContain('orphaned');
  });

  it('project_status ve workers_list', async () => {
    svc.taskCreate({ title: 'a', objective: 'b' });
    expect(svc.projectStatus().open_tasks).toHaveLength(1);
    const w = await svc.workersList();
    expect(w[0]).toMatchObject({ id: 'fake', available: true });
  });

  it('config mtime/size değişince sonraki workers_list güncel adaptör kümesini kullanır', async () => {
    const before = configStamp(t.dir);
    mkdirSync(`${t.dir}/.anafor`, { recursive: true });
    writeFileSync(
      `${t.dir}/anafor.config.json`,
      JSON.stringify({
        workers: {
          codex: { enabled: true, windows_sandbox: 'elevated' },
          cirak: { enabled: false },
        },
      }),
    );
    let refreshes = 0;
    const after = refreshConfigIfChanged(t.dir, before, () => {
      refreshes++;
      svc.reloadConfig();
    });
    expect(after).not.toBe(before);
    expect(refreshes).toBe(1);
    const workers = await svc.workersList();
    expect(workers.map((worker) => worker.id)).toContain('codex');
    expect((svc.adapters.get('codex') as CodexAdapter).configuredWindowsSandbox).toBe('elevated');
  });
});
