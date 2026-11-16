import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canTransitionJob, isTerminalJobState, jobSourcesFor } from '../../src/core/states.js';
import { Store, StoreError } from '../../src/store/store.js';
import { sampleResult, tempDir } from '../helpers.js';

describe('durum makinesi', () => {
  it('izinli ve izinsiz geçişler', () => {
    expect(canTransitionJob('queued', 'starting')).toBe(true);
    expect(canTransitionJob('running', 'validating')).toBe(true);
    expect(canTransitionJob('needs_review', 'approved')).toBe(true);
    expect(canTransitionJob('queued', 'needs_review')).toBe(false);
    expect(canTransitionJob('failed', 'running')).toBe(false);
  });
  it('terminal durumlar', () => {
    expect(isTerminalJobState('merged')).toBe(true);
    expect(isTerminalJobState('running')).toBe(false);
  });
  it('kaynak hesaplama', () => {
    expect(jobSourcesFor('cancelled').sort()).toEqual(['queued', 'running', 'starting']);
  });
});

describe('Store', () => {
  let t: ReturnType<typeof tempDir>;
  let store: Store;

  beforeEach(() => {
    t = tempDir();
    store = new Store(t.dir);
  });
  afterEach(() => {
    store.close();
    t.cleanup();
  });

  const mkTask = () =>
    store.createTask({ title: 'Başlık', objective: 'Hedef', acceptanceCriteria: ['k1', 'k2'] });
  const mkJob = (taskId: string) =>
    store.createJob({
      taskId,
      role: 'implementation',
      worker: 'fake',
      workspaceMode: 'shared',
      workdir: t.dir,
      instructions: 'yap',
      timeoutS: 60,
    });

  it('görev oluşturur ve okur', () => {
    const task = mkTask();
    expect(task.state).toBe('open');
    expect(task.acceptanceCriteria).toEqual(['k1', 'k2']);
    expect(store.listTasks()).toHaveLength(1);
    store.updateTask(task.id, { state: 'accepted' });
    expect(store.listTasks()).toHaveLength(0);
    expect(store.listTasks({ includeClosed: true })).toHaveLength(1);
  });

  it('iş yaşam döngüsü: queued → … → needs_review', () => {
    const task = mkTask();
    const job = mkJob(task.id);
    expect(job.state).toBe('queued');
    store.transitionJob(job.id, 'starting');
    store.transitionJob(job.id, 'running', { pid: 123, startedAt: new Date().toISOString() });
    store.transitionJob(job.id, 'validating', { exitCode: 0 });
    const done = store.transitionJob(job.id, 'needs_review', {
      result: sampleResult(),
      warnings: ['w'],
      usage: { inputTokens: 10 },
    });
    expect(done.result?.summary).toBe('tamam');
    expect(done.warnings).toEqual(['w']);
    expect(done.usage?.inputTokens).toBe(10);
    expect(done.pid).toBe(123);
  });

  it('geçersiz geçiş INVALID_STATE fırlatır', () => {
    const job = mkJob(mkTask().id);
    expect(() => store.transitionJob(job.id, 'needs_review')).toThrowError(StoreError);
    try {
      store.transitionJob(job.id, 'merged');
    } catch (e) {
      expect((e as StoreError).code).toBe('INVALID_STATE');
    }
  });

  it('ikinci yarış geçişi reddedilir', () => {
    const job = mkJob(mkTask().id);
    store.transitionJob(job.id, 'cancelled');
    expect(() => store.transitionJob(job.id, 'starting')).toThrow(/geçersiz/);
  });

  it('oturum eşlemesi görev+rol+işçi anahtarlı', () => {
    const task = mkTask();
    expect(store.getSession(task.id, 'implementation', 'codex')).toBeNull();
    store.saveSession(task.id, 'implementation', 'codex', 'S1', 'J1');
    store.saveSession(task.id, 'implementation', 'codex', 'S2', 'J2');
    expect(store.getSession(task.id, 'implementation', 'codex')).toBe('S2');
    expect(store.getSession(task.id, 'review', 'codex')).toBeNull();
  });

  it('olaylar sıralı', () => {
    const job = mkJob(mkTask().id);
    store.appendEvent(job.id, 'message', 'a');
    store.appendEvent(job.id, 'command', 'b');
    const evs = store.listEvents(job.id);
    expect(evs.map((e) => e.seq)).toEqual([1, 2]);
    expect(store.listEvents(job.id, 1)).toHaveLength(1);
  });

  it('veritabanı yeniden açılınca durum korunur', () => {
    const task = mkTask();
    store.close();
    store = new Store(t.dir);
    expect(store.getTask(task.id)?.title).toBe('Başlık');
  });
});
