import { defaultAdapters, type AdapterRegistry } from '../adapters/registry.js';
import type { Finding, ReviewLevel, Role, WorkerResultV1 } from '../contracts/worker-result.js';
import { canonicalWorkerId, loadConfig } from '../core/config.js';
import { newId, nowIso } from '../core/ids.js';
import { isAlive, killPidTree } from '../core/process-util.js';
import {
  ACTIVE_JOB_STATES,
  isClosedTaskState,
  isTerminalJobState,
  isJobWaitComplete,
  MAX_CORRECTIONS,
  type JobState,
} from '../core/states.js';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { evaluateAcceptance } from '../core/accept.js';
import { git, headSha, isGitRepo, workDiff } from '../git/git.js';
import {
  branchExists,
  commitWorktree,
  createJobWorktree,
  hasChanges,
  mergeIntoTaskBranch,
  removeWorktree,
  taskBranchName,
} from '../git/worktree.js';
import { balance } from '../capacity/balancer.js';
import { capacityReport, readCosts } from '../capacity/capacity.js';
import { recommend } from '../capacity/meta.js';
import { currentLimits, formatWindows, limitAccount } from '../limits/limits.js';
import { createCheckpoint, readCheckpoint, type CheckpointMeta } from '../governance/checkpoint.js';
import {
  acquireMemoryLock,
  recordMemoryMetric,
  releaseMemoryLock,
  type MemoryMetric,
} from '../governance/memory.js';
import {
  authorizeOperation,
  recordOperation,
  type OperationInput,
  type RecordInput,
} from '../governance/operations.js';
import {
  detectTestCommand,
  canReuseAutoCheck,
  generateScanEvidence,
  generateTestEvidence,
} from '../governance/evidence.js';
import { ensurePolicy } from '../governance/policy.js';
import { activeGrants, createGrant, endGrant } from '../hooks/grants.js';
import { m } from '../i18n/index.js';
import { spawnSync } from 'node:child_process';
import { readLoopState, writeLoopState } from '../loop/state.js';

/** Servis mesaj kataloğu (geçerli dil). */
const s = () => m().service;

