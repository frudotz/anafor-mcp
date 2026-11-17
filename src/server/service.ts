import type { AdapterRegistry } from '../adapters/registry.js';
import type { Finding, ReviewLevel, Role, WorkerResultV1 } from '../contracts/worker-result.js';
import { loadConfig } from '../core/config.js';
import { newId, nowIso } from '../core/ids.js';
import { isAlive, killPidTree } from '../core/process-util.js';
import {
  ACTIVE_JOB_STATES,
  isClosedTaskState,
  isTerminalJobState,
  MAX_CORRECTIONS,
  type JobState,
} from '../core/states.js';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
import {
  formatWindows,
  limitAccount,
  readCodexLimits,
  readStoredLimits,
} from '../limits/limits.js';
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
  generateScanEvidence,
  generateTestEvidence,
} from '../governance/evidence.js';
import { ensurePolicy } from '../governance/policy.js';
import { activeGrants, createGrant, endGrant } from '../hooks/grants.js';

function appendTaskAudit(auditDir: string, record: object): void {
  mkdirSync(auditDir, { recursive: true });
  appendFileSync(
    join(auditDir, 'tasks.jsonl'),
    JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n',
  );
}
import { runJob } from '../runner/run-job.js';
import { spawnDetachedRunner } from '../runner/spawn.js';
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
    readonly adapters: AdapterRegistry,
    private readonly launch: Launcher = detachedLauncher,
    private readonly defaultWorker = 'codex',
    private readonly routing: Partial<Record<Role, string[]>> = {},
  ) {}

  /**
   * Router: rol için tercih sırasındaki ilk uygun işçi (erişilebilir, oturum açık, kapasite var).
   * Review işinde hedef işi yapan işçi sona alınır (çapraz model incelemesi).
   */
  /** İşçi oturum/kullanım limitleri (bilinen kaynaklardan; bilinmiyorsa unknown). */
  workersLimits() {
    const stored = readStoredLimits();
    const ids = [...new Set([...this.adapters.keys()].map(limitAccount))];
    if (!ids.includes('claude')) ids.unshift('claude');
    return ids.map((id) => {
      const l = id === 'codex' ? (readCodexLimits() ?? stored[id]) : stored[id];
      if (!l) {
        return {
          worker: id,
          status: 'unknown' as const,
          summary: 'bilinmiyor (henüz gözlenmedi veya araç limit bildirmiyor)',
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

  /** Limiti dolmuş (sıfırlanma zamanı gelmemiş) işçi mi? */
  private limited(workerId: string): string | null {
    const acc = limitAccount(workerId);
    const l =
      acc === 'codex' ? (readCodexLimits() ?? readStoredLimits()[acc]) : readStoredLimits()[acc];
    if (!l) return null;
    const now = Date.now() / 1000;
    const full = l.windows.find(
      (w) => w.used_percent >= 100 && (w.resets_at === null || w.resets_at > now),
    );
    return full ? `${workerId}: ${full.name} limiti dolu (%${full.used_percent})` : null;
  }

  async route(role: Role, target: Job | null): Promise<string> {
    let order = [...new Set([...(this.routing[role] ?? []), this.defaultWorker])].filter((id) =>
      this.adapters.has(id),
    );
    if (role === 'review' && target) {
      order = [
        ...order.filter((w) => w !== target.worker),
        ...order.filter((w) => w === target.worker),
      ];
    }
    const reasons: string[] = [];
    for (const id of order) {
      const a = this.adapters.get(id)!;
      if (!a.capabilities().roles.includes(role)) continue;
      const d = await a.detect();
      if (!d.available || d.authOk === false) {
        reasons.push(`${id}: ${d.reason ?? 'kullanılamıyor'}`);
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
        reasons.push(`${id}: kapasite dolu`);
        continue;
      }
      return id;
    }
    throw new ServiceError(
      'WORKER_UNAVAILABLE',
      `'${role}' için uygun işçi yok`,
      reasons.join('; ') || 'workers_list ile durumu kontrol edin',
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
      throw new ServiceError('INVALID_STATE', `Görev ${task.id} durumu: ${task.state}`);
    }
    const target = input.targetJobId ? this.mustJob(input.targetJobId) : null;
    const workerId = input.worker ?? (await this.route(input.role, target));
    const adapter = this.adapters.get(workerId);
    if (!adapter) {
      throw new ServiceError(
        'WORKER_UNAVAILABLE',
        `Bilinmeyen işçi: ${workerId}`,
        `Kullanılabilir: ${[...this.adapters.keys()].join(', ')}`,
      );
    }
    const caps = adapter.capabilities();
    if (!caps.roles.includes(input.role)) {
      throw new ServiceError(
        'VALIDATION_FAILED',
        `${workerId} '${input.role}' rolünü desteklemiyor`,
      );
    }
    const det = await adapter.detect();
    if (!det.available || det.authOk === false) {
      throw new ServiceError(
        'WORKER_UNAVAILABLE',
        `${workerId} kullanılamıyor: ${det.reason ?? 'bilinmiyor'}`,
      );
    }
    const running = this.store
      .listJobs({ states: ACTIVE_JOB_STATES })
      .filter((j) => j.worker === workerId).length;
    if (running >= caps.maxConcurrency) {
      throw new ServiceError(
        'LIMIT_REACHED',
        `${workerId} eşzamanlılık sınırı (${caps.maxConcurrency}) dolu`,
        'job_wait ile bir işin bitmesini bekleyin',
      );
    }

    const root = this.store.paths.root;
    const repoReady = isGitRepo(root) && headSha(root) !== null;
    const writes = input.role === 'implementation' || input.role === 'test';
    const workspace: WorkspaceMode =
      input.workspace ??
      (target ? 'readonly' : writes ? (repoReady ? 'worktree' : 'shared') : 'readonly');
    if (workspace === 'worktree' && !repoReady) {
      throw new ServiceError(
        'VALIDATION_FAILED',
        'worktree modu en az bir commit içeren bir git deposu gerektirir',
        "Önce commit atın veya workspace: 'shared' kullanın",
      );
    }
    if (workspace === 'shared') {
      const writer = this.store
        .listJobs({ states: ACTIVE_JOB_STATES })
        .find((j) => j.workspaceMode === 'shared');
      if (writer) {
        throw new ServiceError(
          'CONFLICT',
          `Paylaşılan çalışma alanında zaten yazan bir iş var: ${writer.id}`,
          "Bitmesini bekleyin veya workspace: 'worktree' kullanın",
        );
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
          throw new ServiceError('INTERNAL', `Worktree oluşturulamadı: ${(e as Error).message}`);
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
      inputs: input.inputs ?? {},
      timeoutS: input.timeoutS ?? DEFAULT_TIMEOUT_S[input.role],
      baseSha,
    });
    if (task.state === 'open' || task.state === 'in_review') {
      this.store.updateTask(task.id, { state: 'in_progress' });
    }
    const warnings: string[] = [];
    if (workspace === 'shared') {
      const dirty = git(this.store.paths.root, ['status', '--porcelain'])
        .stdout.split('\n')
        .filter((l) => l.trim() && !l.includes('.anafor/'));
      if (dirty.length) {
        warnings.push(
          `Çalışma ağacında ${dirty.length} commit edilmemiş değişiklik var; job_diff bunları da gösterir (taban: HEAD).`,
        );
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
      throw new ServiceError('VALIDATION_FAILED', 'Çalışma alanı bir git deposu değil');
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
  taskAccept(taskId: string, jobId: string, reviewJobId?: string) {
    const task = this.mustTask(taskId);
    const job = this.mustJob(jobId);
    const reviewJob = reviewJobId ? this.mustJob(reviewJobId) : null;
    const gates = evaluateAcceptance({
      task,
      job,
      taskJobs: this.store.listJobs({ taskId }),
      reviewJob,
      projectRoot: this.store.paths.root,
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
            : `çakışma: ${m.conflicts.join(', ')}`,
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
      this.store.updateTask(taskId, { state: 'accepted', note: `kabul: ${job.id}` });
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
        ? 'Kapılardan geçmedi: düzeltme isteyin (job_request_changes) veya kullanıcıya raporlayın.'
        : integration
          ? `Kabul edildi; değişiklikler ${integration.task_branch} dalında. Kullanıcı dalına almak için task_merge.`
          : 'Kabul edildi. Kalıcı bilgi varsa proje hafızasını güncelleyin.',
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
        `Görev kabul edilmemiş: ${task.state}`,
        'Önce task_accept',
      );
    }
    const root = this.store.paths.root;
    const branch = taskBranchName(taskId);
    if (!branchExists(root, branch)) {
      throw new ServiceError(
        'NOT_FOUND',
        `Görev dalı yok: ${branch} (shared modda değişiklikler zaten çalışma ağacında)`,
      );
    }
    const current = git(root, ['branch', '--show-current']).stdout.trim();
    const target = targetBranch ?? current;
    if (target !== current) {
      throw new ServiceError(
        'VALIDATION_FAILED',
        `Hedef dal (${target}) çalışma ağacındaki daldan (${current}) farklı`,
        'Hedef dala geçin veya target_branch vermeyin',
      );
    }
    // Yalnızca izlenen dosyalardaki değişiklikler engeller. İzlenmeyen dosyalar (ör. kanıtlar)
    // birleştirmeyi etkilemez; üzerlerine yazılacaksa git birleştirmeyi kendisi reddeder.
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no'])
      .stdout.split('\n')
      .filter((l) => l.trim() && !l.includes('.anafor/'));
    if (dirty.length) {
      throw new ServiceError(
        'CONFLICT',
        `Çalışma ağacında ${dirty.length} commit edilmemiş değişiklik var; birleştirme yapılmadı`,
        'Kullanıcı değişikliklerini commit edin veya stash edin',
      );
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
      return { merged: false, target, conflicts, note: 'Çakışma: birleştirme geri alındı.' };
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
      note: 'Geri almak için: git revert -m 1 ' + after,
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
        kept.push({ path, reason: 'aktif veya incelemede iş var' });
        continue;
      }
      if (!existsSync(path)) continue;
      if (hasChanges(path)) {
        kept.push({ path, reason: 'kaydedilmemiş değişiklik var (silinmedi)' });
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
      throw new ServiceError('INVALID_STATE', `Görev zaten kapalı: ${task.state}`);
    }
    const active = this.store.listJobs({ taskId, states: ACTIVE_JOB_STATES });
    if (active.length) {
      throw new ServiceError(
        'CONFLICT',
        `Görevde aktif işler var: ${active.map((j) => j.id).join(', ')}`,
        'Önce job_cancel ile iptal edin',
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
    const settled = (s: JobState) =>
      isTerminalJobState(s) || s === 'needs_review' || s === 'approved';
    for (;;) {
      const jobs = jobIds.map((id) => this.store.mustGetJob(id));
      const done = jobs.filter((j) => settled(j.state));
      const pending = jobs.filter((j) => !settled(j.state));
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
    return {
      ...jobBrief(j),
      result: j.result,
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

  jobEvents(jobId: string, sinceSeq = 0, limit = 50) {
    this.mustJob(jobId);
    return this.store.listEvents(jobId, sinceSeq, Math.min(limit, 200));
  }

  jobCancel(jobId: string, reason: string) {
    const j = this.mustJob(jobId);
    if (!ACTIVE_JOB_STATES.includes(j.state)) {
      throw new ServiceError('INVALID_STATE', `İş ${jobId} aktif değil: ${j.state}`);
    }
    // Önce durum (runner yarışta geri çekilir), sonra süreç.
    const cancelled = this.guard(() =>
      this.store.transitionJob(jobId, 'cancelled', {
        error: `iptal: ${reason}`,
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
      throw new ServiceError('INVALID_STATE', `İş ${jobId} incelemede değil: ${j.state}`);
    }
    const task = this.mustTask(j.taskId);
    if (task.correctionCount >= MAX_CORRECTIONS) {
      this.store.updateTask(task.id, {
        state: 'blocked',
        note: `Düzeltme sınırı (${MAX_CORRECTIONS}) aşıldı`,
      });
      throw new ServiceError(
        'LIMIT_REACHED',
        `Görev ${task.id} için ${MAX_CORRECTIONS} düzeltme sınırına ulaşıldı; görev blocked`,
        'Kullanıcıya raporlayın veya pürüzse intervene ile müdahale edin',
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
            error: 'orphaned: runner süreci bulunamadı (yeniden çalıştırılmadı)',
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
      note: reasons.length
        ? 'Yetkisiz: daha riskli bir yönteme geçmeyin; eksik kanıtı tamamlayın veya kullanıcı onayı isteyin. Denemeyi operation_record ile blocked olarak kaydedin.'
        : 'Yetkili. İşlemi projenin normal araçlarıyla yapın ve sonucu operation_record ile kaydedin.',
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
          note: 'İş bitince mutlaka release edin (finally).',
        };
      }
      if (!opts.token) throw new Error('release için token gerekli');
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
      reasons.push(`${failed.length} başarısız/reddedilen iş (eşik ${esc.failure_threshold})`);
    if (task.state === 'blocked') reasons.push('görev blocked');
    if (stalled.length)
      reasons.push(`${stalled.length} iş ${esc.stall_minutes} dakikadan uzun süredir bitmedi`);
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
        `Devralma koşulları oluşmadı: ${st.failed_jobs.length} başarısız iş, eşik ${st.thresholds.failure_threshold}`,
        'Önce job_request_changes ile işçiye düzeltme verin; tekrarlayan başarısızlıkta devralın',
      );
    }
    if (!reason.trim()) throw new ServiceError('VALIDATION_FAILED', 'Devralma gerekçesi zorunlu');
    const task = this.mustTask(taskId);
    const root = this.store.paths.root;
    for (const j of this.store.listJobs({ taskId, states: ACTIVE_JOB_STATES })) {
      if (j.worker !== 'director') this.jobCancel(j.id, `yönetici devraldı: ${reason}`);
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
    this.store.updateTask(taskId, { state: 'in_progress', note: `devralındı: ${reason}` });
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
        mode === 'worktree'
          ? `Yalnızca ${workdir} içinde çalış (dal ${branch}). Bitince testleri çalıştır ve takeover_complete çağır; ardından task_accept.`
          : 'Paylaşılan çalışma alanında çalış. Bitince takeover_complete, ardından task_accept.',
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
      throw new ServiceError('INVALID_STATE', `İş ${jobId} aktif bir devralma işi değil`);
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
    const cwd = existsSync(integ) ? integ : root;
    const jobs = this.store.listJobs({ taskId }).filter((j) => j.baseSha);
    const base = jobs[0]?.baseSha ?? headSha(root);
    if (!base)
      throw new ServiceError(
        'VALIDATION_FAILED',
        'Taban commit bulunamadı (git deposu ve commit gerekli)',
      );

    let tests: ReturnType<typeof generateTestEvidence> | null = null;
    if (!opts.skipTests) {
      const cmd = opts.testCommand ?? loadConfig(root).test_command ?? detectTestCommand(cwd);
      if (!cmd) {
        throw new ServiceError(
          'VALIDATION_FAILED',
          'Test komutu bulunamadı',
          'test_command verin veya anafor.config.json → test_command',
        );
      }
      tests = generateTestEvidence(root, cwd, evidenceDir, taskId, cmd);
    }
    const scan = generateScanEvidence(
      root,
      evidenceDir,
      taskId,
      base,
      hasBranch ? taskBranchName(taskId) : null,
    );
    return {
      task_id: task.id,
      tests: tests ? { evidence: tests.path, passed: tests.passed, summary: tests.summary } : null,
      scan: {
        evidence: scan.path,
        clean: scan.passed,
        scanner: scan.scanner,
        findings: scan.findings,
      },
      note: 'operation_authorize için: test_evidence, sensitive_scan_evidence, tests_passed, sensitive_scan_clean bu değerlerden.',
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
        note: 'Yalnızca bu yollarda ve süre içinde düzenleme serbest. Bitince intervene_end ile özet ver.',
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
          error: `Runner başlatılamadı: ${(e as Error).message}`,
          endedAt: nowIso(),
        }),
      );
      this.settleTask(job.taskId);
      throw new ServiceError('WORKER_UNAVAILABLE', `Runner başlatılamadı: ${(e as Error).message}`);
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
    if (!t)
      throw new ServiceError(
        'NOT_FOUND',
        `Görev bulunamadı: ${id}`,
        'project_status ile görevleri listeleyin',
      );
    return t;
  }

  private mustJob(id: string): Job {
    const j = this.store.getJob(id);
    if (!j) throw new ServiceError('NOT_FOUND', `İş bulunamadı: ${id}`);
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
