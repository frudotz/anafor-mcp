import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type RiskTier = 'low' | 'medium' | 'high' | 'critical';
export type OperationType =
  | 'commit'
  | 'push'
  | 'pr-create'
  | 'pr-update'
  | 'merge'
  | 'deployment'
  | 'database-change'
  | 'security-policy-change'
  | 'access-control-change'
  | 'cost-change'
  | 'irreversible-change';
export type ProtectedRisk =
  | 'none'
  | 'production-data-loss'
  | 'irreversible-change'
  | 'security-policy-change'
  | 'access-control-change'
  | 'unplanned-cost';

/** Eski OPERATION_POLICY.json ile alan uyumlu proje politikası. */
export interface OperationPolicy {
  schema_version: 1;
  project_id: string;
  allow_autonomous_commit: boolean;
  allowed_push_branches: string[];
  allowed_pr_base_branches: string[];
  allowed_merge_branches: string[];
  allowed_deployment_environments: string[];
  production: {
    autonomous_enabled: boolean;
    policy_id: string | null;
    allowed_services: string[];
    max_risk_tier: RiskTier;
    required_health_checks: string[];
  };
}

/** Muhafazakâr varsayılan: otonom commit açık, diğer tüm allowlist'ler boş, üretim kapalı. */
export function defaultPolicy(projectId: string): OperationPolicy {
  return {
    schema_version: 1,
    project_id: projectId,
    allow_autonomous_commit: true,
    allowed_push_branches: [],
    allowed_pr_base_branches: [],
    allowed_merge_branches: [],
    allowed_deployment_environments: [],
    production: {
      autonomous_enabled: false,
      policy_id: null,
      allowed_services: [],
      max_risk_tier: 'low',
      required_health_checks: [],
    },
  };
}

export const policyPath = (anaforDir: string) => join(anaforDir, 'policy.json');

/** Politika yoksa varsayılanı oluşturur; varsa dokunmaz. */
export function ensurePolicy(anaforDir: string, projectId: string): OperationPolicy {
  const p = policyPath(anaforDir);
  if (!existsSync(p)) writeFileSync(p, JSON.stringify(defaultPolicy(projectId), null, 2) + '\n');
  return JSON.parse(readFileSync(p, 'utf8')) as OperationPolicy;
}

export function loadPolicy(anaforDir: string): OperationPolicy | null {
  const p = policyPath(anaforDir);
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as OperationPolicy) : null;
}
