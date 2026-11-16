import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import type { WorkerAdapter } from '../../src/adapters/types.js';
import { DEFAULT_CONFIG } from '../../src/core/config.js';
import { runPreToolUse } from '../../src/hooks/director.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

/** Sahte işçiyi başka bir kimlikle sunar (router testleri için). */
function as(
  id: string,
  opts: { available?: boolean; maxConcurrency?: number } = {},
): WorkerAdapter {
  const base = new FakeAdapter();
  return {
    id,
    detect: async () =>
      opts.available === false
        ? { available: false, reason: `${id} kapalı` }
        : { available: true, authOk: true },
    capabilities: () => ({ ...base.capabilities(), maxConcurrency: opts.maxConcurrency ?? 4 }),
    start: (j, c) => base.start(j, c),
    resume: (j, c) => base.resume(j, c),
  };
}

describe('router', () => {
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

  const svcWith = (list: WorkerAdapter[], routing = DEFAULT_CONFIG.routing, def = 'w1') => {
    const adapters: AdapterRegistry = new Map(list.map((a) => [a.id, a]));
    return new AnaforService(store, adapters, inProcessLauncher(adapters), def, routing);
  };

  it('rol için tercih sırasındaki ilk uygun işçi seçilir', async () => {
    const svc = svcWith([as('w1'), as('w2')], { implementation: ['w2', 'w1'] });
    expect(await svc.route('implementation', null)).toBe('w2');
  });

  it('kullanılamayan işçi atlanır', async () => {
    const svc = svcWith([as('w1'), as('w2', { available: false })], {
      implementation: ['w2', 'w1'],
    });
    expect(await svc.route('implementation', null)).toBe('w1');
  });

  it('kapasitesi dolu işçi atlanır', async () => {
    const svc = svcWith([as('w1', { maxConcurrency: 1 }), as('w2')], {
      implementation: ['w1', 'w2'],
      analysis: ['w1', 'w2'],
    });
    const task = svc.taskCreate({ title: 't', objective: 'o' });
    const a = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    expect(a.worker).toBe('w1');
    const task2 = svc.taskCreate({ title: 't2', objective: 'o' });
    const b = await svc.jobDispatch({
      taskId: task2.task_id,
      role: 'analysis',
      instructions: '[fake:ok]',
    });
    expect(b.worker).toBe('w2');
    svc.jobCancel(a.job_id, 'son');
    await svc.jobWait([b.job_id], 30);
  });

  it('review: hedef işi yapan işçiden farklı işçi tercih edilir (çapraz model)', async () => {
    const svc = svcWith([as('w1'), as('w2')], { implementation: ['w1'], review: ['w1', 'w2'] });
    const task = svc.taskCreate({ title: 't', objective: 'o' });
    const impl = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:ok]',
    });
    await svc.jobWait([impl.job_id], 30);
    const rev = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'review',
      instructions: '[fake:ok]',
      targetJobId: impl.job_id,
    });
    expect(impl.worker).toBe('w1');
    expect(rev.worker).toBe('w2');
    await svc.jobWait([rev.job_id], 30);
  });

  it('açık işçi seçimi router’ı ezer; uygun işçi yoksa WORKER_UNAVAILABLE', async () => {
    const svc = svcWith([as('w1', { available: false })], { implementation: ['w1'] });
    await expect(svc.route('implementation', null)).rejects.toMatchObject({
      code: 'WORKER_UNAVAILABLE',
    });
  });
});

describe('işçi süreci hook muafiyeti', () => {
  it('ANAFOR_WORKER=1 iken yönetici kuralı uygulanmaz', () => {
    const t = tempDir();
    try {
      store_init(t.dir);
      const input = { cwd: t.dir, tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } };
      expect(runPreToolUse(input, {})).not.toBe('');
      expect(runPreToolUse(input, { ANAFOR_WORKER: '1' })).toBe('');
    } finally {
      t.cleanup();
    }
  });
});

function store_init(dir: string): void {
  new Store(dir).close();
}
