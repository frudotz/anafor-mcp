import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { CheckpointMeta } from './checkpoint.js';
import type { OperationPolicy, OperationType, ProtectedRisk, RiskTier } from './policy.js';

/** Yetkilendirme girdisi (eski authorize-operation parametrelerinin karşılığı). */
export interface OperationInput {
  operation: OperationType;
  reason: string;
  task_id: string;
  actor: 'claude' | 'codex' | 'user' | string;
  checkpoint: string;
  test_evidence: string;
  sensitive_scan_evidence: string;
  tests_passed: boolean;
  user_changes_preserved: boolean;
  sensitive_scan_clean: boolean;
  branch?: string | undefined;
  base_branch?: string | undefined;
  commit_hash?: string | undefined;
  ci_passed?: boolean | undefined;
  review_completed?: boolean | undefined;
  branch_protection_satisfied?: boolean | undefined;
  post_merge_validation_plan?: string | undefined;
  environment?: string | undefined;
  service?: string | undefined;
  artifact_hash?: string | undefined;
  artifact_evidence?: string | undefined;
  health_checks_passed?: boolean | undefined;
  health_checks_evidence?: string | undefined;
  rollback_plan?: string | undefined;
  production_policy_id?: string | undefined;
  risk_tier?: RiskTier | undefined;
  protected_risk?: ProtectedRisk | undefined;
  explicit_user_approval?: boolean | undefined;
  approval_evidence?: string | undefined;
}

export interface AuthorizeContext {
  root: string;
  projectId: string;
  policy: OperationPolicy | null;
  checkpoint: CheckpointMeta | null;
  /** Görevin en son uygulama/düzeltme işinin bitiş zamanı (checkpoint tazeliği için). */
  lastImplementationAt: string | null;
}

const GIT_OPS: OperationType[] = [
  'commit',
  'push',
  'pr-create',
  'pr-update',
  'merge',
  'deployment',
];
const PROTECTED_OPS: OperationType[] = [
  'database-change',
  'security-policy-change',
  'access-control-change',
  'cost-change',
  'irreversible-change',
];
const RISK_RANK: Record<RiskTier, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const blank = (s?: string) => !s || !s.trim();

/** Kanıt dosyası proje içinde ve mevcut mu? */
export function evidenceOk(root: string, p: string | undefined): boolean {
  if (blank(p)) return false;
  const abs = isAbsolute(p!) ? p! : resolve(root, p!);
  const rel = relative(root, abs);
  return !rel.startsWith('..') && !isAbsolute(rel) && existsSync(abs);
}

/**
 * İşlem yetkisi kapısı. Yalnızca karar verir; işlemi yapmaz.
 * Boş veya eşleşmeyen politika = ret. Korumalı riskler her zaman açık kullanıcı onayı ister.
 */
