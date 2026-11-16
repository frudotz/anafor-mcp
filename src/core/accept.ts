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
}

const inside = (root: string, p: string) => {
  const abs = isAbsolute(p) ? p : resolve(root, p);
  const rel = relative(root, abs);
  return !rel.startsWith('..') && !isAbsolute(rel) ? abs : null;
};

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
  if (r) {
    add('status_completed', r.status === 'completed', `status: ${r.status}`);
    add(
      'requirements_complete',
      r.requirements_missing.length === 0,
      r.requirements_missing.length
        ? `eksik: ${r.requirements_missing.join('; ')}`
        : 'eksik gereksinim yok',
    );
    const badExit = r.tests.exit_codes.filter((c) => c !== 0);
    add(
      'tests_pass',
      r.tests.failed === 0 && badExit.length === 0,
      `geçen ${r.tests.passed}, kalan ${r.tests.failed}, başarısız çıkış kodları: ${badExit.join(',') || 'yok'}`,
    );
    add(
      'no_critical_findings',
      r.review.critical_count === 0,
      `kritik bulgu: ${r.review.critical_count}`,
    );
    const missing = r.evidence_locations.filter((p) => {
      const abs = inside(projectRoot, p);
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
      add(
        'deep_review_done',
        reviewJob.state === 'needs_review' && rr?.status === 'completed',
        `durum: ${reviewJob.state}`,
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
