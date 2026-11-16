import type { AdapterRegistry } from '../adapters/registry.js';
import type { Finding, ReviewLevel, Role } from '../contracts/worker-result.js';
import { nowIso } from '../core/ids.js';
import { isAlive, killPidTree } from '../core/process-util.js';
import {
  ACTIVE_JOB_STATES,
  isClosedTaskState,
  isTerminalJobState,
  MAX_CORRECTIONS,
  type JobState,
} from '../core/states.js';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluateAcceptance } from '../core/accept.js';
import { git, headSha, isGitRepo, workDiff } from '../git/git.js';
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
  | 'NOT_INITIALIZED';

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
}

/** MCP araçlarının arkasındaki iş mantığı. Taşıma (MCP) katmanından bağımsızdır. */
export class AnaforService {
  constructor(
    readonly store: Store,
    readonly adapters: AdapterRegistry,
    private readonly launch: Launcher = detachedLauncher,
    private readonly defaultWorker = 'codex',
  ) {}

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
          running,
        };
      }),
    );
  }

  projectStatus() {
    const tasks = this.store.listTasks();
    const active = this.store.listJobs({ states: ACTIVE_JOB_STATES });
    const review = this.store.listJobs({ states: ['needs_review'] });
    return {
      project_root: this.store.paths.root,
      open_tasks: tasks.map(taskBrief),
      active_jobs: active.map(jobBrief),
      jobs_needing_review: review.map(jobBrief),
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
    };
  }

  // ---- iş ----

  async jobDispatch(input: DispatchInput) {
    const task = this.mustTask(input.taskId);
    if (isClosedTaskState(task.state) || task.state === 'blocked') {
      throw new ServiceError('INVALID_STATE', `Görev ${task.id} durumu: ${task.state}`);
    }
    const workerId = input.worker ?? this.defaultWorker;
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

    const workspace: WorkspaceMode =
      input.workspace ??
      (input.role === 'implementation' || input.role === 'test' ? 'shared' : 'readonly');
    if (workspace === 'worktree') {
      throw new ServiceError(
        'NOT_IMPLEMENTED',
        'worktree modu henüz yok (F3)',
        "workspace: 'shared' veya 'readonly' kullanın",
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
          'Bitmesini bekleyin; paralel yazma işleri worktree modu ile gelecek (F3)',
        );
      }
    }

    const sessionRef =
      input.newSession || !caps.resume
        ? null
        : this.store.getSession(task.id, input.role, workerId);

    const job = this.store.createJob({
      taskId: task.id,
      role: input.role,
      worker: workerId,
      model: input.model ?? null,
      workspaceMode: workspace,
      workdir: this.store.paths.root,
      sessionRef,
      instructions: input.instructions,
      inputs: input.inputs ?? {},
      timeoutS: input.timeoutS ?? DEFAULT_TIMEOUT_S[input.role],
      baseSha: headSha(this.store.paths.root),
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
    const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');
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
    const failed = gates.filter((g) => !g.ok);
    if (failed.length === 0) {
      this.guard(() => this.store.transitionJob(job.id, 'approved'));
      if (reviewJob && reviewJob.state === 'needs_review') {
        this.guard(() => this.store.transitionJob(reviewJob.id, 'approved'));
      }
      this.store.updateTask(taskId, { state: 'accepted', note: `kabul: ${job.id}` });
      appendTaskAudit(this.store.paths.auditDir, {
        event: 'task_accepted',
        task_id: taskId,
        job_id: jobId,
        review_job_id: reviewJobId ?? null,
        gates,
      });
    }
    return {
      task_id: taskId,
      accepted: failed.length === 0,
      failed_gates: failed,
      passed_gates: gates.filter((g) => g.ok).map((g) => g.gate),
      note: failed.length
        ? 'Kapılardan geçmedi: düzeltme isteyin (job_request_changes) veya kullanıcıya raporlayın.'
        : 'Kabul edildi. Kalıcı bilgi varsa proje hafızasını güncelleyin.',
    };
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
