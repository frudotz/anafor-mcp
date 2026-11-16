import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject } from 'ajv';

export type Role = 'implementation' | 'review' | 'analysis' | 'test';
export type ResultStatus = 'completed' | 'partial' | 'blocked' | 'failed';
export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';
export type ReviewLevel = 'lightweight' | 'standard' | 'deep';

export interface Finding {
  severity: Severity;
  title: string;
  file: string | null;
  line: number | null;
  evidence: string;
}

export interface WorkerResultV1 {
  schema_version: '1';
  task_id: string;
  job_id: string;
  agent_role: Role;
  status: ResultStatus;
  summary: string;
  changed_files: string[];
  requirements_completed: string[];
  requirements_missing: string[];
  tests: { executed: string[]; passed: number; failed: number; exit_codes: number[] };
  review: { level: ReviewLevel | 'none'; critical_count: number; findings: Finding[] };
  evidence_locations: string[];
  blockers: string[];
  recommended_next_action: string;
}

/** Şema dosyasının mutlak yolu (src/ ve dist/ altından aynı göreli konum). */
export const WORKER_RESULT_SCHEMA_PATH = fileURLToPath(
  new URL('../../schemas/worker-result.v1.json', import.meta.url),
);

const schema = JSON.parse(readFileSync(WORKER_RESULT_SCHEMA_PATH, 'utf8')) as object;
const ajv = new Ajv2020({ allErrors: true, strict: false });
const validateFn = ajv.compile<WorkerResultV1>(schema);

export type ValidationOutcome =
  { ok: true; value: WorkerResultV1; warnings: string[] } | { ok: false; errors: string[] };

function formatErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message ?? 'geçersiz'}`);
}

/** Son mesaj metninden JSON nesnesini çıkarır (düz JSON veya ```json bloğu). */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // devam: kod bloğu veya gömülü nesne ara
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  if (fence?.[1]) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // devam
    }
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(trimmed.slice(start, end + 1));
  }
  throw new Error('Son mesajda JSON bulunamadı');
}

/**
 * Şema doğrulaması + şemanın ötesindeki sunucu kontrolleri.
 * expected: dispatch edilen kimlikler; işçi bunları uyduramaz.
 */
export function validateWorkerResult(
  input: unknown,
  expected: { taskId: string; jobId: string; role: Role },
): ValidationOutcome {
  if (!validateFn(input)) {
    return { ok: false, errors: formatErrors(validateFn.errors) };
  }
  const value = input;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (value.task_id !== expected.taskId) {
    errors.push(`task_id uyuşmuyor: beklenen ${expected.taskId}, gelen ${value.task_id}`);
  }
  if (value.job_id !== expected.jobId) {
    errors.push(`job_id uyuşmuyor: beklenen ${expected.jobId}, gelen ${value.job_id}`);
  }
  if (value.agent_role !== expected.role) {
    errors.push(`agent_role uyuşmuyor: beklenen ${expected.role}, gelen ${value.agent_role}`);
  }
  const criticals = value.review.findings.filter((f) => f.severity === 'critical').length;
  if (criticals !== value.review.critical_count) {
    warnings.push(
      `critical_count (${value.review.critical_count}) bulgulardaki kritik sayısıyla (${criticals}) uyuşmuyor; ${Math.max(criticals, value.review.critical_count)} kabul edildi`,
    );
    value.review.critical_count = Math.max(criticals, value.review.critical_count);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value, warnings };
}
