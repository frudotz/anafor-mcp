import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { decidePermission } from '../chat/permissions.js';
import { m } from '../i18n/index.js';
import type { Messages } from '../i18n/tr.js';
import { ANAFOR_VERSION } from '../version.js';
import { AnaforService, ServiceError } from './service.js';

/** Yönetici talimatları (geçerli dilde; dil çözüldükten sonra çağrılır). */
export const serverInstructions = (): string => m().server.instructions;

/** Araç açıklamaları (geçerli dilde). Anahtar: araç adı. */
export function toolDescriptions(): Omit<Messages['tools'], 'fields'> {
  const { fields: _fields, ...rest } = m().tools;
  return rest;
}

const role = z.enum(['implementation', 'review', 'analysis', 'test']);
const finding = z.object({
  severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
  title: z.string(),
  file: z.string().nullable().default(null),
  line: z.number().int().nullable().default(null),
  evidence: z.string(),
});

function ok(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data) }] };
}

function fail(e: unknown): CallToolResult {
  const err =
    e instanceof ServiceError
      ? { code: e.code, message: e.message, hint: e.hint ?? null }
      : { code: 'INTERNAL', message: (e as Error)?.message ?? String(e), hint: null };
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(err) }] };
}

async function wrap(fn: () => unknown | Promise<unknown>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

export function createMcpServer(svc: () => AnaforService): McpServer {
  const server = new McpServer(
    { name: 'anafor', version: ANAFOR_VERSION },
    { instructions: serverInstructions() },
  );
  const t = m().tools;
  const f = t.fields;

  server.registerTool(
    'workers_list',
    {
      description: t.workers_list,
    },
    () => wrap(() => svc().workersList()),
  );

  server.registerTool(
    'workers_limits',
    {
      description: t.workers_limits,
    },
    () => wrap(() => svc().workersLimits()),
  );

  server.registerTool(
    'capacity_status',
    {
      description: t.capacity_status,
    },
    () => wrap(() => svc().capacityStatus()),
  );

  server.registerTool(
    'worker_stats',
    {
      description: t.worker_stats,
      inputSchema: { role: role.optional() },
    },
    (a) => wrap(() => svc().workerStats(a.role)),
  );

  server.registerTool('project_status', { description: t.project_status }, () =>
    wrap(() => svc().projectStatus()),
  );

  server.registerTool(
    'task_create',
    {
      description: t.task_create,
      inputSchema: {
        title: z.string().min(1),
        objective: z.string().min(1),
        acceptance_criteria: z.array(z.string()).optional(),
        constraints: z.array(z.string()).optional(),
        context_refs: z.array(z.string()).optional().describe(f.contextRefs),
        review_level: z.enum(['lightweight', 'standard', 'deep']).optional(),
        priority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
      },
    },
    (a) =>
      wrap(() =>
        svc().taskCreate({
          title: a.title,
          objective: a.objective,
          acceptanceCriteria: a.acceptance_criteria,
          constraints: a.constraints,
          contextRefs: a.context_refs,
          reviewLevel: a.review_level,
          priority: a.priority,
        }),
      ),
  );

  server.registerTool(
    'task_status',
    {
      description: t.task_status,
      inputSchema: { task_id: z.string() },
    },
    (a) => wrap(() => svc().taskStatus(a.task_id)),
  );

  server.registerTool(
    'job_dispatch',
    {
      description: t.job_dispatch,
      inputSchema: {
        task_id: z.string(),
        role,
        instructions: z.string().min(1).describe(f.instructions),
        worker: z.string().optional().describe(f.worker),
        model: z.string().optional(),
        workspace: z.enum(['shared', 'readonly', 'worktree']).optional(),
        timeout_s: z.number().int().min(10).max(7200).optional(),
        files: z.array(z.string()).optional(),
        refs: z.array(z.string()).optional(),
        new_session: z.boolean().optional().describe(f.newSession),
        target_job_id: z.string().optional().describe(f.targetJobId),
      },
    },
    (a) =>
      wrap(() =>
        svc().jobDispatch({
          taskId: a.task_id,
          role: a.role,
          instructions: a.instructions,
          worker: a.worker,
          model: a.model,
          workspace: a.workspace,
          timeoutS: a.timeout_s,
          inputs: { ...(a.files ? { files: a.files } : {}), ...(a.refs ? { refs: a.refs } : {}) },
          newSession: a.new_session,
          targetJobId: a.target_job_id,
        }),
      ),
  );

  server.registerTool(
    'job_status',
    {
      description: t.job_status,
      inputSchema: { job_id: z.string() },
    },
    (a) => wrap(() => svc().jobStatus(a.job_id)),
  );

  server.registerTool(
    'job_wait',
    {
      description: t.job_wait,
      inputSchema: {
        job_ids: z.array(z.string()).min(1),
        timeout_s: z.number().int().min(1).max(50).optional(),
        mode: z.enum(['any', 'all']).optional(),
      },
    },
    (a) => wrap(() => svc().jobWait(a.job_ids, a.timeout_s ?? 45, a.mode ?? 'any')),
  );

  server.registerTool(
    'job_result',
    {
      description: t.job_result,
      inputSchema: { job_id: z.string() },
    },
    (a) => wrap(() => svc().jobResult(a.job_id)),
  );

  server.registerTool(
    'job_events',
    {
      description: t.job_events,
      inputSchema: {
        job_id: z.string(),
        since_seq: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
    },
    (a) => wrap(() => svc().jobEvents(a.job_id, a.since_seq ?? 0, a.limit ?? 50)),
  );

  server.registerTool(
    'job_cancel',
    {
      description: t.job_cancel,
      inputSchema: { job_id: z.string(), reason: z.string().min(1) },
    },
    (a) => wrap(() => svc().jobCancel(a.job_id, a.reason)),
  );

  server.registerTool(
    'job_request_changes',
    {
      description: t.job_request_changes,
      inputSchema: {
        job_id: z.string(),
        findings: z.array(finding).min(1),
        instructions: z.string().optional(),
      },
    },
    (a) => wrap(() => svc().jobRequestChanges(a.job_id, a.findings, a.instructions)),
  );

  server.registerTool(
    'job_diff',
    {
      description: t.job_diff,
      inputSchema: { job_id: z.string(), stat_only: z.boolean().optional() },
    },
    (a) => wrap(() => svc().jobDiff(a.job_id, a.stat_only ?? false)),
  );

  server.registerTool(
    'task_accept',
    {
      description: t.task_accept,
      inputSchema: {
        task_id: z.string(),
        job_id: z.string(),
        review_job_id: z.string().optional(),
        verified_by_evidence_reason: z.string().optional().describe(f.verifiedReason),
      },
    },
    (a) =>
      wrap(() =>
        svc().taskAccept(
          a.task_id,
          a.job_id,
          a.review_job_id,
          a.verified_by_evidence_reason ? { reason: a.verified_by_evidence_reason } : undefined,
        ),
      ),
  );

  server.registerTool(
    'task_close',
    {
      description: t.task_close,
      inputSchema: {
        task_id: z.string(),
        outcome: z.enum(['abandoned', 'superseded']),
        note: z.string().min(1),
      },
    },
    (a) => wrap(() => svc().taskClose(a.task_id, a.outcome, a.note)),
  );

  server.registerTool(
    'task_merge',
    {
      description: t.task_merge,
      inputSchema: { task_id: z.string(), target_branch: z.string().optional() },
    },
    (a) => wrap(() => svc().taskMerge(a.task_id, a.target_branch)),
  );

  server.registerTool(
    'workspace_cleanup',
    {
      description: t.workspace_cleanup,
      inputSchema: { task_id: z.string() },
    },
    (a) => wrap(() => svc().workspaceCleanup(a.task_id)),
  );

  const opShape = {
    operation: z.enum([
      'commit',
      'push',
      'pr-create',
      'pr-update',
      'merge',
      'deployment',
      'database-change',
      'security-policy-change',
      'access-control-change',
      'cost-change',
      'irreversible-change',
    ]),
    reason: z.string().min(1),
    task_id: z.string(),
    actor: z.string().default('claude'),
    checkpoint: z.string().describe(f.checkpoint),
    test_evidence: z.string().describe(f.testEvidence),
    sensitive_scan_evidence: z.string().describe(f.scanEvidence),
    tests_passed: z.boolean(),
    user_changes_preserved: z.boolean(),
    sensitive_scan_clean: z.boolean(),
    branch: z.string().optional(),
    base_branch: z.string().optional(),
    commit_hash: z.string().optional(),
    ci_passed: z.boolean().optional(),
    review_completed: z.boolean().optional(),
    branch_protection_satisfied: z.boolean().optional(),
    post_merge_validation_plan: z.string().optional(),
    environment: z.string().optional(),
    service: z.string().optional(),
    artifact_hash: z.string().optional(),
    artifact_evidence: z.string().optional(),
    health_checks_passed: z.boolean().optional(),
    health_checks_evidence: z.string().optional(),
    rollback_plan: z.string().optional(),
    production_policy_id: z.string().optional(),
    risk_tier: z.enum(['low', 'medium', 'high', 'critical']).optional(),
    protected_risk: z
      .enum([
        'none',
        'production-data-loss',
        'irreversible-change',
        'security-policy-change',
        'access-control-change',
        'unplanned-cost',
      ])
      .optional(),
    explicit_user_approval: z.boolean().optional(),
    approval_evidence: z.string().optional(),
  };

  server.registerTool(
    'checkpoint',
    {
      description: t.checkpoint,
      inputSchema: { reason: z.string().min(1), task_id: z.string().optional() },
    },
    (a) => wrap(() => svc().checkpoint(a.reason, a.task_id)),
  );

  server.registerTool(
    'operation_authorize',
    {
      description: t.operation_authorize,
      inputSchema: opShape,
    },
    (a) => wrap(() => svc().operationAuthorize(a)),
  );

  server.registerTool(
    'operation_record',
    {
      description: t.operation_record,
      inputSchema: {
        ...opShape,
        outcome: z.enum(['succeeded', 'failed', 'blocked', 'rolled_back']),
        result_summary: z.string().min(1),
        reference: z.string().optional(),
      },
    },
    (a) => wrap(() => svc().operationRecord(a)),
  );

  server.registerTool(
    'memory_lock',
    {
      description: t.memory_lock,
      inputSchema: {
        mode: z.enum(['acquire', 'release']),
        task_id: z.string().optional(),
        token: z.string().optional(),
      },
    },
    (a) =>
      wrap(() =>
        svc().memoryLock(a.mode, {
          ...(a.task_id ? { taskId: a.task_id } : {}),
          ...(a.token ? { token: a.token } : {}),
        }),
      ),
  );

  server.registerTool(
    'memory_metrics',
    {
      description: t.memory_metrics,
      inputSchema: {
        task_id: z.string().nullable().default(null),
        query_label: z.string(),
        method: z.enum(['lat-cli', 'lat-mcp', 'hook', 'manual']),
        index_status: z.enum(['ready', 'missing', 'stale', 'unknown']),
        query_count: z.number().int().min(0).optional(),
        sections_retrieved: z.number().int().min(0).optional(),
        content_characters: z.number().int().min(0).optional(),
        files_loaded: z.number().int().min(0).optional(),
        input_tokens: z.number().int().min(0).optional(),
        output_tokens: z.number().int().min(0).optional(),
        cache_tokens: z.number().int().min(0).optional(),
        outcome: z.enum(['completed', 'empty', 'stale', 'error', 'manual-fallback']),
      },
    },
    (a) => wrap(() => svc().memoryMetrics(a)),
  );

  server.registerTool(
    'permission_prompt',
    {
      description: t.permission_prompt,
      inputSchema: {
        tool_name: z.string(),
        input: z.record(z.string(), z.unknown()),
        tool_use_id: z.string().optional(),
      },
    },
    async (a) => {
      try {
        const d = await decidePermission(svc().store.paths.anaforDir, a.tool_name, a.input);
        return { content: [{ type: 'text', text: JSON.stringify(d) }] };
      } catch (e) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ behavior: 'deny', message: (e as Error).message }),
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    'evidence_generate',
    {
      description: t.evidence_generate,
      inputSchema: {
        task_id: z.string(),
        test_command: z.string().optional(),
        skip_tests: z.boolean().optional(),
      },
    },
    (a) =>
      wrap(() =>
        svc().evidenceGenerate(a.task_id, {
          ...(a.test_command ? { testCommand: a.test_command } : {}),
          ...(a.skip_tests ? { skipTests: true } : {}),
        }),
      ),
  );

  server.registerTool(
    'takeover_status',
    {
      description: t.takeover_status,
      inputSchema: { task_id: z.string() },
    },
    (a) => wrap(() => svc().takeoverStatus(a.task_id)),
  );

  server.registerTool(
    'task_takeover',
    {
      description: t.task_takeover,
      inputSchema: { task_id: z.string(), reason: z.string().min(10) },
    },
    (a) => wrap(() => svc().taskTakeover(a.task_id, a.reason)),
  );

  server.registerTool(
    'takeover_complete',
    {
      description: t.takeover_complete,
      inputSchema: {
        job_id: z.string(),
        summary: z.string().min(1),
        tests_executed: z.array(z.string()),
        tests_passed: z.number().int().min(0),
        tests_failed: z.number().int().min(0),
        exit_codes: z.array(z.number().int()),
        requirements_completed: z.array(z.string()),
        requirements_missing: z.array(z.string()),
      },
    },
    (a) =>
      wrap(() =>
        svc().takeoverComplete(a.job_id, {
          summary: a.summary,
          testsExecuted: a.tests_executed,
          testsPassed: a.tests_passed,
          testsFailed: a.tests_failed,
          exitCodes: a.exit_codes,
          requirementsCompleted: a.requirements_completed,
          requirementsMissing: a.requirements_missing,
        }),
      ),
  );

  server.registerTool(
    'intervene',
    {
      description: t.intervene,
      inputSchema: {
        reason: z.string().min(10).describe(f.interveneReason),
        paths: z.array(z.string()).min(1).describe(f.intervenePaths),
        ttl_min: z.number().int().min(1).max(30).optional(),
        task_id: z.string().optional(),
      },
    },
    (a) =>
      wrap(() =>
        svc().intervene({
          reason: a.reason,
          paths: a.paths,
          ...(a.ttl_min ? { ttlMin: a.ttl_min } : {}),
          ...(a.task_id ? { taskId: a.task_id } : {}),
        }),
      ),
  );

  server.registerTool(
    'intervene_end',
    {
      description: t.intervene_end,
      inputSchema: { grant_id: z.string(), summary: z.string().min(1) },
    },
    (a) => wrap(() => svc().interveneEnd(a.grant_id, a.summary)),
  );

  return server;
}
