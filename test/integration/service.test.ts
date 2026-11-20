import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git } from '../../src/git/git.js';
import { FakeAdapter } from '../../src/adapters/fake.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import { AnaforService, inProcessLauncher, ServiceError } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { configStamp, refreshConfigIfChanged } from '../../src/server/config-refresh.js';
import { tempDir } from '../helpers.js';
import { jobsTable } from '../../src/cli/chat.js';

describe('AnaforService', () => {
  let t: ReturnType<typeof tempDir>;
  let store: Store;
  let svc: AnaforService;
  const adapters: AdapterRegistry = new Map([['fake', new FakeAdapter()]]);

  beforeEach(() => {
    t = tempDir();
    writeFileSync(
      join(t.dir, 'anafor.config.json'),
      JSON.stringify({
        review: { require_for: 'none' },
        auto_continue: { enabled: false, max: 1 },
      }),
    );
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

  const addOtherJob = (taskId: string, changedFiles: string[]) => {
    const job = store.createJob({
      taskId,
      role: 'implementation',
      worker: 'fake',
      workspaceMode: 'shared',
      workdir: t.dir,
      instructions: 'parallel scope fixture',
      timeoutS: 30,
    });
    store.transitionJob(job.id, 'starting');
    store.transitionJob(job.id, 'running');
    store.transitionJob(job.id, 'validating');
    store.transitionJob(job.id, 'needs_review', {
      result: {
        schema_version: '1',
        task_id: taskId,
        job_id: job.id,
        agent_role: 'implementation',
        status: 'completed',
        summary: 'fixture',
        changed_files: changedFiles,
        requirements_completed: [],
        requirements_missing: [],
        tests: { executed: [], passed: 0, failed: 0, exit_codes: [] },
        review: { level: 'none', critical_count: 0, findings: [] },
        evidence_locations: [],
        blockers: [],
        recommended_next_action: '',
      },
    });
    return job;
  };

  it('jobDispatch paralel dosya çakışmasında uyarır', async () => {
    const other = svc.taskCreate({ title: 'Öteki', objective: 'x' });
    addOtherJob(other.task_id, ['src/a.ts']);
    const task = svc.taskCreate({ title: 'Yeni', objective: 'x', contextRefs: ['src/a.ts'] });
    const dispatched = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    expect(dispatched.warnings.join(' ')).toContain(other.task_id);
    expect(dispatched.warnings.join(' ')).toContain('src/a.ts');
    svc.jobCancel(dispatched.job_id, 'test');
  });

  it('jobDispatch yalnız implementation/test rollerinde tarar', async () => {
    const other = svc.taskCreate({ title: 'Öteki', objective: 'x' });
    addOtherJob(other.task_id, ['src/a.ts']);
    const task = svc.taskCreate({ title: 'Analiz', objective: 'x', contextRefs: ['src/a.ts'] });
    const dispatched = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'analysis',
      instructions: '[fake:ok]',
    });
    expect(dispatched.warnings).toEqual([]);
    await finishedState(dispatched.job_id);
  });

  it('jobDispatch queued işlerin kapsamını tarar', async () => {
    const other = svc.taskCreate({ title: 'Kuyrukta', objective: 'x', contextRefs: ['src/a.ts'] });
    store.createJob({
      taskId: other.task_id,
      role: 'implementation',
      worker: 'fake',
      workspaceMode: 'readonly',
      workdir: t.dir,
      instructions: 'queued fixture',
      timeoutS: 30,
    });
    const task = svc.taskCreate({ title: 'Yeni', objective: 'x', contextRefs: ['src/a.ts'] });
    const dispatched = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    expect(dispatched.warnings.join(' ')).toContain(other.task_id);
    svc.jobCancel(dispatched.job_id, 'test');
  });

  it('jobDispatch approved işlerin kapsamını tarar', async () => {
    const other = svc.taskCreate({ title: 'Onaylı', objective: 'x' });
    const job = addOtherJob(other.task_id, ['src/a.ts']);
    store.transitionJob(job.id, 'approved');
    const task = svc.taskCreate({ title: 'Yeni', objective: 'x', contextRefs: ['src/a.ts'] });
    const dispatched = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    expect(dispatched.warnings.join(' ')).toContain(other.task_id);
    svc.jobCancel(dispatched.job_id, 'test');
  });

  it('jobDispatch çakışma yoksa uyarı eklemez', async () => {
    const other = svc.taskCreate({ title: 'Öteki', objective: 'x' });
    addOtherJob(other.task_id, ['docs/a.md']);
    const task = svc.taskCreate({ title: 'Yeni', objective: 'x', contextRefs: ['src/a.ts'] });
    const dispatched = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    expect(dispatched.warnings).toEqual([]);
    svc.jobCancel(dispatched.job_id, 'test');
  });

  it('jobDispatch dosya eşleşmesinde yalnız Windows üzerinde harf duyarsızdır', async () => {
    const other = svc.taskCreate({ title: 'Öteki', objective: 'x' });
    addOtherJob(other.task_id, ['src/a.ts']);
    const task = svc.taskCreate({ title: 'Yeni', objective: 'x', contextRefs: ['SRC/a.ts'] });
    const dispatched = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    if (process.platform === 'win32')
      expect(dispatched.warnings.join(' ')).toContain(other.task_id);
    else expect(dispatched.warnings).toEqual([]);
    svc.jobCancel(dispatched.job_id, 'test');
  });

  it('jobDispatch kapalı görevlerin çakışan dosyalarını yok sayar', async () => {
    const other = svc.taskCreate({ title: 'Kapalı', objective: 'x' });
    addOtherJob(other.task_id, ['src/a.ts']);
    store.updateTask(other.task_id, { state: 'accepted' });
    const task = svc.taskCreate({ title: 'Yeni', objective: 'x', contextRefs: ['src/a.ts'] });
    const dispatched = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    expect(dispatched.warnings).toEqual([]);
    svc.jobCancel(dispatched.job_id, 'test');
  });

  it('jobDispatch glob kapsamını eşleştirir', async () => {
    const other = svc.taskCreate({ title: 'Öteki', objective: 'x' });
    addOtherJob(other.task_id, ['src/components/a.ts']);
    const globTask = svc.taskCreate({
      title: 'Glob',
      objective: 'x',
      contextRefs: ['src/**/*.ts'],
    });
    const globDispatch = await svc.jobDispatch({
      taskId: globTask.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    expect(globDispatch.warnings.join(' ')).toContain(other.task_id);
    svc.jobCancel(globDispatch.job_id, 'test');
  });

  it('jobDispatch tek yıldızlı globu dizin sınırında durdurur', async () => {
    const other = svc.taskCreate({ title: 'Derin', objective: 'x' });
    addOtherJob(other.task_id, ['src/components/a.ts']);
    const task = svc.taskCreate({ title: 'Yüzey', objective: 'x', contextRefs: ['src/*.ts'] });
    const dispatched = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    expect(dispatched.warnings).toEqual([]);
    svc.jobCancel(dispatched.job_id, 'test');
  });

  it('jobDispatch dizin önekli kapsamı eşleştirir', async () => {
    const other = svc.taskCreate({ title: 'Öteki', objective: 'x' });
    addOtherJob(other.task_id, ['src/components/a.ts']);
    const dirTask = svc.taskCreate({ title: 'Dizin', objective: 'x' });
    const dirDispatch = await svc.jobDispatch({
      taskId: dirTask.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
      inputs: { files: ['src/components'] },
    });
    expect(dirDispatch.warnings.join(' ')).toContain(other.task_id);
    svc.jobCancel(dirDispatch.job_id, 'test');
  });

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

  it('evidence_generate testleri son birleştirilmemiş worktree işinde, birleşince entegrasyon alanında çalıştırır', async () => {
    writeFileSync(join(t.dir, 'README.md'), 'init\n');
    git(t.dir, ['init', '-q', '-b', 'main']);
    git(t.dir, ['add', 'README.md']);
    git(t.dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
    const task = svc.taskCreate({ title: 'Kanıt worktree', objective: 'x' });
    const dispatched = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake-file:worktree-proof.txt]',
    });
    await finishedState(dispatched.job_id);
    const job = store.mustGetJob(dispatched.job_id);
    const cmd = `node -e "require('node:fs').writeFileSync('test-cwd.txt', process.cwd())"`;
    const ev = svc.evidenceGenerate(task.task_id, { testCommand: cmd, skipTests: false });
    expect(ev.workdir).toBe(job.workdir);
    expect(readFileSync(join(job.workdir, 'test-cwd.txt'), 'utf8')).toBe(job.workdir);
    expect(readFileSync(join(t.dir, ev.tests!.evidence), 'utf8')).toContain(
      `dizin: ${join('.anafor', 'worktrees', job.id)}`,
    );

    expect(svc.taskAccept(task.task_id, dispatched.job_id).accepted).toBe(true);
    expect(svc.taskMerge(task.task_id).merged).toBe(true);
    const mergedEvidence = svc.evidenceGenerate(task.task_id, {
      testCommand: `node -e "require('node:fs').writeFileSync('merged-cwd.txt', process.cwd())"`,
    });
    expect(mergedEvidence.workdir).not.toBe(job.workdir);
    expect(existsSync(join(mergedEvidence.workdir, 'merged-cwd.txt'))).toBe(true);
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

  it('işçi kapasitesi doluyken işi sıraya alır ve slot açılınca atomik başlatır', async () => {
    const limited = new FakeAdapter();
    limited.capabilities = () => ({ ...new FakeAdapter().capabilities(), maxConcurrency: 1 });
    const registry: AdapterRegistry = new Map([['fake', limited]]);
    const launched: string[] = [];
    const queuedSvc = new AnaforService(
      store,
      registry,
      (_store, job) => launched.push(job.id),
      'fake',
    );
    const task = queuedSvc.taskCreate({ title: 'queue', objective: 'queue' });
    const first = await queuedSvc.jobDispatch({
      taskId: task.task_id,
      role: 'analysis',
      instructions: 'x',
    });
    const second = await queuedSvc.jobDispatch({
      taskId: task.task_id,
      role: 'analysis',
      instructions: 'x',
    });
    expect(second).toMatchObject({ state: 'queued', queue_position: 1 });
    store.transitionJob(first.job_id, 'failed', { endedAt: new Date().toISOString() });
    queuedSvc.drainQueue();
    expect(store.mustGetJob(second.job_id).state).toBe('starting');
    expect(launched).toEqual([first.job_id, second.job_id]);
  });

  it('queued işler restart uzlaştırmasında korunur, kuyruk iptali ve pano sırası çalışır', async () => {
    const limited = new FakeAdapter();
    limited.capabilities = () => ({ ...new FakeAdapter().capabilities(), maxConcurrency: 1 });
    const registry: AdapterRegistry = new Map([['fake', limited]]);
    const launched: string[] = [];
    const queuedSvc = new AnaforService(
      store,
      registry,
      (_store, job) => launched.push(job.id),
      'fake',
    );
    const task = queuedSvc.taskCreate({ title: 'persist', objective: 'persist' });
    const first = await queuedSvc.jobDispatch({
      taskId: task.task_id,
      role: 'analysis',
      instructions: 'x',
    });
    const second = await queuedSvc.jobDispatch({
      taskId: task.task_id,
      role: 'analysis',
      instructions: 'x',
    });
    expect(second.state).toBe('queued');
    expect(
      jobsTable(store).some((line) => line.includes(`${second.job_id}`) && line.includes('#1')),
    ).toBe(true);
    queuedSvc.jobCancel(second.job_id, 'test');
    expect(store.mustGetJob(second.job_id).state).toBe('cancelled');
    store.transitionJob(first.job_id, 'failed', { endedAt: new Date().toISOString() });
    const next = await queuedSvc.jobDispatch({
      taskId: task.task_id,
      role: 'analysis',
      instructions: 'x',
    });
    expect(next.state).toBe('starting');
    // A fresh service instance sees durable queued rows and reconciles/drains them too.
    const persisted = store.createJob({
      taskId: task.task_id,
      role: 'analysis',
      worker: 'fake',
      workspaceMode: 'readonly',
      workdir: t.dir,
      instructions: 'persisted',
      timeoutS: 10,
    });
    store.transitionJob(next.job_id, 'failed', { endedAt: new Date().toISOString() });
    const reopened = new Store(t.dir);
    try {
      const restarted = new AnaforService(
        reopened,
        registry,
        (_store, job) => launched.push(job.id),
        'fake',
      );
      expect(restarted.reconcile()).toEqual([]);
      expect(reopened.mustGetJob(persisted.id).state).toBe('starting');
    } finally {
      reopened.close();
    }
  });

  it('kuyruk önceliği ve FIFO ile çalışır; iki eşzamanlı tüketici kapasiteyi aşmaz', async () => {
    const limited = new FakeAdapter();
    limited.capabilities = () => ({ ...new FakeAdapter().capabilities(), maxConcurrency: 1 });
    const registry: AdapterRegistry = new Map([['fake', limited]]);
    const launched: string[] = [];
    const queuedSvc = new AnaforService(
      store,
      registry,
      (_store, job) => launched.push(job.id),
      'fake',
    );
    const low = store.createTask({ title: 'low', objective: 'x', priority: 'normal' });
    const high = store.createTask({ title: 'high', objective: 'x', priority: 'critical' });
    const makeQueued = (taskId: string) =>
      store.createJob({
        taskId,
        role: 'analysis',
        worker: 'fake',
        workspaceMode: 'readonly',
        workdir: t.dir,
        instructions: 'x',
        timeoutS: 10,
      });
    const lowFirst = makeQueued(low.id);
    const lowSecond = makeQueued(low.id);
    const highFirst = makeQueued(high.id);
    const otherStore = new Store(t.dir);
    const competing = new AnaforService(
      otherStore,
      registry,
      (_store, job) => launched.push(job.id),
      'fake',
    );
    await Promise.all([
      Promise.resolve().then(() => queuedSvc.drainQueue()),
      Promise.resolve().then(() => competing.drainQueue()),
    ]);
    expect(store.listJobs({ states: ['starting'] })).toHaveLength(1);
    expect(launched).toHaveLength(1);
    expect(launched[0]).toBe(highFirst.id);
    store.transitionJob(highFirst.id, 'failed', { endedAt: new Date().toISOString() });
    queuedSvc.drainQueue();
    expect(launched[1]).toBe(lowFirst.id);
    store.transitionJob(lowFirst.id, 'failed', { endedAt: new Date().toISOString() });
    queuedSvc.drainQueue();
    expect(launched[2]).toBe(lowSecond.id);
    otherStore.close();
  });

  it.each(['[fake:ok]', '[fake:fail]'])(
    'runner sonlanınca kuyrukta sıradaki işi başlatır (%s)',
    async (scenario) => {
      const limited = new FakeAdapter();
      limited.capabilities = () => ({ ...new FakeAdapter().capabilities(), maxConcurrency: 1 });
      const registry: AdapterRegistry = new Map([['fake', limited]]);
      const queuedSvc = new AnaforService(store, registry, inProcessLauncher(registry), 'fake');
      const task = queuedSvc.taskCreate({ title: 'runner queue', objective: 'x' });
      const first = await queuedSvc.jobDispatch({
        taskId: task.task_id,
        role: 'analysis',
        instructions: scenario,
      });
      const second = await queuedSvc.jobDispatch({
        taskId: task.task_id,
        role: 'analysis',
        instructions: '[fake:ok]',
      });
      expect(second.state).toBe('queued');
      await queuedSvc.jobWait([first.job_id], 10);
      const deadline = Date.now() + 3000;
      while (store.mustGetJob(second.job_id).state === 'queued' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(store.mustGetJob(second.job_id).state).not.toBe('queued');
      await queuedSvc.jobWait([second.job_id], 10);
    },
  );

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
