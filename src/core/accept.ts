import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Job, Task } from '../store/store.js';

export interface Gate {
  gate: string;
  ok: boolean;
  detail: string;
}

export interface AcceptInput {
  task: Task;
  job: Job;
  /** Görevin tüm işleri (oluşturulma sırasıyla). */
  taskJobs: Job[];
  reviewJob: Job | null;
  projectRoot: string;
  /**
   * Anafor'un kendi kanıtı (evidence_generate) testlerin geçtiğini gösteriyorsa ve yönetici
   * açıkça istediyse, işçi beyanına dayanan status/gereksinim/test kapıları bu kanıtla geçer.
   */
  verifiedByEvidence?: { ok: boolean; detail: string } | null;
}

/**
 * Kanıt yolunu çözer: göreli yollar işin çalışma dizinine göre (worktree), `dosya:satır[:sütun]`
 * son eki atılır; sonuç proje kökünün içinde olmalıdır (worktree'ler `.anafor/` altında, içeride).
 */
export function resolveEvidence(root: string, workdir: string, p: string): string | null {
  const clean = p.trim().replace(/:\d+(:\d+)?$/, '');
  const abs = isAbsolute(clean) ? clean : resolve(workdir, clean);
  const rel = relative(root, abs);
  return !rel.startsWith('..') && !isAbsolute(rel) ? abs : null;
}

/** Partial review is acceptable only when every missing item clearly concerns running checks. */
export function onlyMissingChecks(missing: string[]): boolean {
  if (!missing.length) return false;
  return missing.every((item) => {
    const check =
      /\b(?:npm\s+(?:run\s+check|test)|vitest|typecheck|tsc|npx)\b/i.test(item) ||
      /\b(?:tests?|testing|komut|command)\b|testler/i.test(item);
    const unable =
      /\b(?:could not run|unable to run|not run|approval required|permission required|approval|permission|denied)\b|çalıştırılamadı|çalıştırılmadı|onay gerektirdi|izin gerektirdi|reddedildi/i.test(
        item,
      );
    return check && unable;
  });
}

export function deepReviewCompleted(
  state: Job['state'],
  status: string | undefined,
  missing: string[],
  criticalCount: number | undefined,
): boolean {
  return (
    state === 'needs_review' &&
    (status === 'completed' ||
      (status === 'partial' && onlyMissingChecks(missing) && criticalCount === 0))
  );
}

/**
 * Kabul kapıları (eski orchestrator.ps1 `accept` kurallarının karşılığı).
 * Kapılardan geçmek gerekli ama yeterli değildir: kriterlerin karşılandığına yönetici karar verir.
 */
export function evaluateAcceptance(input: AcceptInput): Gate[] {
  const { task, job, taskJobs, reviewJob, projectRoot } = input;
  const gates: Gate[] = [];
  const add = (gate: string, ok: boolean, detail: string) => gates.push({ gate, ok, detail });
  const r = job.result;

  add('job_of_task', job.taskId === task.id, `iş ${job.id} görev ${task.id}'e ait`);
  add('job_needs_review', job.state === 'needs_review', `iş durumu: ${job.state}`);

  const impl = taskJobs.filter((j) => j.role === 'implementation');
  const latestImpl = impl[impl.length - 1];
  add(
    'latest_implementation',
    job.role !== 'implementation' || latestImpl?.id === job.id,
    latestImpl?.id === job.id
      ? 'en güncel uygulama işi'
      : `daha yeni uygulama işi var: ${latestImpl?.id}`,
  );

  add('result_present', r !== null, r ? 'doğrulanmış sonuç var' : 'sonuç yok');
  const v = input.verifiedByEvidence;
  if (v) add('verified_by_evidence', v.ok, v.detail);
  const viaEvidence = v?.ok === true;
  if (r) {
    add(
      'status_completed',
      r.status === 'completed' || viaEvidence,
      viaEvidence && r.status !== 'completed'
        ? `işçi: ${r.status}; Anafor kanıtıyla doğrulandı`
        : `status: ${r.status}`,
    );
    add(
      'requirements_complete',
      r.requirements_missing.length === 0 || viaEvidence,
      r.requirements_missing.length
        ? `eksik (işçi beyanı): ${r.requirements_missing.join('; ')}${viaEvidence ? ' → yönetici + Anafor kanıtıyla doğrulandı' : ''}`
        : 'eksik gereksinim yok',
    );
    const badExit = r.tests.exit_codes.filter((c) => c !== 0);
    add(
      'tests_pass',
      (r.tests.failed === 0 && badExit.length === 0) || viaEvidence,
      `geçen ${r.tests.passed}, kalan ${r.tests.failed}, başarısız çıkış kodları: ${badExit.join(',') || 'yok'}`,
    );
    add(
      'no_critical_findings',
      r.review.critical_count === 0,
      `kritik bulgu: ${r.review.critical_count}`,
    );
    const missing = r.evidence_locations.filter((p) => {
      const abs = resolveEvidence(projectRoot, job.workdir, p);
      return abs === null || !existsSync(abs);
    });
    add(
      'evidence_in_project',
      missing.length === 0,
      missing.length
        ? `proje dışında veya yok: ${missing.join(', ')}`
        : `${r.evidence_locations.length} kanıt dosyası`,
    );
  }

  if (task.reviewLevel === 'deep') {
    if (!reviewJob) {
      add('deep_review', false, 'deep seviye: bağımsız review işi gerekli (review_job_id)');
    } else {
      const rr = reviewJob.result;
      const independent =
        reviewJob.worker !== job.worker ||
        (reviewJob.sessionRef !== null && reviewJob.sessionRef !== job.sessionRef);
      const fresh =
        !!reviewJob.startedAt &&
        !!job.endedAt &&
        Date.parse(reviewJob.startedAt) >= Date.parse(job.endedAt);
      add(
        'deep_review_role',
        reviewJob.role === 'review' && reviewJob.taskId === task.id,
        `rol: ${reviewJob.role}`,
      );
      const checkPartialAccepted =
        rr?.status === 'partial' &&
        onlyMissingChecks(rr.requirements_missing) &&
        rr.review.critical_count === 0;
      add(
        'deep_review_done',
        deepReviewCompleted(
          reviewJob.state,
          rr?.status,
          rr?.requirements_missing ?? [],
          rr?.review.critical_count,
        ),
        checkPartialAccepted
          ? `durum: partial; eksikler yalnızca test/komut çalıştırma, kritik bulgu yok — inceleme tamamlandı`
          : `durum: ${reviewJob.state}/${rr?.status ?? 'sonuç yok'}`,
      );
      add(
        'deep_review_independent',
        independent,
        independent ? 'farklı işçi veya oturum' : 'aynı oturum',
      );
      add(
        'deep_review_fresh',
        fresh,
        fresh ? 'uygulamadan sonra başladı' : 'uygulama bitmeden başlamış',
      );
      add(
        'deep_review_no_critical',
        (rr?.review.critical_count ?? 1) === 0,
        `kritik: ${rr?.review.critical_count ?? '?'}`,
      );
    }
  }
  return gates;
}
