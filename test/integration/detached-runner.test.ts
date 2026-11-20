import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
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

  it.skipIf(!existsSync(runnerScriptPath()))(
    'config bozuk olsa da runner lease ve store temizliğini yapar',
    () => {
      const task = store.createTask({ title: 'bad config', objective: 'x' });
      const job = store.createJob({
        taskId: task.id,
        role: 'analysis',
        worker: 'fake',
        workspaceMode: 'readonly',
        workdir: t.dir,
        instructions: 'x',
        timeoutS: 10,
      });
      writeFileSync(
        join(t.dir, 'anafor.config.json'),
        JSON.stringify({ workers: { codex: { user_config: 'invalid' } } }),
      );
      const home = join(t.dir, 'isolated-home');
      mkdirSync(home, { recursive: true });
      const result = spawn(process.execPath, [runnerScriptPath(), t.dir, job.id], {
        env: { ...process.env, ANAFOR_HOME: home },
        stdio: 'ignore',
      });
      return new Promise<void>((resolvePromise, reject) => {
        result.once('error', reject);
        result.once('exit', (code) => {
          try {
            expect(code).not.toBe(0);
            expect(existsSync(join(home, 'running', `${job.id}.json`))).toBe(false);
            resolvePromise();
          } catch (error) {
            reject(error);
          }
        });
      });
    },
  );

  it.skipIf(!existsSync(runnerScriptPath()))(
    'iki Node süreci aynı anda drain etse de worker ve global sınırlar aşılmaz',
    async () => {
      writeFileSync(
        join(t.dir, 'anafor.config.json'),
        JSON.stringify({ workers: { codex: { max_concurrency: 1 } }, max_parallel_jobs: 1 }),
      );
      const task = store.createTask({ title: 'race', objective: 'x' });
      for (let i = 0; i < 2; i++)
        store.createJob({
          taskId: task.id,
          role: 'analysis',
          worker: 'codex',
          workspaceMode: 'readonly',
          workdir: t.dir,
          instructions: 'x',
          timeoutS: 10,
        });
      const modules = [
        'store/store.js',
        'core/config.js',
        'adapters/registry.js',
        'server/service.js',
      ].map((file) => pathToFileURL(resolve('dist', file)).href);
      const script = `const [s,c,a,v]=await Promise.all(${JSON.stringify(modules)}.map(x=>import(x)));const root=process.argv[1];const db=new s.Store(root);try{const cfg=c.loadConfig(root);const svc=new v.AnaforService(db,a.defaultAdapters(cfg),()=>{},cfg.default_worker,cfg.routing,cfg.routing_mode,cfg.max_parallel_jobs);svc.drainQueue()}finally{db.close()}`;
      const runDrain = () =>
        new Promise<void>((resolvePromise, reject) => {
          const child = spawn(process.execPath, ['-e', script, t.dir], { stdio: 'ignore' });
          child.once('error', reject);
          child.once('exit', (code) =>
            code === 0 ? resolvePromise() : reject(new Error(`drain exit ${code}`)),
          );
        });
      await Promise.all([runDrain(), runDrain()]);
      expect(store.listJobs({ states: ['starting'] })).toHaveLength(1);
      expect(store.listJobs({ states: ['queued'] })).toHaveLength(1);
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