function appendTaskAudit(auditDir: string, record: object): void {
  mkdirSync(auditDir, { recursive: true });
  appendFileSync(
    join(auditDir, 'tasks.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n',
  );
}
import { runJob } from '../runner/run-job.js';
import { spawnDetachedRunner } from '../runner/spawn.js';
import { otherProjectLeases } from '../core/leases.js';
import {
  Store,
  StoreError,
  type Job,
  type JobInputs,
  type Priority,
  type Task,
  type WorkspaceMode,
} from '../store/store.js';

export type ServiceErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_STATE'
  | 'WORKER_UNAVAILABLE'
  | 'LIMIT_REACHED'
  | 'VALIDATION_FAILED'
  | 'CONFLICT'
  | 'NOT_IMPLEMENTED'
  | 'NOT_INITIALIZED'
  | 'INTERNAL';

export class ServiceError extends Error {
  constructor(
    readonly code: ServiceErrorCode,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

/** İşin nasıl yürütüleceği: ayrık süreç (varsayılan) veya süreç içi (testler). */
export type Launcher = (store: Store, job: Job) => void;
export type LoopStarter = (
  root: string,
  args: string[],
) => { status: number | null; stderr: string };

export const detachedLauncher: Launcher = (store, job) => {
  const pid = spawnDetachedRunner(store.paths.root, job.id, store.paths.jobDir(job.id));
  store.patchJob(job.id, { pid });
};

export function inProcessLauncher(adapters: AdapterRegistry): Launcher {
  return (store, job) => {
    void runJob(store, job.id, adapters).catch(() => undefined);
  };
}

const DEFAULT_TIMEOUT_S: Record<Role, number> = {
  implementation: 1800,
  review: 900,
  analysis: 900,
  test: 900,
};
const MAX_WAIT_S = 50;
const STALE_START_MS = 2 * 60 * 1000;

/** Yönetici tarafından görülen kısa iş özeti (token tasarrufu: büyük alanlar yok). */
export function jobBrief(j: Job) {
  return {
    job_id: j.id,
    task_id: j.taskId,
    role: j.role,
    worker: j.worker,
    state: j.state,
    correction: j.isCorrection,
    error: j.error,
    result_status: j.result?.status ?? null,
    started_at: j.startedAt,
    ended_at: j.endedAt,
  };
}

export function taskBrief(t: Task) {
  return {
    task_id: t.id,
    title: t.title,
    state: t.state,
    review_level: t.reviewLevel,
    priority: t.priority,
    corrections: t.correctionCount,
  };
}

export interface DispatchInput {
  taskId: string;
  role: Role;
  instructions: string;
  worker?: string | undefined;
  model?: string | undefined;
  workspace?: WorkspaceMode | undefined;
  timeoutS?: number | undefined;
  inputs?: JobInputs | undefined;
  newSession?: boolean | undefined;
  /** review/analysis için başka bir işin çalışma alanını salt okunur incele. */
  targetJobId?: string | undefined;
}

/** MCP araçlarının arkasındaki iş mantığı. Taşıma (MCP) katmanından bağımsızdır. */
export class AnaforService {
  constructor(
    readonly store: Store,
    public adapters: AdapterRegistry,
    private readonly launch: Launcher = detachedLauncher,
    private defaultWorker = 'codex',
    private routing: Partial<Record<Role, string[]>> = {},
    private routingMode: 'static' | 'adaptive' = 'static',
    private maxParallelJobs = 4,
    private readonly startDetachedLoop: LoopStarter = (root, args) => {
      const script = process.argv[1];
      if (!script) return { status: 1, stderr: 'Anafor CLI entry point is unavailable' };
      const result = spawnSync(process.execPath, [script, ...args], {
        cwd: root,
        encoding: 'utf8',
        timeout: 10_000,
      });
      return { status: result.status, stderr: result.stderr ?? '' };
    },
  ) {}

  loopStatus() {
    const state = readLoopState(this.store.paths.root);
    if (!state)
      return { state: 'idle', cycle: 0, paused_reason: null, resume_at: null, backlog: null };
    let total: number | null = null;
    if (state.backlog) {
      try {
        total = readFileSync(join(this.store.paths.root, state.backlog), 'utf8')
          .split(/\r?\n/)
          .filter((line) => /^\s*(?:-\s*\[ \]|\d+[.)])\s+/.test(line)).length;
      } catch {
        total = null;
      }
    }
    return {
      state: state.state,
      cycle: state.cycle,
      paused_reason: state.paused_reason,
      resume_at: state.resume_at,
      backlog: state.backlog ? { completed: state.completed_items.length, total } : null,
    };
  }

  loopStop(mode: 'pause' | 'stop') {
    const state = readLoopState(this.store.paths.root);
    if (!state || !['running', 'paused'].includes(state.state))
      throw new ServiceError('INVALID_STATE', 'No active development loop');
    writeLoopState(this.store.paths.root, {
      ...state,
      state: mode === 'stop' ? 'stopped' : 'paused',
      paused_reason: mode === 'stop' ? 'stopped' : 'manual',
    });
    return {
      state: mode === 'stop' ? 'stopped' : 'paused',
      note: 'Stops after the current turn completes.',
    };
  }

  loopStart(input: {
    goal?: string;
    backlog?: string;
    auto_resume?: boolean;
    max_cycles?: number;
    until?: string;
    accept?: boolean;
    merge?: boolean;
    profile?: string;
  }) {
    const current = readLoopState(this.store.paths.root);
    if (current && ['running', 'paused'].includes(current.state))
      throw new ServiceError('CONFLICT', s().loopAlreadyActive);
    if (!input.goal === !input.backlog)
      throw new ServiceError('VALIDATION_FAILED', 'Provide exactly one of goal or backlog');
    const args = [
      'loop',
      'start',
      ...(input.goal ? [input.goal] : []),
      ...(input.backlog ? ['--backlog', input.backlog] : []),
      '--detach',
      ...(input.auto_resume ? ['--auto-resume'] : []),
      ...(input.max_cycles ? ['--max-cycles', String(input.max_cycles)] : []),
      ...(input.until ? ['--until', input.until] : []),
      ...(input.accept ? ['--accept'] : []),
      ...(input.merge ? ['--merge'] : []),
      ...(input.profile ? ['--profile', input.profile] : []),
    ];
    const result = this.startDetachedLoop(this.store.paths.root, args);
    if (result.status !== 0) throw new ServiceError('CONFLICT', s().loopStartFailed(result.stderr));
    const state = readLoopState(this.store.paths.root);
    return { pid: state?.pid ?? null, ...this.loopStatus() };
  }

  /** Apply config edits for subsequent tool calls; already-started runners keep their own adapter. */
  reloadConfig(): void {
    const config = loadConfig(this.store.paths.root);
    this.adapters = defaultAdapters(config);
    this.defaultWorker = config.default_worker;
    this.routing = config.routing;
    this.routingMode = config.routing_mode;
    this.maxParallelJobs = config.max_parallel_jobs;
  }

  /** Global eşzamanlılık: bu projenin aktif işleri + diğer projelerin canlı runner kiraları. */
  parallelUsage() {
    const project = this.store.listJobs({ states: ACTIVE_JOB_STATES }).length;
    const others = otherProjectLeases(this.store.paths.root).length;
    return { project, other_projects: others, total: project + others, max: this.maxParallelJobs };
  }

  private assertGlobalCapacity(): void {
    const u = this.parallelUsage();
    if (u.total >= u.max) {
      throw new ServiceError(
        'LIMIT_REACHED',
        s().globalLimit(u.max, u.project, u.other_projects),
        s().globalLimitHint,
      );
    }
  }

  /**
   * Router: rol için tercih sırasındaki ilk uygun işçi (erişilebilir, oturum açık, kapasite var).
   * Review işinde hedef işi yapan işçi sona alınır (çapraz model incelemesi).
   */
  /** İşçi oturum/kullanım limitleri (bilinen kaynaklardan; bilinmiyorsa unknown). */
  workersLimits() {
    const ids = [...new Set([...this.adapters.keys()].map(limitAccount))];
    if (!ids.includes('claude')) ids.unshift('claude');
    return ids.map((id) => {
      const l = currentLimits(id);
      if (!l) {
        return {
          worker: id,
          status: 'unknown' as const,
          summary: s().limitsUnknown,
          windows: [],
          observed_at: null,
        };
      }
      return {
        worker: id,
        status: l.status,
        summary: formatWindows(l.windows),
        windows: l.windows,
        observed_at: l.observed_at,
        source: l.source,
      };
    });
  }

  /** Rol başına tercih zinciri (config.routing + varsayılan işçi, kayıtlı olanlar). */
  routingChains(): Record<Role, string[]> {
    const roles: Role[] = ['implementation', 'review', 'analysis', 'test'];
    return Object.fromEntries(
      roles.map((r) => [
        r,
        [...new Set([...(this.routing[r] ?? []), this.defaultWorker])].filter((id) =>
          this.adapters.has(id),
        ),
      ]),
    ) as Record<Role, string[]>;
  }

  private capacitySnapshot(cap: ReturnType<typeof loadConfig>['capacity']) {
    const accounts: Record<string, string[]> = { claude: [s().brainLabel] };
    for (const id of this.adapters.keys()) (accounts[limitAccount(id)] ??= []).push(id);
    const limits = Object.fromEntries(Object.keys(accounts).map((a) => [a, currentLimits(a)]));
    return capacityReport({
      accounts,
      limits,
      costs: readCosts(),
      routing: this.routingChains(),
      accountOf: limitAccount,
      cfg: cap,
    });
  }

  /** Son yönlendirme kararının açıklaması (job_dispatch uyarılarına eklenir). */
  private routeNotes: string[] = [];

  /** Kapasite modeli (KP), ipuçları ve aboneliklere göre önerilen rol dağılımı. */
  capacityStatus() {
    const cfg = loadConfig(this.store.paths.root);
    const report = this.capacitySnapshot(cfg.capacity);
    return {
      ...report,
      unit: s().capacityUnit,
      subscriptions: cfg.subscriptions,
      recommendation: cfg.subscriptions.length ? recommend(cfg.subscriptions) : null,
    };
  }

  /** Limiti dolmuş (sıfırlanma zamanı gelmemiş) işçi mi? */
  private limited(workerId: string): string | null {
    const l = currentLimits(limitAccount(workerId));
    if (!l) return null;
    const now = Date.now() / 1000;
    const full = l.windows.find(
      (w) => w.used_percent >= 100 && (w.resets_at === null || w.resets_at > now),
    );
    return full ? s().windowFull(workerId, full.name, full.used_percent) : null;
  }

  async route(role: Role, target: Job | null): Promise<string> {
    let order = [...new Set([...(this.routing[role] ?? []), this.defaultWorker])].filter((id) =>
      this.adapters.has(id),
    );
    if (this.routingMode === 'adaptive') {
      const stats = this.workerStats(role);
      const byWorker = new Map(stats.map((s) => [s.worker, s]));
      const eligiblePositions = order
        .map((worker, index) => ({ worker, index, stats: byWorker.get(worker) }))
        .filter((entry) => (entry.stats?.finished ?? 0) >= 3);
      const ranked = [...eligiblePositions].sort(
        (a, b) => b.stats!.acceptance_rate - a.stats!.acceptance_rate,
      );
      for (let i = 0; i < eligiblePositions.length; i++) {
        order[eligiblePositions[i]!.index] = ranked[i]!.worker;
      }
    }
    if (role === 'review' && target) {
      order = [
        ...order.filter((w) => w !== target.worker),
        ...order.filter((w) => w === target.worker),
      ];
    }
    this.routeNotes = [];
    const cfg = loadConfig(this.store.paths.root);
    if (cfg.balancer.strategy !== 'off' && order.length > 1) {
      const b = balance(
        role,
        order.map((worker) => ({
          worker,
          account: limitAccount(worker),
          costTier: this.adapters.get(worker)!.capabilities().costTier,
        })),
        this.capacitySnapshot(cfg.capacity).accounts,
        cfg.balancer.strategy,
        cfg.capacity.pace_threshold,
      );
      order = b.order;
      this.routeNotes = b.notes;
    }
    const reasons: string[] = [];
    for (const id of order) {
      const a = this.adapters.get(id)!;
      if (!a.capabilities().roles.includes(role)) continue;
      const d = await a.detect();
      if (!d.available || d.authOk === false) {
        reasons.push(`${id}: ${d.reason ?? s().unavailable}`);
        continue;
      }
      const lim = this.limited(id);
      if (lim) {
        reasons.push(lim);
        continue;
      }
      const running = this.store
        .listJobs({ states: ACTIVE_JOB_STATES })
        .filter((j) => j.worker === id).length;
      if (running >= a.capabilities().maxConcurrency) {
        reasons.push(s().capacityFull(id));
        continue;
      }
      return id;
    }
    throw new ServiceError(
      'WORKER_UNAVAILABLE',
      s().noWorker(role),
      reasons.join('; ') || s().noWorkerHint,
    );
  }

  // ---- keşif ----

  async workersList() {
    return Promise.all(
      [...this.adapters.values()].map(async (a) => {
        const d = await a.detect();
        const c = a.capabilities();
        const running = this.store
          .listJobs({ states: ACTIVE_JOB_STATES })
          .filter((j) => j.worker === a.id).length;
        return {
          id: a.id,
          available: d.available,
          auth_ok: d.authOk ?? null,
          version: d.version ?? null,
          reason: d.reason ?? null,
          roles: c.roles,
          cost_tier: c.costTier,
          max_concurrency: c.maxConcurrency,
          experimental: c.experimental ?? false,
          running,
        };
      }),
    );
  }

  /** Tamamlanmış işlerin işçi/rol bazındaki kabul, hata, süre ve token istatistikleri. */
  workerStats(role?: Role) {
    const finishedStates = new Set([
      'approved',
      'merged',
      'changes_requested',
      'failed',
      'timed_out',
      'invalid_output',
    ]);
    const groups = new Map<string, Job[]>();
    for (const job of this.store.listJobs()) {
      if (
        job.worker === 'director' ||
        (role && job.role !== role) ||
        !finishedStates.has(job.state)
      )
        continue;
      const key = `${canonicalWorkerId(job.worker)}\0${job.role}`;
      groups.set(key, [...(groups.get(key) ?? []), job]);
    }
    return [...groups.values()].map((jobs) => {
      const accepted = jobs.filter((j) => j.state === 'approved' || j.state === 'merged').length;
      const seconds = jobs.flatMap((j) => {
        if (!j.startedAt || !j.endedAt) return [];
        const duration = (Date.parse(j.endedAt) - Date.parse(j.startedAt)) / 1000;
        return Number.isFinite(duration) && duration >= 0 ? [duration] : [];
      });
      const inputs = jobs.flatMap((j) =>
        j.usage?.inputTokens === undefined ? [] : [j.usage.inputTokens],
      );
      const outputs = jobs.flatMap((j) =>
        j.usage?.outputTokens === undefined ? [] : [j.usage.outputTokens],
      );
      const mean = (values: number[]) =>
        values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
      return {
        worker: canonicalWorkerId(jobs[0]!.worker),
        role: jobs[0]!.role,
        finished: jobs.length,
        accepted,
        failed: jobs.filter((j) => ['failed', 'timed_out', 'invalid_output'].includes(j.state))
          .length,
        changes_requested: jobs.filter((j) => j.state === 'changes_requested').length,
        acceptance_rate: jobs.length ? accepted / jobs.length : 0,
        avg_duration_s: mean(seconds),
        avg_input_tokens: mean(inputs),
        avg_output_tokens: mean(outputs),
      };
    });
  }

  projectStatus() {
    const tasks = this.store.listTasks();
    const active = this.store.listJobs({ states: ACTIVE_JOB_STATES });
    const review = this.store.listJobs({ states: ['needs_review'] });
    const recent = this.store
      .listTasks({ includeClosed: true })
      .filter((t) => isClosedTaskState(t.state))
      .slice(0, 5);
    return {
      project_root: this.store.paths.root,
      open_tasks: tasks.map(taskBrief),
      active_jobs: active.map(jobBrief),
      jobs_needing_review: review.map(jobBrief),
      recently_closed: recent.map(taskBrief),
      parallel: this.parallelUsage(),
    };
  }

  // ---- görev ----

  taskCreate(input: {
    title: string;
    objective: string;
    acceptanceCriteria?: string[] | undefined;
    constraints?: string[] | undefined;
    contextRefs?: string[] | undefined;
    reviewLevel?: ReviewLevel | undefined;
    priority?: Priority | undefined;
  }) {
    const t = this.store.createTask({
      title: input.title,
      objective: input.objective,
      acceptanceCriteria: input.acceptanceCriteria ?? [],
      constraints: input.constraints ?? [],
      contextRefs: input.contextRefs ?? [],
      reviewLevel: input.reviewLevel ?? 'standard',
      priority: input.priority ?? 'normal',
    });
    return taskBrief(t);
  }

  taskStatus(taskId: string) {
    const t = this.mustTask(taskId);
    return {
      ...taskBrief(t),
      objective: t.objective,
      acceptance_criteria: t.acceptanceCriteria,
      note: t.note,
      jobs: this.store.listJobs({ taskId }).map(jobBrief),
      takeover: (({ eligible, reasons }) => ({ eligible, reasons }))(this.takeoverStatus(taskId)),
    };
  }

  // ---- iş ----

  async jobDispatch(input: DispatchInput) {
    const task = this.mustTask(input.taskId);
    if (isClosedTaskState(task.state) || task.state === 'blocked') {
      throw new ServiceError('INVALID_STATE', s().taskStateBad(task.id, task.state));
    }
    const target = input.targetJobId ? this.mustJob(input.targetJobId) : null;
    this.routeNotes = [];
    const workerId = input.worker
      ? canonicalWorkerId(input.worker)
      : await this.route(input.role, target);
    const routeNotes = this.routeNotes;
    const adapter = this.adapters.get(workerId);
    if (!adapter) {
      throw new ServiceError(
        'WORKER_UNAVAILABLE',
        s().unknownWorker(workerId),
        s().availableWorkers([...this.adapters.keys()].join(', ')),
      );
    }
    const caps = adapter.capabilities();
    if (!caps.roles.includes(input.role)) {
      throw new ServiceError('VALIDATION_FAILED', s().roleUnsupported(workerId, input.role));
    }
    this.assertGlobalCapacity();
    const det = await adapter.detect();
    if (!det.available || det.authOk === false) {
      throw new ServiceError(
        'WORKER_UNAVAILABLE',
        s().workerUnavailable(workerId, det.reason ?? s().unknown),
      );
    }
    const running = this.store
      .listJobs({ states: ACTIVE_JOB_STATES })
      .filter((j) => j.worker === workerId).length;
    if (running >= caps.maxConcurrency) {
      throw new ServiceError(
        'LIMIT_REACHED',
        s().workerLimit(workerId, caps.maxConcurrency),
        s().workerLimitHint,
      );
    }

    const root = this.store.paths.root;
    const repoReady = isGitRepo(root) && headSha(root) !== null;
    const writes = input.role === 'implementation' || input.role === 'test';
    const workspace: WorkspaceMode =
      input.workspace ??
      (target ? 'readonly' : writes ? (repoReady ? 'worktree' : 'shared') : 'readonly');
    if (workspace === 'worktree' && !repoReady) {
      throw new ServiceError('VALIDATION_FAILED', s().worktreeNeedsRepo, s().worktreeNeedsRepoHint);
    }
    if (workspace === 'shared') {
      const writer = this.store
        .listJobs({ states: ACTIVE_JOB_STATES })
        .find((j) => j.workspaceMode === 'shared');
      if (writer) {
        throw new ServiceError('CONFLICT', s().sharedWriter(writer.id), s().sharedWriterHint);
      }
    }

    // Oturum ve çalışma alanı sürekliliği: worktree'de devam, önceki işin worktree'sinde olur.
    let sessionRef =
      input.newSession || !caps.resume
        ? null
        : this.store.getSession(task.id, input.role, workerId);
    let reuse: Job | null = null;
    if (workspace === 'worktree' && sessionRef) {
      reuse =
        this.store
          .listJobs({ taskId: task.id })
          .filter(
            (j) =>
              j.role === input.role &&
              j.worker === workerId &&
              j.workspaceMode === 'worktree' &&
              j.sessionRef === sessionRef &&
              !['merged', 'cancelled'].includes(j.state) &&
              existsSync(j.workdir),
          )
          .pop() ?? null;
      if (!reuse) sessionRef = null; // yeni worktree = yeni oturum
    }

    const jobId = newId('J');
    let workdir = root;
    let branch: string | null = null;
    let baseSha = headSha(root);
    if (target) {
      workdir = target.workdir;
      baseSha = target.baseSha;
    } else if (workspace === 'worktree') {
      if (reuse) {
        workdir = reuse.workdir;
        branch = reuse.branch;
        baseSha = reuse.baseSha;
      } else {
        try {
          const wt = createJobWorktree(root, this.store.paths.worktreesDir, task.id, jobId);
          workdir = wt.path;
          branch = wt.branch;
          baseSha = wt.base;
        } catch (e) {
          throw new ServiceError('INTERNAL', s().worktreeFailed((e as Error).message));
        }
      }
    }

    const job = this.store.createJob({
      id: jobId,
      taskId: task.id,
      role: input.role,
      worker: workerId,
      model: input.model ?? null,
      workspaceMode: workspace,
      workdir,
      branch,
      sessionRef,
      instructions: input.instructions,
      inputs: {
        ...(input.inputs ?? {}),
        ...(target && (input.role === 'review' || input.role === 'analysis')
          ? {
              reviewContext: {
                diffSummary: `Files: ${target.result?.changed_files.join(', ') || '(none)'}\n${workDiff(target.workdir, target.baseSha).stat}`,
                autoCheck: target.autoCheck,
              },
            }
          : {}),
      },
      timeoutS: input.timeoutS ?? DEFAULT_TIMEOUT_S[input.role],
      baseSha,
    });
    if (task.state === 'open' || task.state === 'in_review') {
      this.store.updateTask(task.id, { state: 'in_progress' });
    }
    const warnings: string[] = [];
    if (routeNotes.length) {
      this.store.appendEvent(job.id, 'route', routeNotes.join('; '));
      warnings.push(...routeNotes);
    }
    if (workspace === 'shared') {
      const dirty = git(this.store.paths.root, ['status', '--porcelain'])
        .stdout.split('\n')
        .filter((l) => l.trim() && !l.includes('.anafor/'));
      if (dirty.length) {
        warnings.push(s().dirtyShared(dirty.length));
      }
    }
    this.startJob(job);
    return {
      ...jobBrief(this.store.mustGetJob(job.id)),
      resumed_session: sessionRef !== null,
      warnings,
    };
  }

  /** İşin çalışma alanı farkı. Patch dosyaya yazılır; küçükse satır içi döner (token tasarrufu). */
  jobDiff(jobId: string, statOnly = false) {
    const j = this.mustJob(jobId);
    if (!isGitRepo(j.workdir)) {
      throw new ServiceError('VALIDATION_FAILED', s().notGitRepo);
    }
    const d = workDiff(j.workdir, j.baseSha);
    const dir = this.store.paths.jobDir(jobId);
    mkdirSync(dir, { recursive: true });
    const patchFile = join(dir, 'diff.patch');
    writeFileSync(patchFile, d.patch);
    const claimed = j.result?.changed_files ?? [];
    const norm = (p: string) =>
      (isAbsolute(p) ? relative(j.workdir, p) : p).replace(/\\/g, '/').replace(/^\.\//, '');
    const actual = new Set(d.changedFiles.map(norm));
    const notClaimed = [...actual].filter((f) => !claimed.map(norm).includes(f));
    const claimedMissing = claimed.map(norm).filter((f) => !actual.has(f));
    const INLINE_LIMIT = 12_000;
    return {
      job_id: jobId,
      base: d.base,
      changed_files: [...actual],
      untracked: d.untracked,
      stat: d.stat,
      patch_file: patchFile,
      patch: statOnly || d.patch.length > INLINE_LIMIT ? null : d.patch,
      patch_truncated: !statOnly && d.patch.length > INLINE_LIMIT,
      mismatch: {
        changed_but_not_reported: notClaimed,
        reported_but_unchanged: claimedMissing,
      },
    };
  }

  /** Kabul kapıları; geçerse iş approved, görev accepted. Kapı hatası araç hatası değildir. */
  taskAccept(taskId: string, jobId: string, reviewJobId?: string, verify?: { reason: string }) {
    const task = this.mustTask(taskId);
    const job = this.mustJob(jobId);
    const reviewJob = reviewJobId ? this.mustJob(reviewJobId) : null;
    const gates = evaluateAcceptance({
      task,
      job,
      taskJobs: this.store.listJobs({ taskId }),
      reviewJob,
      projectRoot: this.store.paths.root,
      verifiedByEvidence: verify ? this.evidenceVerdict(taskId, job, verify.reason) : null,
      autoCheck: job.autoCheck,
    });
    // Worktree işi: değişiklikleri iş dalına commit et ve görev dalına birleştir.
    let integration: { task_branch: string; commit: string | null } | null = null;
    if (gates.every((g) => g.ok) && job.workspaceMode === 'worktree' && job.branch) {
      try {
        commitWorktree(
          job.workdir,
          `${task.title}\n\nAnafor-Task: ${task.id}\nAnafor-Job: ${job.id}\nAnafor-Worker: ${job.worker}`,
        );
        const m = mergeIntoTaskBranch(
          this.store.paths.root,
          this.store.paths.worktreesDir,
          task.id,
          job.branch,
          `anafor: ${task.title} (${job.id})`,
        );
        gates.push({
          gate: 'merge_into_task_branch',
          ok: m.merged,
          detail: m.merged
            ? `${m.taskBranch} ← ${job.branch}`
            : s().mergeConflict(m.conflicts.join(', ')),
        });
        if (m.merged) integration = { task_branch: m.taskBranch, commit: m.commit };
      } catch (e) {
        gates.push({ gate: 'merge_into_task_branch', ok: false, detail: (e as Error).message });
      }
    }
    const failed = gates.filter((g) => !g.ok);
    if (failed.length === 0) {
      this.guard(() => this.store.transitionJob(job.id, 'approved'));
      if (integration) this.guard(() => this.store.transitionJob(job.id, 'merged'));
      if (reviewJob && reviewJob.state === 'needs_review') {
        this.guard(() => this.store.transitionJob(reviewJob.id, 'approved'));
      }
      this.store.updateTask(taskId, { state: 'accepted', note: s().acceptedNote(job.id) });
      appendTaskAudit(this.store.paths.auditDir, {
        event: 'task_accepted',
        task_id: taskId,
        job_id: jobId,
        review_job_id: reviewJobId ?? null,
        integration,
        gates,
      });
    }
    return {
      task_id: taskId,
      accepted: failed.length === 0,
      failed_gates: failed,
      passed_gates: gates.filter((g) => g.ok).map((g) => g.gate),
      integration,
      note: failed.length
        ? s().gatesFailedNote
        : integration
          ? s().acceptedOnBranch(integration.task_branch)
          : s().acceptedPlain,
    };
  }

  /**
   * Anafor'un kendi kanıtı: işin bitişinden SONRA üretilmiş, testleri geçen ve taraması temiz
   * kanıt dosyaları. İşçi beyanı yerine nesnel doğrulama (ör. işçi sandbox'ı test çalıştıramadığında).
   */
  private evidenceVerdict(
    taskId: string,
    job: Job,
    reason: string,
  ): { ok: boolean; detail: string } {
    if (!reason.trim()) return { ok: false, detail: s().verifyReasonRequired };
    const dir = join(this.store.paths.anaforDir, 'evidence');
    const testsF = join(dir, `${taskId}-tests.txt`);
    const scanF = join(dir, `${taskId}-scan.txt`);
    if (!existsSync(testsF) || !existsSync(scanF)) {
      return { ok: false, detail: s().noEvidence };
    }
    const after = job.endedAt ? Date.parse(job.endedAt) : 0;
    const fresh = [testsF, scanF].every((f) => statSync(f).mtimeMs >= after);
    const testsOk = /^çıkış kodu: 0\b/m.test(readFileSync(testsF, 'utf8'));
    const scanOk = /^sonuç: temiz$/m.test(readFileSync(scanF, 'utf8'));
    const ok = fresh && testsOk && scanOk;
    appendTaskAudit(this.store.paths.auditDir, {
      event: 'accept_verified_by_evidence',
      task_id: taskId,
      job_id: job.id,
      reason,
      fresh,
      tests_ok: testsOk,
      scan_ok: scanOk,
    });
    return {
      ok,
      detail: ok ? s().evidenceOk(reason) : s().evidenceWeak(fresh, testsOk, scanOk),
    };
  }

  /**
   * Kabul edilmiş görevin dalını kullanıcının dalına birleştirir. Yalnızca proje çalışma ağacı
   * temizken; çakışmada geri alınır. Kullanıcı değişikliklerine asla dokunmaz.
   */
  taskMerge(taskId: string, targetBranch?: string) {
    const task = this.mustTask(taskId);
    if (task.state !== 'accepted') {
      throw new ServiceError(
        'INVALID_STATE',
        s().taskNotAccepted(task.state),
        s().taskNotAcceptedHint,
      );
    }
    const root = this.store.paths.root;
    const branch = taskBranchName(taskId);
    if (!branchExists(root, branch)) {
      throw new ServiceError('NOT_FOUND', s().noTaskBranch(branch));
    }
    const current = git(root, ['branch', '--show-current']).stdout.trim();
    const target = targetBranch ?? current;
    if (target !== current) {
      throw new ServiceError(
        'VALIDATION_FAILED',
        s().targetMismatch(target, current),
        s().targetMismatchHint,
      );
    }
    // Yalnızca izlenen dosyalardaki değişiklikler engeller. İzlenmeyen dosyalar (ör. kanıtlar)
    // birleştirmeyi etkilemez; üzerlerine yazılacaksa git birleştirmeyi kendisi reddeder.
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no'])
      .stdout.split('\n')
      .filter((l) => l.trim() && !l.includes('.anafor/'));
    if (dirty.length) {
      throw new ServiceError('CONFLICT', s().dirtyMerge(dirty.length), s().dirtyMergeHint);
    }
    const before = headSha(root);
    const email = git(root, ['config', 'user.email']).stdout.trim();
    const id = email ? [] : ['-c', 'user.name=Anafor', '-c', 'user.email=anafor@localhost'];
    const r = git(root, [
      ...id,
      'merge',
      '--no-ff',
      '--no-edit',
      '-m',
      `anafor: ${task.title} (${task.id})`,
      branch,
    ]);
    if (r.code !== 0) {
      const conflicts = git(root, ['diff', '--name-only', '--diff-filter=U'])
        .stdout.split('\n')
        .filter(Boolean);
      git(root, ['merge', '--abort']);
      return { merged: false, target, conflicts, note: s().mergeAborted };
    }
    const after = headSha(root);
    appendTaskAudit(this.store.paths.auditDir, {
      event: 'task_merged',
      task_id: taskId,
      target,
      before,
      after,
    });
    return {
      merged: true,
      target,
      before,
      after,
      note: s().revertHint(after),
    };
  }

  /**
   * Biten işlerin worktree'lerini ve birleşmiş dallarını temizler.
   * Aktif/incelemedeki işlerin veya kaydedilmemiş değişiklik içeren worktree'lere dokunmaz.
   */
  workspaceCleanup(taskId: string) {
    const task = this.mustTask(taskId);
    const root = this.store.paths.root;
    const jobs = this.store.listJobs({ taskId }).filter((j) => j.workspaceMode === 'worktree');
    const busy = new Set(
      jobs
        .filter((j) => [...ACTIVE_JOB_STATES, 'needs_review', 'approved'].includes(j.state))
        .map((j) => j.workdir),
    );
    const removed: string[] = [];
    const kept: { path: string; reason: string }[] = [];
    for (const path of new Set(jobs.map((j) => j.workdir))) {
      if (busy.has(path)) {
        kept.push({ path, reason: s().keptBusy });
        continue;
      }
      if (!existsSync(path)) continue;
      if (hasChanges(path)) {
        kept.push({ path, reason: s().keptDirty });
        continue;
      }
      const owner = jobs.find((j) => j.workdir === path);
      const merged = owner?.state === 'merged';
      try {
        removeWorktree(root, path, owner?.branch ?? null, merged);
        removed.push(path);
      } catch (e) {
        kept.push({ path, reason: (e as Error).message });
      }
    }
    if (isClosedTaskState(task.state)) {
      const integ = join(this.store.paths.worktreesDir, `_task-${taskId}`);
      if (existsSync(integ)) {
        try {
          removeWorktree(root, integ, null, false);
          removed.push(integ);
        } catch (e) {
          kept.push({ path: integ, reason: (e as Error).message });
        }
      }
    }
    return { task_id: taskId, removed, kept };
  }

  taskClose(taskId: string, outcome: 'abandoned' | 'superseded', note: string) {
    const task = this.mustTask(taskId);
    if (isClosedTaskState(task.state)) {
      throw new ServiceError('INVALID_STATE', s().taskClosed(task.state));
    }
    const active = this.store.listJobs({ taskId, states: ACTIVE_JOB_STATES });
    if (active.length) {
      throw new ServiceError(
        'CONFLICT',
        s().activeJobs(active.map((j) => j.id).join(', ')),
        s().activeJobsHint,
      );
    }
    const t = this.store.updateTask(taskId, { state: outcome, note });
    appendTaskAudit(this.store.paths.auditDir, {
      event: 'task_closed',
      task_id: taskId,
      outcome,
      note,
    });
    return taskBrief(t);
  }

  jobStatus(jobId: string) {
    const j = this.mustJob(jobId);
    const events = this.store.listEvents(jobId, 0, 1000).slice(-5);
    const elapsed = j.startedAt
      ? Math.round(
          ((j.endedAt ? Date.parse(j.endedAt) : Date.now()) - Date.parse(j.startedAt)) / 1000,
        )
      : 0;
    return {
      ...jobBrief(j),
      elapsed_s: elapsed,
      last_events: events.map((e) => `${e.seq} ${e.type}: ${e.summary}`),
    };
  }

  async jobWait(jobIds: string[], timeoutS = 45, mode: 'any' | 'all' = 'any') {
    for (const id of jobIds) this.mustJob(id);
    const deadline = Date.now() + Math.min(Math.max(timeoutS, 1), MAX_WAIT_S) * 1000;
    for (;;) {
      const jobs = jobIds.map((id) => this.store.mustGetJob(id));
      const done = jobs.filter((j) => isJobWaitComplete(j.state));
      const pending = jobs.filter((j) => !isJobWaitComplete(j.state));
      const satisfied = mode === 'any' ? done.length > 0 : pending.length === 0;
      if (satisfied || Date.now() >= deadline) {
        return {
          finished: done.map(jobBrief),
          still_running: pending.map((j) => j.id),
          timed_out_waiting: !satisfied,
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  jobResult(jobId: string) {
    const j = this.mustJob(jobId);
    const dir = this.store.paths.jobDir(jobId);
    const diff = this.jobDiffSummary(jobId);
    return {
      ...jobBrief(j),
      result: j.result,
      auto_check: j.autoCheck,
      diff,
      warnings: j.warnings,
      usage: j.usage,
      artifacts: {
        dir,
        prompt: `${dir}/prompt.md`,
        events: `${dir}/events.jsonl`,
        stdout: `${dir}/stdout.log`,
        stderr: `${dir}/stderr.log`,
      },
    };
  }

  private jobDiffSummary(jobId: string) {
    const job = this.mustJob(jobId);
    if (!isGitRepo(job.workdir))
      return {
        changed_files: [],
        stat: '',
        mismatch: { changed_but_not_reported: [], reported_but_unchanged: [] },
      };
    const d = this.jobDiff(jobId, true);
    return { changed_files: d.changed_files, stat: d.stat, mismatch: d.mismatch };
  }

  jobEvents(jobId: string, sinceSeq = 0, limit = 50) {
    this.mustJob(jobId);
    return this.store.listEvents(jobId, sinceSeq, Math.min(limit, 200));
  }

  jobCancel(jobId: string, reason: string) {
    const j = this.mustJob(jobId);
    if (!ACTIVE_JOB_STATES.includes(j.state)) {
      throw new ServiceError('INVALID_STATE', s().jobNotActive(jobId, j.state));
    }
    // Önce durum (runner yarışta geri çekilir), sonra süreç.
    const cancelled = this.guard(() =>
      this.store.transitionJob(jobId, 'cancelled', {
        error: s().cancelError(reason),
        endedAt: nowIso(),
      }),
    );
    if (j.pid) killPidTree(j.pid);
    this.store.appendEvent(jobId, 'cancel', reason);
    this.settleTask(j.taskId);
    return jobBrief(cancelled);
  }

  /** İncelemede bulunan sorunlar için aynı işçi oturumunda düzeltme işi açar. */
  async jobRequestChanges(jobId: string, findings: Finding[], instructions?: string) {
    const j = this.mustJob(jobId);
    if (j.state !== 'needs_review') {
      throw new ServiceError('INVALID_STATE', s().jobNotInReview(jobId, j.state));
    }
    const task = this.mustTask(j.taskId);
    if (task.correctionCount >= MAX_CORRECTIONS) {
      this.store.updateTask(task.id, {
        state: 'blocked',
        note: s().correctionLimitNote(MAX_CORRECTIONS),
      });
      throw new ServiceError(
        'LIMIT_REACHED',
        s().correctionLimit(task.id, MAX_CORRECTIONS),
        s().correctionLimitHint,
      );
    }
    this.guard(() => this.store.transitionJob(jobId, 'changes_requested'));
    this.store.updateTask(task.id, { correctionCount: task.correctionCount + 1 });
    const job = this.store.createJob({
      taskId: task.id,
      role: j.role,
      worker: j.worker,
      model: j.model,
      workspaceMode: j.workspaceMode,
      workdir: j.workdir,
      branch: j.branch,
      baseSha: j.baseSha,
      sessionRef: j.sessionRef,
      parentJobId: j.id,
      isCorrection: true,
      instructions: instructions ?? `Önceki işin (${j.id}) incelemesinde bulunan sorunları düzelt.`,
      inputs: { ...j.inputs, findings },
      timeoutS: j.timeoutS,
    });
    this.store.updateTask(task.id, { state: 'in_progress' });
    this.startJob(job);
    return {
      ...jobBrief(this.store.mustGetJob(job.id)),
      correction_number: task.correctionCount + 1,
    };
  }

  /**
   * Sunucu açılışında: yarım kalmış işleri uzlaştırır. Asla yeniden çalıştırmaz.
   */
  reconcile(): string[] {
    const notes: string[] = [];
    for (const j of this.store.listJobs({ states: ['starting', 'running', 'validating'] })) {
      if (j.worker === 'director') continue; // devralma işi süreç değil, yöneticinin kendisi
      const age = Date.now() - Date.parse(j.updatedAt);
      const alive = j.pid ? isAlive(j.pid) : age < STALE_START_MS;
      if (!alive) {
        this.guard(() =>
          this.store.transitionJob(j.id, 'failed', {
            error: s().orphaned,
            endedAt: nowIso(),
          }),
        );
        this.settleTask(j.taskId);
        notes.push(`${j.id} → failed (orphaned)`);
      }
    }
    return notes;
  }

  // ---- yönetişim (eski orchestrator.ps1 karşılıkları) ----

  private get checkpointsDir() {
    return join(this.store.paths.anaforDir, 'checkpoints');
  }
  private get memoryDir() {
    return join(this.store.paths.anaforDir, 'memory');
  }

  checkpoint(reason: string, taskId?: string, actor = 'claude') {
    if (taskId) this.mustTask(taskId);
    try {
      return createCheckpoint(this.store.paths.root, this.checkpointsDir, {
        projectId: this.store.paths.projectId,
        taskId: taskId ?? null,
        actor,
        reason,
      });
    } catch (e) {
      throw new ServiceError('VALIDATION_FAILED', (e as Error).message);
    }
  }

  operationAuthorize(input: OperationInput) {
    this.mustTask(input.task_id);
    const policy = ensurePolicy(this.store.paths.anaforDir, this.store.paths.projectId);
    let cp: CheckpointMeta | null = null;
    const reasons: string[] = [];
    try {
      cp = readCheckpoint(this.store.paths.root, this.checkpointsDir, input.checkpoint);
    } catch (e) {
      reasons.push((e as Error).message);
    }
    const impl = this.store
      .listJobs({ taskId: input.task_id })
      .filter((j) => j.role === 'implementation' && j.endedAt);
    reasons.push(
      ...authorizeOperation(input, {
        root: this.store.paths.root,
        projectId: this.store.paths.projectId,
        policy,
        checkpoint: cp,
        lastImplementationAt: impl.length ? impl[impl.length - 1]!.endedAt : null,
      }).filter((r) => !(cp === null && r.startsWith('Önce checkpoint'))),
    );
    return {
      authorized: reasons.length === 0,
      operation: input.operation,
      task_id: input.task_id,
      reasons,
      note: reasons.length ? s().unauthorizedNote : s().authorizedNote,
    };
  }

  operationRecord(input: RecordInput) {
    this.mustTask(input.task_id);
    try {
      readCheckpoint(this.store.paths.root, this.checkpointsDir, input.checkpoint);
      return {
        recorded: true,
        ...recordOperation(this.store.paths.auditDir, input, {
          root: this.store.paths.root,
          projectId: this.store.paths.projectId,
        }),
      };
    } catch (e) {
      throw new ServiceError('VALIDATION_FAILED', (e as Error).message);
    }
  }

  memoryLock(
    mode: 'acquire' | 'release',
    opts: { taskId?: string; token?: string; actor?: string },
  ) {
    try {
      if (mode === 'acquire') {
        const l = acquireMemoryLock(this.memoryDir, {
          projectId: this.store.paths.projectId,
          taskId: opts.taskId ?? null,
          actor: opts.actor ?? 'claude',
        });
        return {
          acquired: true,
          token: l.token,
          note: s().lockReleaseNote,
        };
      }
      if (!opts.token) throw new Error(s().releaseNeedsToken);
      const l = releaseMemoryLock(this.memoryDir, this.store.paths.projectId, opts.token);
      return { released: true, task_id: l.task_id };
    } catch (e) {
      throw new ServiceError('CONFLICT', (e as Error).message);
    }
  }

  memoryMetrics(m: MemoryMetric) {
    try {
      recordMemoryMetric(this.memoryDir, this.store.paths.projectId, m);
      return { recorded: true };
    } catch (e) {
      throw new ServiceError('VALIDATION_FAILED', (e as Error).message);
    }
  }

  // ---- görev devralma (işçiler tekrar tekrar başarısız olursa) ----

  /** Devralma koşulları: başarısız iş sayısı eşiği, görev blocked veya takılı kalmış iş. */
  takeoverStatus(taskId: string) {
    const task = this.mustTask(taskId);
    const esc = loadConfig(this.store.paths.root).escalation;
    const jobs = this.store.listJobs({ taskId }).filter((j) => j.worker !== 'director');
    const failed = jobs.filter((j) =>
      ['failed', 'timed_out', 'invalid_output', 'changes_requested'].includes(j.state),
    );
    const stalled = jobs.filter(
      (j) =>
        ACTIVE_JOB_STATES.includes(j.state) &&
        j.startedAt !== null &&
        Date.now() - Date.parse(j.startedAt) > esc.stall_minutes * 60_000,
    );
    const reasons: string[] = [];
    if (failed.length >= esc.failure_threshold)
      reasons.push(s().takeoverFailed(failed.length, esc.failure_threshold));
    if (task.state === 'blocked') reasons.push(s().takeoverBlocked);
    if (stalled.length) reasons.push(s().takeoverStalled(stalled.length, esc.stall_minutes));
    return {
      task_id: taskId,
      eligible: reasons.length > 0,
      reasons,
      failed_jobs: failed.map((j) => `${j.id}:${j.state}`),
      thresholds: esc,
    };
  }

  /**
   * Yönetici görevi devralır: aktif işler iptal edilir, son worktree'de (yoksa yeni) bir
   * `director` işi açılır ve yalnızca o worktree için süreli düzenleme izni verilir.
   */
  taskTakeover(taskId: string, reason: string) {
    const st = this.takeoverStatus(taskId);
    if (!st.eligible) {
      throw new ServiceError(
        'INVALID_STATE',
        s().takeoverNotEligible(st.failed_jobs.length, st.thresholds.failure_threshold),
        s().takeoverNotEligibleHint,
      );
    }
    if (!reason.trim()) throw new ServiceError('VALIDATION_FAILED', s().takeoverReasonRequired);
    const task = this.mustTask(taskId);
    const root = this.store.paths.root;
    for (const j of this.store.listJobs({ taskId, states: ACTIVE_JOB_STATES })) {
      if (j.worker !== 'director') this.jobCancel(j.id, s().takeoverCancel(reason));
    }
    const prev = this.store
      .listJobs({ taskId })
      .filter(
        (j) =>
          j.workspaceMode === 'worktree' &&
          j.branch &&
          existsSync(j.workdir) &&
          j.state !== 'merged',
      )
      .pop();
    const jobId = newId('J');
    let workdir = root;
    let branch: string | null = null;
    let baseSha = headSha(root);
    let mode: WorkspaceMode = 'shared';
    if (prev) {
      ({ workdir, branch, baseSha } = prev);
      mode = 'worktree';
    } else if (isGitRepo(root) && headSha(root)) {
      const wt = createJobWorktree(root, this.store.paths.worktreesDir, task.id, jobId);
      ({ path: workdir, branch, base: baseSha } = wt);
      mode = 'worktree';
    }
    const job = this.store.createJob({
      id: jobId,
      taskId,
      role: 'implementation',
      worker: 'director',
      workspaceMode: mode,
      workdir,
      branch,
      baseSha,
      parentJobId: prev?.id ?? null,
      instructions: `Yönetici devraldı: ${reason}`,
      timeoutS: loadConfig(root).escalation.takeover_minutes * 60,
    });
    this.store.transitionJob(jobId, 'starting');
    this.store.transitionJob(jobId, 'running', { startedAt: nowIso() });
    this.store.updateTask(taskId, { state: 'in_progress', note: s().takenOverNote(reason) });
    const relDir = relative(root, workdir).replace(/\\/g, '/');
    const grant = createGrant(root, {
      reason: `TAKEOVER ${taskId}: ${reason}`,
      paths: mode === 'worktree' ? [`${relDir}/**`] : ['**'],
      ttlMin: loadConfig(root).escalation.takeover_minutes,
      taskId,
      kind: 'takeover',
    });
    appendTaskAudit(this.store.paths.auditDir, {
      event: 'task_takeover',
      task_id: taskId,
      job_id: jobId,
      reason,
      eligibility: st.reasons,
      grant_id: grant.grant_id,
    });
    return {
      job_id: jobId,
      workdir,
      branch,
      grant_id: grant.grant_id,
      expires_at: grant.expires_at,
      instructions:
        mode === 'worktree' ? s().takeoverWorktree(workdir, branch) : s().takeoverShared,
    };
  }

  /** Devralınan işi kapatır: gerçek diff'ten sonuç üretilir, iş incelemeye alınır, izin kapanır. */
  takeoverComplete(
    jobId: string,
    input: {
      summary: string;
      testsExecuted: string[];
      testsPassed: number;
      testsFailed: number;
      exitCodes: number[];
      requirementsCompleted: string[];
      requirementsMissing: string[];
    },
  ) {
    const job = this.mustJob(jobId);
    if (job.worker !== 'director' || job.state !== 'running') {
      throw new ServiceError('INVALID_STATE', s().notTakeoverJob(jobId));
    }
    const changed = isGitRepo(job.workdir) ? workDiff(job.workdir, job.baseSha).changedFiles : [];
    const result: WorkerResultV1 = {
      schema_version: '1',
      task_id: job.taskId,
      job_id: job.id,
      agent_role: 'implementation',
      status: input.requirementsMissing.length ? 'partial' : 'completed',
      summary: input.summary,
      changed_files: changed,
      requirements_completed: input.requirementsCompleted,
      requirements_missing: input.requirementsMissing,
      tests: {
        executed: input.testsExecuted,
        passed: input.testsPassed,
        failed: input.testsFailed,
        exit_codes: input.exitCodes,
      },
      review: { level: 'none', critical_count: 0, findings: [] },
      evidence_locations: [],
      blockers: [],
      recommended_next_action: 'task_accept',
    };
    this.store.transitionJob(jobId, 'validating', { exitCode: 0 });
    this.store.transitionJob(jobId, 'needs_review', { result, warnings: [], endedAt: nowIso() });
    for (const g of activeGrants(this.store.paths.root).filter((x) => x.task_id === job.taskId)) {
      if (g.reason.startsWith('TAKEOVER'))
        endGrant(this.store.paths.root, g.grant_id, input.summary);
    }
    this.settleTask(job.taskId);
    return {
      ...jobBrief(this.store.mustGetJob(jobId)),
      changed_files: changed,
      next: 'task_accept',
    };
  }

  /**
   * Yönetişim için otomatik kanıt: test komutunu çalıştırır ve görev değişikliklerinde
   * gizli bilgi taraması yapar. Dosyalar .anafor/evidence/ altına yazılır.
   */
  evidenceGenerate(taskId: string, opts: { testCommand?: string; skipTests?: boolean } = {}) {
    const task = this.mustTask(taskId);
    const root = this.store.paths.root;
    const evidenceDir = join(this.store.paths.anaforDir, 'evidence');
    const integ = join(this.store.paths.worktreesDir, `_task-${taskId}`);
    const hasBranch = branchExists(root, taskBranchName(taskId));
    const jobs = this.store.listJobs({ taskId }).filter((j) => j.baseSha);
    const latestImpl = jobs.filter((j) => j.role === 'implementation').at(-1);
    const unmergedWorktree =
      latestImpl?.workspaceMode === 'worktree' &&
      latestImpl.state !== 'merged' &&
      existsSync(latestImpl.workdir);
    const cwd = unmergedWorktree ? latestImpl.workdir : existsSync(integ) ? integ : root;
    const base = unmergedWorktree ? latestImpl.baseSha! : (jobs[0]?.baseSha ?? headSha(root));
    if (!base) throw new ServiceError('VALIDATION_FAILED', s().noBaseCommit);

    let tests: (ReturnType<typeof generateTestEvidence> & { reused?: boolean }) | null = null;
    if (!opts.skipTests) {
      const cmd = opts.testCommand ?? loadConfig(root).test_command ?? detectTestCommand(cwd);
      if (!cmd) {
        throw new ServiceError('VALIDATION_FAILED', s().noTestCommand, s().noTestCommandHint);
      }
      const status = git(cwd, ['status', '--porcelain'])
        .stdout.split(/\r?\n/)
        .filter(Boolean)
        .filter((line) => !line.slice(3).replace(/\\/g, '/').startsWith('.anafor/'));
      const currentHead = headSha(cwd);
      const previousCheck = latestImpl?.autoCheck;
      const reusable = canReuseAutoCheck(previousCheck, cmd, currentHead, cwd, status);
      if (reusable && previousCheck) {
        tests = {
          path: previousCheck.evidence,
          passed: previousCheck.passed,
          summary: previousCheck.summary,
          reused: true,
        };
      } else tests = generateTestEvidence(root, cwd, evidenceDir, taskId, cmd);
    }
    const scan = generateScanEvidence(
      root,
      evidenceDir,
      taskId,
      base,
      unmergedWorktree ? null : hasBranch ? taskBranchName(taskId) : null,
      cwd,
    );
    return {
      task_id: task.id,
      workdir: cwd,
      tests: tests
        ? {
            evidence: tests.path,
            passed: tests.passed,
            summary: tests.summary,
            ...(tests.reused ? { reused: true } : {}),
          }
        : null,
      scan: {
        evidence: scan.path,
        clean: scan.passed,
        scanner: scan.scanner,
        findings: scan.findings,
      },
      note: s().evidenceNote,
    };
  }

  // ---- müdahale (pürüz istisnası) ----

  intervene(input: { reason: string; paths: string[]; ttlMin?: number; taskId?: string }) {
    if (input.taskId) this.mustTask(input.taskId);
    try {
      const g = createGrant(this.store.paths.root, {
        reason: input.reason,
        paths: input.paths,
        ttlMin: input.ttlMin ?? 15,
        taskId: input.taskId ?? null,
      });
      return {
        ...g,
        note: s().interveneNote,
      };
    } catch (e) {
      throw new ServiceError('VALIDATION_FAILED', (e as Error).message);
    }
  }

  interveneEnd(grantId: string, summary: string) {
    try {
      const g = endGrant(this.store.paths.root, grantId, summary);
      return { grant_id: g.grant_id, ended: true };
    } catch (e) {
      throw new ServiceError('NOT_FOUND', (e as Error).message);
    }
  }

  activeInterventions() {
    return activeGrants(this.store.paths.root);
  }

  // ---- yardımcılar ----

  private startJob(job: Job): void {
    try {
      this.launch(this.store, job);
    } catch (e) {
      this.guard(() =>
        this.store.transitionJob(job.id, 'failed', {
          error: s().runnerFailed((e as Error).message),
          endedAt: nowIso(),
        }),
      );
      this.settleTask(job.taskId);
      throw new ServiceError('WORKER_UNAVAILABLE', s().runnerFailed((e as Error).message));
    }
  }

  private settleTask(taskId: string): void {
    const t = this.store.getTask(taskId);
    if (
      t?.state === 'in_progress' &&
      this.store.listJobs({ taskId, states: ACTIVE_JOB_STATES }).length === 0
    ) {
      this.store.updateTask(taskId, { state: 'in_review' });
    }
  }

  private mustTask(id: string): Task {
    const t = this.store.getTask(id);
    if (!t) throw new ServiceError('NOT_FOUND', s().taskNotFound(id), s().taskNotFoundHint);
    return t;
  }

  private mustJob(id: string): Job {
    const j = this.store.getJob(id);
    if (!j) throw new ServiceError('NOT_FOUND', s().jobNotFound(id));
    return j;
  }

  private guard<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof StoreError) throw new ServiceError(e.code, e.message);
      throw e;
    }
  }
}
