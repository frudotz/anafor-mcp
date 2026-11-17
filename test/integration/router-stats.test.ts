import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import type { WorkerAdapter } from '../../src/adapters/types.js';
import { AnaforService } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

function as(id: string): WorkerAdapter {
  const base = new FakeAdapter();
  return {
    id,
    detect: async () => ({ available: true, authOk: true }),
    capabilities: () => base.capabilities(),
    start: (j, c) => base.start(j, c),
    resume: (j, c) => base.resume(j, c),
  };
}

describe('işçi istatistikleri ve uyarlamalı yönlendirme', () => {
  let t: ReturnType<typeof tempDir>;
  let store: Store;
  let adapters: AdapterRegistry;
  beforeEach(() => {
    t = tempDir();
    store = new Store(t.dir);
    adapters = new Map([as('w1'), as('w2'), as('w3')].map((a) => [a.id, a]));
  });
  afterEach(() => {
    store.close();
    t.cleanup();
  });
  const svc = (mode: 'static' | 'adaptive' = 'static') =>
    new AnaforService(
      store,
      adapters,
      undefined,
      'w1',
      { implementation: ['w1', 'w2', 'w3'] },
      mode,
    );
  const orderedSvc = (mode: 'static' | 'adaptive') =>
    new AnaforService(
      store,
      adapters,
      undefined,
      'w1',
      { implementation: ['w1', 'w3', 'w2'] },
      mode,
    );
  function add(
    worker: string,
    state: 'approved' | 'merged' | 'failed' | 'timed_out' | 'invalid_output' | 'changes_requested',
    role: 'implementation' | 'review' = 'implementation',
    usage?: { inputTokens?: number; outputTokens?: number },
  ) {
    const task = store.createTask({ title: 't', objective: 'o' });
    const j = store.createJob({
      taskId: task.id,
      role,
      worker,
      workspaceMode: 'shared',
      workdir: t.dir,
      instructions: 'x',
      timeoutS: 1,
    });
    store.transitionJob(j.id, 'starting');
    store.transitionJob(j.id, 'running', { startedAt: '2026-01-01T00:00:00Z' });
    if (state === 'failed' || state === 'timed_out') {
      store.transitionJob(j.id, state, {
        startedAt: '2026-01-01T00:00:00Z',
        endedAt: '2026-01-01T00:00:10Z',
        usage: usage ?? null,
      });
      return;
    }
    store.transitionJob(j.id, 'validating');
    store.transitionJob(j.id, 'needs_review');
    store.transitionJob(j.id, state, {
      startedAt: '2026-01-01T00:00:00Z',
      endedAt: '2026-01-01T00:00:10Z',
      usage: usage ?? null,
    });
  }
  it('biten işleri sayar, ortalamaları hesaplar, directorü dışlar ve rol filtresini uygular', () => {
    add('w1', 'approved', 'implementation', { inputTokens: 20, outputTokens: 10 });
    add('w1', 'changes_requested');
    add('w1', 'timed_out');
    add('director', 'approved');
    add('w1', 'approved', 'review');
    const stats = svc().workerStats('implementation');
    expect(stats).toEqual([
      {
        worker: 'w1',
        role: 'implementation',
        finished: 3,
        accepted: 1,
        failed: 1,
        changes_requested: 1,
        acceptance_rate: 1 / 3,
        avg_duration_s: 10,
        avg_input_tokens: 20,
        avg_output_tokens: 10,
      },
    ]);
  });
  it('uyarlamalı mod en az üç işi olanları sıralar; az işi olanları ve statik sırayı korur', async () => {
    for (let i = 0; i < 3; i++) add('w2', 'approved');
    for (let i = 0; i < 3; i++) add('w1', 'failed');
    for (let i = 0; i < 2; i++) add('w3', 'approved');
    expect(await orderedSvc('adaptive').route('implementation', null)).toBe('w2');
    (adapters as Map<string, WorkerAdapter>).set('w2', {
      ...as('w2'),
      detect: async () => ({ available: false }),
    });
    expect(await orderedSvc('adaptive').route('implementation', null)).toBe('w3');
    expect(await svc('static').route('implementation', null)).toBe('w1');
  });
});
