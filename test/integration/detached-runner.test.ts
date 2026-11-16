import { existsSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { isTerminalJobState } from '../../src/core/states.js';
import { runJob } from '../../src/runner/run-job.js';
import { runnerScriptPath, spawnDetachedRunner } from '../../src/runner/spawn.js';
import { Store, type Job } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

async function waitTerminal(store: Store, jobId: string, timeoutMs: number): Promise<Job> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const j = store.mustGetJob(jobId);
    if (isTerminalJobState(j.state) || j.state === 'needs_review') return j;
    if (Date.now() > end) throw new Error(`zaman aşımı, durum: ${j.state}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

describe('ayrık runner süreci', () => {
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

  it.skipIf(!existsSync(runnerScriptPath()))(
    'işi ayrı süreçte tamamlar ve durumu ortak veritabanına yazar',
    async () => {
      const task = store.createTask({ title: 'ayrık', objective: 'dosya' });
      const job = store.createJob({
        taskId: task.id,
        role: 'implementation',
        worker: 'fake',
        workspaceMode: 'shared',
        workdir: t.dir,
        instructions: '[fake:ok]',
        timeoutS: 30,
      });
      const pid = spawnDetachedRunner(t.dir, job.id, store.paths.jobDir(job.id));
      expect(pid).toBeGreaterThan(0);
      const done = await waitTerminal(store, job.id, 30_000);
      expect(done.state).toBe('needs_review');
    },
  );
});

// Gerçek Codex: yalnızca ANAFOR_E2E_CODEX=1 iken (yerelde, oturum açık Codex ile).
describe.skipIf(process.env.ANAFOR_E2E_CODEX !== '1')('Codex uçtan uca', () => {
  it('gerçek Codex işi doğrulanmış sonuç döner', async () => {
    const t = tempDir();
    const store = new Store(t.dir);
    try {
      const task = store.createTask({
        title: 'Toplama fonksiyonu',
        objective: 'math.mjs dosyasında add(a,b) fonksiyonunu dışa aktar.',
        acceptanceCriteria: ['add(2,3) === 5'],
      });
      const job = store.createJob({
        taskId: task.id,
        role: 'implementation',
        worker: 'codex',
        workspaceMode: 'shared',
        workdir: t.dir,
        instructions:
          'math.mjs oluştur; `node -e "import(\'./math.mjs\').then(m=>process.exit(m.add(2,3)===5?0:1))"` ile doğrula.',
        timeoutS: 600,
      });
      const done = await runJob(store, job.id, new Map([['codex', new CodexAdapter()]]));
      expect(done.error).toBeNull();
      expect(done.state).toBe('needs_review');
      expect(done.result?.status).toBe('completed');
      expect(done.usage?.inputTokens).toBeGreaterThan(0);
    } finally {
      store.close();
      t.cleanup();
    }
  }, 700_000);
});
