import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
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
    opts: { timeoutS?: number; sessionRef?: string } = {},
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

  it('JSON vermeyen işçi: invalid_output', async () => {
    const done = await runJob(store, dispatch('[fake:invalid]').id, adapters);
    expect(done.state).toBe('invalid_output');
  });

  it('kimlik uyduran işçi: invalid_output', async () => {
    const done = await runJob(store, dispatch('[fake:wrong-id]').id, adapters);
    expect(done.state).toBe('invalid_output');
    expect(done.error).toContain('job_id');
  });

  it('zaman aşımı: timed_out ve süreç öldürülür', async () => {
    const started = Date.now();
    const done = await runJob(store, dispatch('[fake:slow]', { timeoutS: 2 }).id, adapters);
    expect(done.state).toBe('timed_out');
    expect(Date.now() - started).toBeLessThan(20_000);
  });

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
