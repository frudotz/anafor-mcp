import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, win32 } from 'node:path';
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
  autoCheck?: { passed: boolean; summary: string } | null;
  reviewRequireFor?: 'standard' | 'deep' | 'none';
}

/**
 * Kanıt yolunu çözer: göreli yollar işin çalışma dizinine göre (worktree), `dosya:satır[:sütun]`
 * son eki atılır; sonuç proje kökünün içinde olmalıdır (worktree'ler `.anafor/` altında, içeride).
 */
export function resolveEvidence(root: string, workdir: string, p: string): string | null {
  const raw = p.trim();
  const windowsRoot = /^[A-Za-z]:[\\/]/.test(root) || /^(?:\\\\|\/\/)/.test(root);
  const windowsEvidence = /^[A-Za-z]:[\\/]/.test(raw) || /^(?:\\\\|\/\/)/.test(raw);
  const pathApi = windowsRoot ? win32 : undefined;
  const resolvePath = pathApi?.resolve ?? resolve;
  const relativePath = pathApi?.relative ?? relative;
  const absolute = (value: string) => (windowsRoot ? win32.isAbsolute(value) : isAbsolute(value));
  const inProject = (clean: string): string | null => {
    if (windowsEvidence && !windowsRoot) return null;
    const normalized = clean.replace(/\\/g, '/');
    const generatedEvidence = normalized.startsWith('.anafor/evidence/');
    const base = generatedEvidence ? root : workdir;
    const abs = absolute(clean) ? clean : resolvePath(base, clean);
    const rel = relativePath(root, abs);
    const workRel = relativePath(workdir, abs);
    const inside = (r: string) =>
      r !== '..' && !r.startsWith(`..${windowsRoot ? '\\' : '/'}`) && !absolute(r);
    return inside(rel) || inside(workRel) ? abs : null;
  };
  // Prefer an actual filename containing parentheses, e.g. `foo (1).ts`.
  const fullPath = inProject(raw);
  if (fullPath && existsSync(fullPath)) return fullPath;

  let clean = raw.replace(/#L\d+(?:-L?\d+|C\d+)?$/i, '').replace(/:\d+(?:-\d+)?(?::\d+)?$/, '');
  const colon = clean.indexOf(':');
  if (
    colon >= 0 &&
    !(colon === 1 && /^[A-Za-z]$/.test(clean[0]!)) &&
    !/^\d/.test(clean.slice(colon + 1))
  ) {
    clean = clean.slice(0, colon);
  }
  const parsed = inProject(clean);
  if (parsed && existsSync(parsed)) return parsed;
  const paren = clean.replace(/ \([^)]*\)$/, '');
  return paren !== clean ? inProject(paren) : parsed;
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
  const auto = input.autoCheck;
  if (v || auto?.passed)
    add(
      'verified_by_evidence',
      !!auto?.passed || v!.ok,
      auto?.passed ? `otomatik test kanıtı: ${auto.summary}` : v!.detail,
    );
  const viaEvidence = v?.ok === true || auto?.passed === true;
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
      (auto ? auto.passed : r.tests.failed === 0 && badExit.length === 0) || v?.ok === true,
      auto && !auto.passed
        ? `auto_check başarısız: ${auto.summary}`
        : `geçen ${r.tests.passed}, kalan ${r.tests.failed}, başarısız çıkış kodları: ${badExit.join(',') || 'yok'}`,
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

  const requiresReview =
    input.reviewRequireFor !== 'none' &&
    (task.reviewLevel === 'deep' ||
      (task.reviewLevel === 'standard' && input.reviewRequireFor !== 'deep'));
  if (requiresReview) {
    if (!reviewJob) {
      add(
        task.reviewLevel === 'standard' ? 'review_required' : 'deep_review',
        false,
        `${task.reviewLevel} seviye: bağımsız review işi gerekli (review_job_id)`,
      );
    } else {
      const rr = reviewJob.result;
      const independent =
        reviewJob.worker !== job.worker ||
        (reviewJob.sessionRef !== null && reviewJob.sessionRef !== job.sessionRef);
      const fresh =
        !!reviewJob.startedAt &&
        !!job.endedAt &&
        Date.parse(reviewJob.startedAt) >= Date.parse(job.endedAt);
      const afterReview = taskJobs.filter(
        (j) =>
          j.role === 'implementation' &&
          j.createdAt &&
          reviewJob.endedAt &&
          Date.parse(j.createdAt) > Date.parse(reviewJob.endedAt),
      );
      const corrected =
        afterReview.length > 0 &&
        afterReview.every((j) => j.autoCheck?.passed) &&
        afterReview[afterReview.length - 1]?.id === latestImpl?.id;
      const findings = rr?.review.findings ?? [];
      const openFindings = findings.filter(
        (f) => f.severity === 'medium' || f.severity === 'high' || f.severity === 'critical',
      );
      // Salt okunur inceleyicinin "testleri çalıştıramadım" maddeleri kalite bulgusu değildir.
      const missingRequirements = (rr?.requirements_missing ?? []).filter(
        (item) => !onlyMissingChecks([item]),
      );
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
        fresh || corrected,
        fresh
          ? 'uygulamadan sonra başladı'
          : corrected
            ? 'sonraki düzeltmeler auto_check geçti'
            : 'review güncel değil',
      );
      add(
        'deep_review_no_critical',
        (rr?.review.critical_count ?? 1) === 0,
        `kritik: ${rr?.review.critical_count ?? '?'}`,
      );
      add(
        'review_findings_open',
        (openFindings.length === 0 && missingRequirements.length === 0) || corrected,
        corrected
          ? 'review sonrası düzeltmeler auto_check geçti'
          : [...openFindings.map((f) => f.title), ...missingRequirements].join('; ') ||
              'açık review bulgusu yok',
      );
    }
  }
  return gates;
}
