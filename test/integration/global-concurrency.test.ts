import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import { acquireLease, releaseLease } from '../../src/core/leases.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

describe('global eşzamanlılık sınırı (F16)', () => {
  let t: ReturnType<typeof tempDir>;
  let store: Store;
  let home: string;
  const prevHome = process.env.ANAFOR_HOME;
  const adapters: AdapterRegistry = new Map([['fake', new FakeAdapter()]]);
  const svc = (max: number) =>
    new AnaforService(store, adapters, inProcessLauncher(adapters), 'fake', {}, 'static', max);

  beforeEach(() => {
    t = tempDir();
    store = new Store(t.dir);
    home = mkdtempSync(join(tmpdir(), 'anafor-home-'));
    process.env.ANAFOR_HOME = home;
  });
  afterEach(() => {
    store.close();
    t.cleanup();
    rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.ANAFOR_HOME;
    else process.env.ANAFOR_HOME = prevHome;
  });

  it('projede sınır kadar iş çalışınca yeni dağıtım LIMIT_REACHED', async () => {
    const s = svc(1);
    const task = s.taskCreate({ title: 'g', objective: 'x' });
    const a = await s.jobDispatch({
      taskId: task.task_id,
      role: 'analysis',
      instructions: '[fake:slow]',
      workspace: 'shared',
    });
    const task2 = s.taskCreate({ title: 'g2', objective: 'y' });
    await expect(
      s.jobDispatch({ taskId: task2.task_id, role: 'analysis', instructions: '[fake:ok]' }),
    ).rejects.toMatchObject({ code: 'LIMIT_REACHED', message: /Global/ });
    expect(s.projectStatus().parallel).toMatchObject({ project: 1, total: 1, max: 1 });
    s.jobCancel(a.job_id, 'test');
    await s.jobWait([a.job_id], 20);
  }, 30_000);

  it('diğer projelerin canlı runner kiraları sayılır', async () => {
    acquireLease('J-other', join(tmpdir(), 'baska-proje'));
    try {
      const s = svc(1);
      const task = s.taskCreate({ title: 'g', objective: 'x' });
      await expect(
        s.jobDispatch({ taskId: task.task_id, role: 'analysis', instructions: '[fake:ok]' }),
      ).rejects.toMatchObject({ code: 'LIMIT_REACHED', message: /diğer projelerde 1/ });
      expect(svc(2).parallelUsage()).toMatchObject({ project: 0, other_projects: 1 });
    } finally {
      releaseLease('J-other');
    }
  });
});
