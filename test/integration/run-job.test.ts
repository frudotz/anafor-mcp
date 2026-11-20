import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import type { WorkerAdapter } from '../../src/adapters/types.js';
import { readCosts } from '../../src/capacity/capacity.js';
import { rateLimitedUntil, readStoredLimits, recordLimits } from '../../src/limits/limits.js';
import { runJob } from '../../src/runner/run-job.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

describe('runJob (sahte işçi)', () => {
  let t: ReturnType<typeof tempDir>;
  let store: Store;
  const adapters: AdapterRegistry = new Map([['fake', new FakeAdapter()]]);

  beforeEach(() => {
    t = tempDir();
    store = new Store(t.dir);
  });
  afterEach(() => {
    store.close();
    t.cleanup();
  });

  const dispatch = (
    instructions: string,
    opts: { timeoutS?: number; sessionRef?: string; explicitWorker?: boolean } = {},
  ) => {
    const task = store.createTask({ title: 'Deneme', objective: 'Dosya oluştur' });
    store.updateTask(task.id, { state: 'in_progress' });
    return store.createJob({
      taskId: task.id,
      role: 'implementation',
      worker: 'fake',
      workspaceMode: 'shared',
      workdir: t.dir,
      instructions,
      inputs: { explicitWorker: opts.explicitWorker ?? false },
      timeoutS: opts.timeoutS ?? 30,
      sessionRef: opts.sessionRef ?? null,
    });
  };

  it('lat.md varsa iş emrine proje hafızası eklenir (F17); kapatılabilir', async () => {
    mkdirSync(join(t.dir, 'lat.md'));
    writeFileSync(
      join(t.dir, 'lat.md', 'a.md'),
      '# Proje\n\n## Dosya oluşturma\n\nKural: UTF-8.\n',
    );
    const job = dispatch('[fake:ok] dosya oluştur');
    await runJob(store, job.id, adapters);
    const prompt = readFileSync(join(store.paths.jobDir(job.id), 'prompt.md'), 'utf8');
    expect(prompt).toMatch(/## Proje hafızası \(Lat\.md, (lat-cli|builtin)\)/);
    expect(store.listEvents(job.id).some((e) => e.type === 'memory')).toBe(true);

    writeFileSync(join(t.dir, 'anafor.config.json'), JSON.stringify({ memory_context: false }));
    const job2 = dispatch('[fake:ok] dosya oluştur');
    await runJob(store, job2.id, adapters);
    expect(readFileSync(join(store.paths.jobDir(job2.id), 'prompt.md'), 'utf8')).not.toMatch(
      /Proje hafızası/,
    );
  });
  it('kapasite (F20): tek başına çalışan işin pencere farkı maliyet olarak öğrenilir', async () => {
    const resets = Math.floor(Date.now() / 1000) + 3600;
    const w = (used: number) => [
      { name: 'five_hour', used_percent: used, resets_at: resets, window_minutes: 300 },
    ];
    recordLimits({
      worker: 'fake',
      source: 'test',
      observed_at: new Date(Date.now() - 1000).toISOString(),
      status: 'ok',
      windows: w(20),
    });
    class Metered extends FakeAdapter {
      override start(...a: Parameters<FakeAdapter['start']>) {
        recordLimits({
          worker: 'fake',
          source: 'test',
          observed_at: new Date(Date.now() + 5).toISOString(),
          status: 'ok',
          windows: w(23.5),
        });
        return super.start(...a);
      }
    }
    const job = dispatch('[fake:ok] dosya oluştur');
    await runJob(store, job.id, new Map([['fake', new Metered()]]));
    expect(readCosts().fake?.implementation?.five_hour?.samples).toEqual([3.5]);
    expect(store.listEvents(job.id).find((e) => e.type === 'capacity')?.summary).toBe(
      'five_hour +3.5 KP',
    );
  });

  it('başarılı iş: needs_review, sonuç, oturum, olaylar, artefaktlar', async () => {
    const job = dispatch('[fake:ok] dosyayı oluştur');
    const done = await runJob(store, job.id, adapters);
    expect(done.state).toBe('needs_review');
    expect(done.result?.changed_files).toEqual(['FAKE_OUTPUT.txt']);
    expect(done.sessionRef).toBeTruthy();
    expect(done.usage?.inputTokens).toBe(100);
    expect(existsSync(join(t.dir, 'FAKE_OUTPUT.txt'))).toBe(true);
    const dir = store.paths.jobDir(job.id);
    expect(readFileSync(join(dir, 'prompt.md'), 'utf8')).toContain(`job_id: ${job.id}`);
    expect(existsSync(join(dir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(dir, 'result.json'))).toBe(true);
    expect(store.getSession(job.taskId, 'implementation', 'fake')).toBe(done.sessionRef);
    expect(store.listEvents(job.id).map((e) => e.type)).toContain('file_change');
    expect(store.getTask(job.taskId)?.state).toBe('in_review');
  });

  it('işçi hatası: failed + hata mesajı', async () => {
    const done = await runJob(store, dispatch('[fake:fail]').id, adapters);
    expect(done.state).toBe('failed');
    expect(done.error).toContain('sahte hata');
  });

  it('rate limit hatasında tek ardıl işçiye devreder; açık worker devredilmez', async () => {
    writeFileSync(
      join(t.dir, 'anafor.config.json'),
      JSON.stringify({ routing: { implementation: ['fake', 'other'] } }),
    );
    const other = new FakeAdapter();
    const registry: AdapterRegistry = new Map<string, WorkerAdapter>([
      ['fake', new FakeAdapter()],
      [
        'other',
        {
          ...other,
          id: 'other',
          start: (spec, ctx) =>
            other.start(
              { ...spec, prompt: spec.prompt.replace('[fake:rate-limited]', '[fake:ok]') },
              ctx,
            ),
          detect: () => other.detect(),
          capabilities: () => other.capabilities(),
        },
      ],
    ]);
    const job = dispatch('[fake:rate-limited] do it');
    const env = { ...process.env, ANAFOR_HOME: join(t.dir, 'rate-cache') };
    const done = await runJob(store, job.id, registry, { env });
    expect(done.state).toBe('failed_over');
    const jobs = store.listJobs({ taskId: job.taskId });
    expect(jobs).toHaveLength(2);
    expect(jobs[1]?.worker).toBe('other');
    expect(store.listEvents(job.id).some((e) => e.type === 'failover')).toBe(true);
    expect(readStoredLimits(env)).toEqual({});
    expect(rateLimitedUntil('fake', env)).not.toBeNull();

    const explicit = dispatch('[fake:rate-limited] do it', { explicitWorker: true });
    const noTransfer = await runJob(store, explicit.id, registry);
    expect(noTransfer.state).toBe('failed');
    expect(store.listJobs({ taskId: explicit.taskId })).toHaveLength(1);
    expect(store.listEvents(explicit.id).some((e) => e.type === 'failover')).toBe(true);
  });

  it('başarılı işçinin JSON mesajındaki rate-limit sözü failover başlatmaz', async () => {
    const base = new FakeAdapter();
    const adapter: WorkerAdapter = {
      id: 'fake',
      detect: () => base.detect(),
      capabilities: () => base.capabilities(),
      start: (spec, ctx) => {
        const handle = base.start(spec, ctx);
        return {
          ...handle,
          done: handle.done.then((outcome) => ({
            ...outcome,
            finalMessage: JSON.stringify({
              ...JSON.parse(outcome.finalMessage ?? '{}'),
              summary: 'ordinary completion mentioning rate limit',
            }),
          })),
        };
      },
    };
    const job = dispatch('[fake:ok]');
    const done = await runJob(store, job.id, new Map([['fake', adapter]]));
    expect(done.state).toBe('needs_review');
    expect(store.listJobs({ taskId: job.taskId })).toHaveLength(1);
  });

  it('exit 0 fatal ama limit olmayan hata eski gibi çıktı doğrulamasına gider', async () => {
    const base = new FakeAdapter();
    const adapter: WorkerAdapter = {
      id: 'fake',
      detect: () => base.detect(),
      capabilities: () => base.capabilities(),
      start: (spec, ctx) => {
        const handle = base.start(spec, ctx);
        return {
          ...handle,
          events: (async function* () {
            for await (const event of handle.events) yield event;
            yield { type: 'error' as const, message: 'ordinary fatal error', fatal: true };
          })(),
        };
      },
    };
    const job = dispatch('[fake:ok]');
    const done = await runJob(store, job.id, new Map([['fake', adapter]]));
    expect(done.state).toBe('needs_review');
  });

  it('rate reset için dolu pencerelerin en geç sıfırlanma zamanını kaydeder', async () => {
    writeFileSync(
      join(t.dir, 'anafor.config.json'),
      JSON.stringify({ routing: { implementation: ['fake'] }, default_worker: 'fake' }),
    );
    const base = new FakeAdapter();
    const short = Math.floor(Date.now() / 1000) + 60;
    const long = short + 3600;
    const adapter: WorkerAdapter = {
      id: 'fake',
      detect: () => base.detect(),
      capabilities: () => base.capabilities(),
      start: (spec, ctx) => {
        const handle = base.start(spec, ctx);
        return {
          ...handle,
          events: (async function* () {
            yield {
              type: 'limits' as const,
              windows: [
                { name: 'five_hour', used_percent: 100, resets_at: short, window_minutes: 300 },
                { name: 'seven_day', used_percent: 100, resets_at: long, window_minutes: 10080 },
              ],
            };
            for await (const event of handle.events) yield event;
          })(),
        };
      },
    };
    const env = { ...process.env, ANAFOR_HOME: join(t.dir, 'reset-cache') };
    const job = dispatch('[fake:rate-limited]');
    const done = await runJob(store, job.id, new Map([['fake', adapter]]), { env });
    expect(done.state).toBe('failed');
    expect(rateLimitedUntil('fake', env)).toBe(long);
  });

  it('failover continuation aynı worktree setup komutunu yeniden çalıştırmaz', async () => {
    writeFileSync(
      join(t.dir, 'anafor.config.json'),
      JSON.stringify({
        routing: { implementation: ['fake', 'other'] },
        worktree_setup: `node -e "require('fs').appendFileSync('setup-count', 'x')"`,
      }),
    );
    const base = new FakeAdapter();
    const other: WorkerAdapter = {
      id: 'other',
      detect: () => base.detect(),
      capabilities: () => base.capabilities(),
      start: (spec, ctx) =>
        base.start(
          { ...spec, prompt: spec.prompt.replace('[fake:rate-limited]', '[fake:ok]') },
          ctx,
        ),
    };
    const registry: AdapterRegistry = new Map([
      ['fake', base],
      ['other', other],
    ]);
    const task = store.createTask({ title: 'Setup', objective: 'Devir' });
    store.updateTask(task.id, { state: 'in_progress' });
    const job = store.createJob({
      taskId: task.id,
      role: 'implementation',
      worker: 'fake',
      workspaceMode: 'worktree',
      workdir: t.dir,
      instructions: '[fake:rate-limited]',
      timeoutS: 30,
    });
    const result = await runJob(store, job.id, registry);
    expect(result.state).toBe('failed_over');
    expect(readFileSync(join(t.dir, 'setup-count'), 'utf8')).toBe('x');
  });

  it('eşzamanlı limit hatalarında görev başına tek failover işi açar', async () => {
    writeFileSync(
      join(t.dir, 'anafor.config.json'),
      JSON.stringify({ routing: { implementation: ['fake', 'other'] } }),
    );
    const base = new FakeAdapter();
    const other: WorkerAdapter = {
      id: 'other',
      detect: () => base.detect(),
      capabilities: () => base.capabilities(),
      start: (spec, ctx) =>
        base.start(
          { ...spec, prompt: spec.prompt.replace('[fake:rate-limited]', '[fake:ok]') },
          ctx,
        ),
    };
    const registry: AdapterRegistry = new Map([
      ['fake', base],
      ['other', other],
    ]);
    const first = dispatch('[fake:rate-limited]');
    const second = store.createJob({
      taskId: first.taskId,
      role: 'implementation',
      worker: 'fake',
      workspaceMode: 'shared',
      workdir: t.dir,
      instructions: '[fake:rate-limited]',
      timeoutS: 30,
      inputs: { explicitWorker: false },
    });
    await Promise.all([runJob(store, first.id, registry), runJob(store, second.id, registry)]);
    const jobs = store.listJobs({ taskId: first.taskId });
    expect(jobs.filter((j) => j.state === 'failed_over')).toHaveLength(1);
    expect(jobs.filter((j) => j.worker === 'other')).toHaveLength(1);
  });

  it('review failover hedef işi yapan Claude ailesini dışlar', async () => {
    writeFileSync(
      join(t.dir, 'anafor.config.json'),
      JSON.stringify({ routing: { review: ['fake', 'cirak', 'codex'] } }),
    );
    const base = new FakeAdapter();
    const converts = (id: string): WorkerAdapter => ({
      id,
      detect: () => base.detect(),
      capabilities: () => base.capabilities(),
      start: (spec, ctx) =>
        base.start(
          { ...spec, prompt: spec.prompt.replace('[fake:rate-limited]', '[fake:ok]') },
          ctx,
        ),
    });
    const registry: AdapterRegistry = new Map([
      ['fake', base],
      ['cirak', converts('cirak')],
      ['codex', converts('codex')],
    ]);
    const task = store.createTask({ title: 'Review', objective: 'İncele' });
    store.updateTask(task.id, { state: 'in_progress' });
    const job = store.createJob({
      taskId: task.id,
      role: 'review',
      worker: 'fake',
      workspaceMode: 'readonly',
      workdir: t.dir,
      instructions: '[fake:rate-limited]',
      timeoutS: 30,
      inputs: { reviewContext: { diffSummary: 'target change', targetWorker: 'cirak' } },
    });
    const failed = await runJob(store, job.id, registry);
    expect(failed.state).toBe('failed_over');
    expect(store.listJobs({ taskId: task.id }).map((j) => j.worker)).toEqual(['fake', 'codex']);
  });

  it('JSON vermeyen işçi: invalid_output', async () => {
    const done = await runJob(store, dispatch('[fake:invalid]').id, adapters);
    expect(done.state).toBe('invalid_output');
  });

  it('kimlik uyduran işçi: invalid_output', async () => {
    const done = await runJob(store, dispatch('[fake:wrong-id]').id, adapters);
    expect(done.state).toBe('invalid_output');
    expect(done.error).toContain('job_id');
  });

  // İşçi sandbox'ında süreç ağacı sonlandırma, vitest'in 30 sn test sınırını aşabiliyor;
  // CI ve yerel çalıştırmalarda timeout davranışı doğrulanmaya devam eder.
  it.skipIf(process.env.ANAFOR_WORKER === '1')(
    'zaman aşımı: timed_out ve süreç öldürülür',
    async () => {
      const started = Date.now();
      const done = await runJob(store, dispatch('[fake:slow]', { timeoutS: 2 }).id, adapters);
      expect(done.state).toBe('timed_out');
      expect(Date.now() - started).toBeLessThan(20_000);
    },
  );

  it('oturum devamı: resume aynı oturumu kullanır', async () => {
    const done = await runJob(
      store,
      dispatch('[fake:ok]', { sessionRef: 'S-önceki' }).id,
      adapters,
    );
    expect(done.state).toBe('needs_review');
    expect(done.sessionRef).toBe('S-önceki');
  });

  it('bilinmeyen işçi: failed', async () => {
    const task = store.createTask({ title: 'x', objective: 'y' });
    const job = store.createJob({
      taskId: task.id,
      role: 'analysis',
      worker: 'yok',
      workspaceMode: 'readonly',
      workdir: t.dir,
      instructions: 'z',
      timeoutS: 5,
    });
    const done = await runJob(store, job.id, adapters);
    expect(done.state).toBe('failed');
  });

  it('iptal edilmiş iş başlatılmaz', async () => {
    const job = dispatch('[fake:ok]');
    store.transitionJob(job.id, 'cancelled');
    const done = await runJob(store, job.id, adapters);
    expect(done.state).toBe('cancelled');
    expect(existsSync(join(t.dir, 'FAKE_OUTPUT.txt'))).toBe(false);
  });
});