export function authorizeOperation(input: OperationInput, ctx: AuthorizeContext): string[] {
  const r: string[] = [];
  const { policy, checkpoint } = ctx;
  if (!policy || policy.project_id !== ctx.projectId) {
    return ['Politika yok veya proje ile eşleşmiyor (.anafor/policy.json).'];
  }
  if (blank(input.reason)) r.push('Gerekçe zorunlu.');
  if (GIT_OPS.includes(input.operation) && blank(input.branch))
    r.push(`${input.operation} için branch zorunlu.`);
  if (!evidenceOk(ctx.root, input.test_evidence))
    r.push('Test kanıtı proje içinde bir dosya olmalı.');
  if (!evidenceOk(ctx.root, input.sensitive_scan_evidence))
    r.push('Hassas veri taraması kanıtı proje içinde bir dosya olmalı.');
  if (!input.tests_passed) r.push('İlgili testler başarılı bildirilmedi.');
  if (!input.user_changes_preserved) r.push('Kullanıcı değişikliklerinin korunduğu doğrulanmadı.');
  if (!input.sensitive_scan_clean) r.push('Hassas veri taraması temiz değil.');

  if (!checkpoint) {
    r.push('Önce checkpoint oluşturun.');
  } else {
    if (checkpoint.project_id !== ctx.projectId || checkpoint.task_id !== input.task_id)
      r.push('Checkpoint proje ve görevle eşleşmiyor.');
    if (input.branch && checkpoint.branch !== input.branch)
      r.push(`Checkpoint dalı (${checkpoint.branch}) işlem dalıyla (${input.branch}) eşleşmiyor.`);
    if (
      ctx.lastImplementationAt &&
      Date.parse(checkpoint.created_at) < Date.parse(ctx.lastImplementationAt)
    )
      r.push('Checkpoint son uygulamadan eski; yeni checkpoint alın.');
  }
  if (
    ['push', 'pr-create', 'pr-update', 'merge'].includes(input.operation) &&
    !/^[a-f0-9]{7,64}$/i.test(input.commit_hash ?? '')
  )
    r.push('commit_hash eksik veya geçersiz.');

  switch (input.operation) {
    case 'commit':
      if (!policy.allow_autonomous_commit) r.push('Otonom commit politika ile kapalı.');
      break;
    case 'push':
    case 'pr-create':
    case 'pr-update':
      if (!policy.allowed_push_branches.includes(input.branch ?? ''))
        r.push(`'${input.branch}' allowed_push_branches içinde değil.`);
      if (
        input.operation !== 'push' &&
        !policy.allowed_pr_base_branches.includes(input.base_branch ?? '')
      )
        r.push(`Taban dal '${input.base_branch}' allowed_pr_base_branches içinde değil.`);
      break;
    case 'merge':
      if (!policy.allowed_merge_branches.includes(input.base_branch ?? ''))
        r.push(`Hedef dal '${input.base_branch}' allowed_merge_branches içinde değil.`);
      if (!input.ci_passed) r.push('CI geçmedi.');
      if (!input.review_completed) r.push('Gerekli inceleme tamamlanmadı.');
      if (!input.branch_protection_satisfied) r.push('Dal koruması doğrulanmadı.');
      if (blank(input.post_merge_validation_plan))
        r.push('Birleştirme sonrası doğrulama planı yok.');
      if (checkpoint && !checkpoint.is_clean)
        r.push('Birleştirme temiz çalışma ağacı checkpoint’i gerektirir.');
      break;
    case 'deployment': {
      if (!policy.allowed_deployment_environments.includes(input.environment ?? ''))
        r.push(`Ortam '${input.environment}' önceden yetkilendirilmemiş.`);
      if (!/^([a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.artifact_hash ?? ''))
        r.push('Artefakt hash eksik veya geçersiz.');
      if (!evidenceOk(ctx.root, input.artifact_evidence)) r.push('Artefakt kanıtı eksik.');
      if (!input.health_checks_passed) r.push('Sağlık kontrolleri doğrulanmadı.');
      if (!evidenceOk(ctx.root, input.health_checks_evidence))
        r.push('Sağlık kontrolü kanıtı eksik.');
      if (blank(input.rollback_plan)) r.push('Geri alma planı yok.');
      if (/(^|[-_/])(prod|production)([-_/]|$)/i.test(input.environment ?? '')) {
        const p = policy.production;
        const max = RISK_RANK[p.max_risk_tier] ?? 0;
        if (
          !p.autonomous_enabled ||
          blank(p.policy_id ?? undefined) ||
          input.production_policy_id !== p.policy_id ||
          !p.allowed_services.includes(input.service ?? '') ||
          RISK_RANK[input.risk_tier ?? 'low'] > max
        )
          r.push(
            'Üretim politikası bu servis, politika kimliği veya risk seviyesine izin vermiyor.',
          );
      }
      break;
    }
    case 'database-change':
      if (!['production-data-loss', 'irreversible-change'].includes(input.protected_risk ?? 'none'))
        r.push('Veritabanı değişikliği korumalı risk sınıflandırması gerektirir.');
      break;
    case 'security-policy-change':
    case 'access-control-change':
    case 'irreversible-change':
      if (input.protected_risk !== input.operation)
        r.push(`${input.operation} kendi korumalı risk sınıfını gerektirir.`);
      break;
    case 'cost-change':
      if (input.protected_risk !== 'unplanned-cost')
        r.push('Maliyet değişikliği unplanned-cost sınıfını gerektirir.');
      break;
  }
  const risk = input.protected_risk ?? 'none';
  if (risk !== 'none' && (!input.explicit_user_approval || blank(input.approval_evidence)))
    r.push(`'${risk}' açık kullanıcı onayı ve kanıtı gerektirir.`);
  if (PROTECTED_OPS.includes(input.operation) && risk === 'none')
    r.push('Bu işlem her zaman korumalı risk sınıflandırması ve açık kullanıcı onayı gerektirir.');
  if (input.explicit_user_approval && blank(input.approval_evidence)) r.push('Onay kanıtı eksik.');
  return r;
}

export interface RecordInput extends OperationInput {
  outcome: 'succeeded' | 'failed' | 'blocked' | 'rolled_back';
  result_summary: string;
  reference?: string | undefined;
}

/** Append-only audit kaydı. Başarılı git/deploy kayıtları hash ve kanıt gerektirir. */
export function recordOperation(
  auditDir: string,
  input: RecordInput,
  ctx: { root: string; projectId: string },
): { timestamp_utc: string; audit_file: string } {
  if (blank(input.result_summary)) throw new Error('result_summary zorunlu');
  if (
    input.outcome === 'succeeded' &&
    (!input.tests_passed || !input.user_changes_preserved || !input.sensitive_scan_clean)
  )
    throw new Error(
      'Başarılı kayıt; geçen testler, korunmuş kullanıcı değişiklikleri ve temiz tarama gerektirir',
    );
  const hash = (input.commit_hash ?? input.artifact_hash ?? '').toLowerCase() || null;
  if (hash && !/^[a-f0-9]{7,64}$/.test(hash))
    throw new Error('commit/artifact hash onaltılık olmalı');
  if (input.outcome === 'succeeded' && GIT_OPS.includes(input.operation) && !hash)
    throw new Error('Başarılı git/deploy kaydı commit veya artefakt hash gerektirir');
  const reference = input.reference?.match(/^https:\/\/[^?\s#]+/)?.[0] ?? input.reference ?? null;
  const record = {
    schema_version: 1,
    project_id: ctx.projectId,
    timestamp_utc: new Date().toISOString(),
    ...input,
    commit_or_artifact_hash: hash,
    reference,
  };
  mkdirSync(auditDir, { recursive: true });
  const file = join(auditDir, 'operations.jsonl');
  appendFileSync(file, JSON.stringify(record) + '\n');
  return {
    timestamp_utc: record.timestamp_utc,
    audit_file: relative(ctx.root, file).replace(/\\/g, '/'),
  };
}
