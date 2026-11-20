import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import { git } from '../../src/git/git.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

function initRepo(dir: string): void {
  git(dir, ['init', '-q']);
  writeFileSync(join(dir, 'README.md'), '# t\n');
  writeFileSync(join(dir, '.gitignore'), '.anafor/\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
  writeFileSync(
    join(dir, 'anafor.config.json'),
    JSON.stringify({ review: { require_for: 'none' } }),
  );
}

describe('job_diff ve task_accept', () => {
  let t: ReturnType<typeof tempDir>;
  let store: Store;
  let svc: AnaforService;
  const adapters: AdapterRegistry = new Map([
    ['fake', new FakeAdapter()],
    ['codex', new FakeAdapter()],
  ]);

  beforeEach(() => {
    t = tempDir();
    initRepo(t.dir);
    store = new Store(t.dir);
    svc = new AnaforService(store, adapters, inProcessLauncher(adapters), 'fake');
  });
  afterEach(() => {
    store.close();
    t.cleanup();
  });

  const run = async (taskId: string, role: 'implementation' | 'review', extra = {}) => {
    const d = await svc.jobDispatch({ taskId, role, instructions: '[fake:ok]', ...extra });
    const w = await svc.jobWait([d.job_id], 30);
    expect(w.finished[0]?.state).toBe('needs_review');
    return d.job_id;
  };

  it('job_diff: taban HEAD, yeni dosya görünür, raporla uyumlu', async () => {
    const task = svc.taskCreate({ title: 'd', objective: 'x' });
    const jobId = await run(task.task_id, 'implementation');
    expect(store.mustGetJob(jobId).baseSha).toMatch(/^[0-9a-f]{40}$/);
    const diff = svc.jobDiff(jobId);
    expect(diff.changed_files).toContain('FAKE_OUTPUT.txt');
    expect(diff.mismatch.changed_but_not_reported).toEqual([]);
    expect(diff.mismatch.reported_but_unchanged).toEqual([]);
  });

  it('job_diff: izlenen dosya değişikliği patch içinde', async () => {
    const task = svc.taskCreate({ title: 'd2', objective: 'x' });
    const jobId = await run(task.task_id, 'implementation');
    writeFileSync(join(store.mustGetJob(jobId).workdir, 'README.md'), '# değişti\n');
    const diff = svc.jobDiff(jobId);
    expect(diff.patch).toContain('değişti');
    expect(diff.mismatch.changed_but_not_reported).toContain('README.md');
  });

  it('review diff hedef çalışma alanını gösterir ve mismatch üretmez', async () => {
    const task = svc.taskCreate({ title: 'salt okunur', objective: 'x' });
    const impl = await run(task.task_id, 'implementation');
    const review = await run(task.task_id, 'review', { targetJobId: impl });
    writeFileSync(join(store.mustGetJob(impl).workdir, 'README.md'), '# hedef değişti\n');
    const diff = svc.jobDiff(review);
    expect(diff.mismatch).toEqual({ changed_but_not_reported: [], reported_but_unchanged: [] });
    expect(diff.note).toBeTruthy();
  });

  it('standard görev: kapılar geçer, görev accepted, iş approved', async () => {
    const task = svc.taskCreate({ title: 'a', objective: 'x' });
    const jobId = await run(task.task_id, 'implementation');
    const r = svc.taskAccept(task.task_id, jobId);
    expect(r.failed_gates).toEqual([]);
    expect(r.accepted).toBe(true);
    expect(store.mustGetJob(jobId).state).toBe('merged');
    expect(r.integration?.task_branch).toBe(`anafor/${task.task_id}`);
    expect(svc.taskStatus(task.task_id).state).toBe('accepted');
  });

  it('eski uygulama işi kabul edilemez', async () => {
    const task = svc.taskCreate({ title: 'eski', objective: 'x' });
    const first = await run(task.task_id, 'implementation');
    await run(task.task_id, 'implementation');
    const r = svc.taskAccept(task.task_id, first);
    expect(r.accepted).toBe(false);
    expect(r.failed_gates.map((g) => g.gate)).toContain('latest_implementation');
  });

  it('deep görev: review olmadan reddedilir, bağımsız review ile kabul', async () => {
    writeFileSync(
      join(t.dir, 'anafor.config.json'),
      JSON.stringify({ review: { require_for: 'standard' } }),
    );
    const task = svc.taskCreate({ title: 'deep', objective: 'x', reviewLevel: 'deep' });
    const impl = await run(task.task_id, 'implementation');
    const noReview = svc.taskAccept(task.task_id, impl);
    expect(noReview.accepted).toBe(false);
    expect(noReview.failed_gates.map((g) => g.gate)).toContain('deep_review');

    const review = await run(task.task_id, 'review', { newSession: true });
    const ok = svc.taskAccept(task.task_id, impl, review);
    expect(ok.failed_gates).toEqual([]);
    expect(ok.accepted).toBe(true);
    expect(store.mustGetJob(review).state).toBe('approved');
  });

  it('standard review zorunlu, completed review ile kabul edilir', async () => {
    writeFileSync(
      join(t.dir, 'anafor.config.json'),
      JSON.stringify({ review: { require_for: 'standard', worker: 'codex', model: 'test-model' } }),
    );
    const task = svc.taskCreate({ title: 'standard', objective: 'x' });
    const impl = await run(task.task_id, 'implementation');
    expect(svc.taskAccept(task.task_id, impl).failed_gates.map((g) => g.gate)).toContain(
      'review_required',
    );
    const review = await run(task.task_id, 'review', { targetJobId: impl });
    const accepted = svc.taskAccept(task.task_id, impl, review);
    expect(accepted.accepted).toBe(true);
    expect(store.mustGetJob(review).worker).toBe('codex');
    expect(store.mustGetJob(review).model).toBe('test-model');
  });

  it('review bulguları kabulü engeller, low bulgular yanıtta listelenir', async () => {
    writeFileSync(
      join(t.dir, 'anafor.config.json'),
      JSON.stringify({ review: { require_for: 'standard', worker: 'codex' } }),
    );
    const task = svc.taskCreate({ title: 'bulgular', objective: 'x' });
    const impl = await run(task.task_id, 'implementation');
    const review = await run(task.task_id, 'review', { targetJobId: impl });
    const reviewResult = store.mustGetJob(review).result!;
    store.db.prepare('UPDATE jobs SET result_json = ? WHERE id = ?').run(
      JSON.stringify({
        ...reviewResult,
        requirements_missing: ['kabul ölçütü X'],
        review: {
          ...reviewResult.review,
          findings: [
            { severity: 'medium', title: 'Orta bulgu', file: null, line: null, evidence: 'kanıt' },
            { severity: 'low', title: 'Düşük bulgu', file: null, line: null, evidence: 'kanıt' },
          ],
        },
      }),
      review,
    );
    const accepted = svc.taskAccept(task.task_id, impl, review);
    expect(accepted.failed_gates.map((g) => g.gate)).toContain('review_findings_open');
    expect(accepted.failed_gates.find((g) => g.gate === 'review_findings_open')?.detail).toContain(
      'Orta bulgu',
    );
    expect(accepted.open_low_findings).toEqual(['Düşük bulgu']);
  });

  it('önceki implementation incelemesinin low bulgularını doğrulanmamış gösterir', async () => {
    const task = svc.taskCreate({ title: 'eski review', objective: 'x' });
    const impl = await run(task.task_id, 'implementation');
    const review = await run(task.task_id, 'review', { targetJobId: impl });
    const result = store.mustGetJob(review).result!;
    store.db.prepare('UPDATE jobs SET result_json = ? WHERE id = ?').run(
      JSON.stringify({
        ...result,
        review: {
          ...result.review,
          findings: [
            { severity: 'low', title: 'Düşük', file: null, line: null, evidence: 'kanıt' },
          ],
        },
      }),
      review,
    );
    const correction = await run(task.task_id, 'implementation');
    const accepted = svc.taskAccept(task.task_id, correction, review);
    expect(accepted.open_low_findings).toEqual([]);
    expect(accepted.unverified_low_findings).toEqual(['Düşük']);
    expect(accepted.unverified_low_findings_note).toContain('önceki bir sürümü');
  });

  it.each([true, false])(
    'targetJobId olmayan legacy review stale=%s zamanına göre sınıflanır',
    async (stale) => {
      const task = svc.taskCreate({ title: 'legacy review', objective: 'x' });
      const impl = await run(task.task_id, 'implementation');
      const review = await run(task.task_id, 'review', { targetJobId: impl });
      const implJob = store.mustGetJob(impl);
      store.db.prepare('UPDATE jobs SET inputs_json = ? WHERE id = ?').run('{}', review);
      const reviewTime = Date.parse(implJob.endedAt!) + (stale ? -60_000 : 60_000);
      store.db
        .prepare('UPDATE jobs SET created_at = ? WHERE id = ?')
        .run(new Date(reviewTime).toISOString(), review);
      const result = svc.taskAccept(task.task_id, impl, review);
      expect(Object.hasOwn(result, 'unverified_low_findings')).toBe(stale);
    },
  );

  it('kapalı görevin needs_review işleri açılışta idempotent kapatılır; açık görev korunur', async () => {
    const closed = svc.taskCreate({ title: 'kapalı', objective: 'x' });
    const closedJob = await run(closed.task_id, 'implementation');
    store.db.prepare("UPDATE tasks SET state = 'abandoned' WHERE id = ?").run(closed.task_id);
    const open = svc.taskCreate({ title: 'açık', objective: 'x' });
    const openJob = await run(open.task_id, 'implementation');
    await Promise.all([
      Promise.resolve().then(
        () => new AnaforService(store, adapters, inProcessLauncher(adapters), 'fake'),
      ),
      Promise.resolve().then(
        () => new AnaforService(store, adapters, inProcessLauncher(adapters), 'fake'),
      ),
    ]);
    expect(store.mustGetJob(closedJob).state).toBe('approved');
    expect(store.listEvents(closedJob).map((event) => event.type)).toContain('closed_with_task');
    expect(store.mustGetJob(openJob).state).toBe('needs_review');
    new AnaforService(store, adapters, inProcessLauncher(adapters), 'fake');
    expect(
      store.listEvents(closedJob).filter((event) => event.type === 'closed_with_task'),
    ).toHaveLength(1);
  });

  it('job_result auto_check ile test iddiasını doğrular veya worker_only notu döndürür', async () => {
    const task = svc.taskCreate({ title: 'test doğrulama', objective: 'x' });
    const jobId = await run(task.task_id, 'implementation');
    const workerOnly = svc.jobResult(jobId);
    expect(workerOnly.tests_verification.source).toBe('worker_only');
    store.patchJob(jobId, {
      autoCheck: {
        passed: false,
        command: 'test',
        summary: 'failed',
        exit_code: 1,
        evidence: 'evidence',
        workdir: t.dir,
      },
    });
    expect(svc.jobResult(jobId).tests_verification).toMatchObject({
      source: 'auto_check',
      passed: false,
      exit_code: 1,
    });
  });

  it.each([
    { executed: ['npm test'], passed: 0, failed: 0, checkPassed: false, conflict: true },
    { executed: ['npm test'], passed: 0, failed: 1, checkPassed: true, conflict: true },
    { executed: ['npm test'], passed: 1, failed: 0, checkPassed: true, conflict: false },
    { executed: [], passed: 0, failed: 0, checkPassed: false, conflict: false },
  ])('auto_check test iddiasını raporla karşılaştırır: $executed/$failed', async (c) => {
    const task = svc.taskCreate({ title: 'test iddiası', objective: 'x' });
    const jobId = await run(task.task_id, 'implementation');
    const job = store.mustGetJob(jobId);
    const updated = {
      ...job.result!,
      tests: { executed: c.executed, passed: c.passed, failed: c.failed, exit_codes: [] },
    };
    store.db
      .prepare('UPDATE jobs SET result_json = ? WHERE id = ?')
      .run(JSON.stringify(updated), jobId);
    store.patchJob(jobId, {
      autoCheck: {
        passed: c.checkPassed,
        command: 'test',
        summary: 'test',
        exit_code: c.checkPassed ? 0 : 1,
        evidence: 'evidence',
        workdir: t.dir,
      },
    });
    const verification = svc.jobResult(jobId).tests_verification;
    if (c.conflict) expect(verification.note).toContain('çelişiyor');
    else if (c.executed.length === 0) expect(verification.note).toContain('raporlamadı');
    else expect(verification.note).toBeUndefined();
  });

  it('inceleyicinin yalnız "test çalıştırılamadı" eksiği kapıyı kilitlemez', async () => {
    writeFileSync(
      join(t.dir, 'anafor.config.json'),
      JSON.stringify({ review: { require_for: 'standard', worker: 'codex' } }),
    );
    const task = svc.taskCreate({ title: 'salt okunur', objective: 'x' });
    const impl = await run(task.task_id, 'implementation');
    const review = await run(task.task_id, 'review', { targetJobId: impl });
    const reviewResult = store.mustGetJob(review).result!;
    store.db.prepare('UPDATE jobs SET result_json = ? WHERE id = ?').run(
      JSON.stringify({
        ...reviewResult,
        requirements_missing: ['npm test çalıştırılamadı (izin gerektirdi)'],
      }),
      review,
    );
    const accepted = svc.taskAccept(task.task_id, impl, review);
    expect(accepted.failed_gates.map((g) => g.gate)).not.toContain('review_findings_open');
  });

  it('lightweight görevde review kapısı yok', async () => {
    const task = svc.taskCreate({ title: 'light', objective: 'x', reviewLevel: 'lightweight' });
    const impl = await run(task.task_id, 'implementation');
    expect(svc.taskAccept(task.task_id, impl).failed_gates.map((g) => g.gate)).not.toContain(
      'review_required',
    );
  });

  it.each([true, false, null])(
    'review sonrası düzeltmede auto_check=%s güncellik kararını belirler',
    async (passed) => {
      writeFileSync(
        join(t.dir, 'anafor.config.json'),
        JSON.stringify({ review: { require_for: 'standard', worker: 'codex' } }),
      );
      const task = svc.taskCreate({ title: 'düzeltme', objective: 'x' });
      const impl = await run(task.task_id, 'implementation');
      const review = await run(task.task_id, 'review', { targetJobId: impl });
      const correction = await run(task.task_id, 'implementation');
      if (passed !== null)
        store.patchJob(correction, {
          autoCheck: {
            passed,
            command: 'npm test',
            summary: 'test',
            exit_code: passed ? 0 : 1,
            evidence: '.anafor/evidence/x-auto-tests.txt',
            workdir: t.dir,
          },
        });
      const result = svc.taskAccept(task.task_id, correction, review);
      if (passed === true) expect(result.failed_gates).toEqual([]);
      else expect(result.failed_gates.map((g) => g.gate)).toContain('deep_review_fresh');
    },
  );

  it('review.require_for=none kapatır standard review kapısını', async () => {
    writeFileSync(
      join(t.dir, 'anafor.config.json'),
      JSON.stringify({ review: { require_for: 'none' } }),
    );
    const task = svc.taskCreate({ title: 'no review', objective: 'x' });
    const impl = await run(task.task_id, 'implementation');
    expect(svc.taskAccept(task.task_id, impl).failed_gates.map((g) => g.gate)).not.toContain(
      'review_required',
    );
  });

  it('task_close: aktif iş varken CONFLICT, sonra kapanır', async () => {
    const task = svc.taskCreate({ title: 'kapat', objective: 'x' });
    const d = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:slow]',
    });
    expect(() => svc.taskClose(task.task_id, 'abandoned', 'vazgeçildi')).toThrow(/aktif/);
    svc.jobCancel(d.job_id, 'kapanış');
    expect(svc.taskClose(task.task_id, 'abandoned', 'vazgeçildi').state).toBe('abandoned');
  });
});
