import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type { Finding, ReviewLevel, Role, WorkerResultV1 } from '../contracts/worker-result.js';
import { newId, nowIso } from '../core/ids.js';
import { ensureProjectDirs, projectPaths, type ProjectPaths } from '../core/paths.js';
import { jobSourcesFor, type JobState, type TaskState } from '../core/states.js';
import { openDatabase } from './db.js';
import { otherProjectLeases } from '../core/leases.js';

export type Priority = 'low' | 'normal' | 'high' | 'critical';
export type WorkspaceMode = 'worktree' | 'shared' | 'readonly';

export interface Task {
  id: string;
  projectId: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  constraints: string[];
  contextRefs: string[];
  reviewLevel: ReviewLevel;
  priority: Priority;
  state: TaskState;
  branch: string | null;
  baseRef: string | null;
  correctionCount: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JobInputs {
  targetJobId?: string;
  explicitWorker?: boolean;
  failoverJobId?: string;
  files?: string[];
  refs?: string[];
  priorJobIds?: string[];
  /** Düzeltme işlerinde yöneticinin istediği bulgular. */
  findings?: Finding[];
  reviewContext?: {
    diffSummary: string;
    targetWorker?: string;
    autoCheck?: { command: string; passed: boolean; summary: string } | null;
  };
}

export interface TokenUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
}

export interface Job {
  id: string;
  taskId: string;
  role: Role;
  worker: string;
  model: string | null;
  state: JobState;
  workspaceMode: WorkspaceMode;
  workdir: string;
  branch: string | null;
  sessionRef: string | null;
  parentJobId: string | null;
  isCorrection: boolean;
  autoContinuePending: boolean;
  autoContinued: boolean;
  instructions: string;
  inputs: JobInputs;
  timeoutS: number;
  pid: number | null;
  exitCode: number | null;
  error: string | null;
  result: WorkerResultV1 | null;
  autoCheck: AutoCheck | null;
  warnings: string[];
  usage: TokenUsage | null;
  /** İş başladığında çalışma alanının git HEAD'i. */
  baseSha: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  updatedAt: string;
}

export interface AutoCheck {
  command: string;
  passed: boolean;
  exit_code: number | null;
  summary: string;
  evidence: string;
  workdir: string;
  head_sha?: string;
}

export interface JobEvent {
  jobId: string;
  seq: number;
  ts: string;
  type: string;
  summary: string;
}

type Row = Record<string, SQLInputValue>;

const parse = <T>(v: SQLInputValue, fallback: T): T =>
  typeof v === 'string' && v.length > 0 ? (JSON.parse(v) as T) : fallback;
const str = (v: SQLInputValue): string | null => (v === null ? null : String(v));
const num = (v: SQLInputValue): number | null => (v === null ? null : Number(v));

function toTask(r: Row): Task {
  return {
    id: String(r.id),
    projectId: String(r.project_id),
    title: String(r.title),
    objective: String(r.objective),
    acceptanceCriteria: parse(r.criteria_json ?? null, []),
    constraints: parse(r.constraints_json ?? null, []),
    contextRefs: parse(r.context_refs_json ?? null, []),
    reviewLevel: String(r.review_level) as ReviewLevel,
    priority: String(r.priority) as Priority,
    state: String(r.state) as TaskState,
    branch: str(r.branch ?? null),
    baseRef: str(r.base_ref ?? null),
    correctionCount: Number(r.correction_count),
    note: str(r.note ?? null),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

function toJob(r: Row): Job {
  return {
    id: String(r.id),
    taskId: String(r.task_id),
    role: String(r.role) as Role,
    worker: String(r.worker),
    model: str(r.model ?? null),
    state: String(r.state) as JobState,
    workspaceMode: String(r.workspace_mode) as WorkspaceMode,
    workdir: String(r.workdir),
    branch: str(r.branch ?? null),
    sessionRef: str(r.session_ref ?? null),
    parentJobId: str(r.parent_job_id ?? null),
    isCorrection: Number(r.is_correction) === 1,
    autoContinuePending: Number(r.auto_continue_pending ?? 0) === 1,
    autoContinued: Number(r.auto_continued ?? 0) === 1,
    instructions: String(r.instructions),
    inputs: parse(r.inputs_json ?? null, {}),
    timeoutS: Number(r.timeout_s),
    pid: num(r.pid ?? null),
    exitCode: num(r.exit_code ?? null),
    error: str(r.error ?? null),
    result: parse(r.result_json ?? null, null),
    autoCheck: parse(r.auto_check_json ?? null, null),
    warnings: parse(r.warnings_json ?? null, []),
    usage: parse(r.usage_json ?? null, null),
    baseSha: str(r.base_sha ?? null),
    createdAt: String(r.created_at),
    startedAt: str(r.started_at ?? null),
    endedAt: str(r.ended_at ?? null),
    updatedAt: String(r.updated_at),
  };
}

export interface CreateTaskInput {
  title: string;
  objective: string;
  acceptanceCriteria?: string[];
  constraints?: string[];
  contextRefs?: string[];
  reviewLevel?: ReviewLevel;
  priority?: Priority;
  branch?: string | null;
  baseRef?: string | null;
}

export interface CreateJobInput {
  taskId: string;
  role: Role;
  worker: string;
  model?: string | null;
  workspaceMode: WorkspaceMode;
  workdir: string;
  branch?: string | null;
  sessionRef?: string | null;
  parentJobId?: string | null;
  isCorrection?: boolean;
  autoContinued?: boolean;
  instructions: string;
  inputs?: JobInputs;
  timeoutS: number;
  id?: string;
  baseSha?: string | null;
}

/** Bir projenin kalıcı durumu. Tüm durum değişiklikleri buradan geçer. */
export class Store {
  readonly paths: ProjectPaths;
  readonly db: DatabaseSync;

  constructor(projectRoot: string) {
    this.paths = projectPaths(projectRoot);
    ensureProjectDirs(this.paths);
    this.db = openDatabase(this.paths.dbFile);
  }

  close(): void {
    this.db.close();
  }

  // ---- görevler ----

  createTask(input: CreateTaskInput): Task {
    const id = newId('T');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, objective, criteria_json, constraints_json,
          context_refs_json, review_level, priority, state, branch, base_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
      )
      .run(
        id,
        this.paths.projectId,
        input.title,
        input.objective,
        JSON.stringify(input.acceptanceCriteria ?? []),
        JSON.stringify(input.constraints ?? []),
        JSON.stringify(input.contextRefs ?? []),
        input.reviewLevel ?? 'standard',
        input.priority ?? 'normal',
        input.branch ?? null,
        input.baseRef ?? null,
        now,
        now,
      );
    return this.mustGetTask(id);
  }

  getTask(id: string): Task | null {
    const r = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Row | undefined;
    return r ? toTask(r) : null;
  }

  mustGetTask(id: string): Task {
    const t = this.getTask(id);
    if (!t) throw new StoreError('NOT_FOUND', `Görev bulunamadı: ${id}`);
    return t;
  }

  listTasks(opts: { includeClosed?: boolean } = {}): Task[] {
    const sql = opts.includeClosed
      ? 'SELECT * FROM tasks ORDER BY created_at DESC'
      : "SELECT * FROM tasks WHERE state NOT IN ('accepted','abandoned','superseded') ORDER BY created_at DESC";
    return (this.db.prepare(sql).all() as Row[]).map(toTask);
  }

  closeNeedsReviewJobsForClosedTasks(): void {
    try {
      const rows = this.db
        .prepare(
          `UPDATE jobs SET state = 'approved', auto_continue_pending = 0, updated_at = ?
           WHERE state = 'needs_review' AND task_id IN (
             SELECT id FROM tasks WHERE state IN ('accepted','abandoned','superseded')
           ) RETURNING id`,
        )
        .all(nowIso()) as { id: string }[];
      for (const { id } of rows) this.appendEvent(id, 'closed_with_task', 'closed_with_task');
    } catch (error) {
      console.error('Kapalı görev işleri temizlenemedi:', error);
    }
  }

  updateTask(
    id: string,
    patch: Partial<
      Pick<
        Task,
        | 'state'
        | 'branch'
        | 'baseRef'
        | 'note'
        | 'priority'
        | 'acceptanceCriteria'
        | 'constraints'
        | 'correctionCount'
      >
    >,
  ): Task {
    const cols: Record<string, SQLInputValue> = {};
    if (patch.state !== undefined) cols.state = patch.state;
    if (patch.branch !== undefined) cols.branch = patch.branch;
    if (patch.baseRef !== undefined) cols.base_ref = patch.baseRef;
    if (patch.note !== undefined) cols.note = patch.note;
    if (patch.priority !== undefined) cols.priority = patch.priority;
    if (patch.correctionCount !== undefined) cols.correction_count = patch.correctionCount;
    if (patch.acceptanceCriteria !== undefined)
      cols.criteria_json = JSON.stringify(patch.acceptanceCriteria);
    if (patch.constraints !== undefined) cols.constraints_json = JSON.stringify(patch.constraints);
    this.updateRow('tasks', id, cols);
    return this.mustGetTask(id);
  }

  // ---- işler ----

  createJob(input: CreateJobInput): Job {
    const id = input.id ?? newId('J');
    const now = nowIso();
    this.db
      .prepare(
        `INSERT INTO jobs (id, task_id, role, worker, model, state, workspace_mode, workdir, branch,
          session_ref, parent_job_id, is_correction, auto_continued, instructions, inputs_json, timeout_s,
          base_sha, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.taskId,
        input.role,
        input.worker,
        input.model ?? null,
        input.workspaceMode,
        input.workdir,
        input.branch ?? null,
        input.sessionRef ?? null,
        input.parentJobId ?? null,
        input.isCorrection ? 1 : 0,
        input.autoContinued ? 1 : 0,
        input.instructions,
        JSON.stringify(input.inputs ?? {}),
        input.timeoutS,
        input.baseSha ?? null,
        now,
        now,
      );
    return this.mustGetJob(id);
  }

  getJob(id: string): Job | null {
    const r = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Row | undefined;
    return r ? toJob(r) : null;
  }

  mustGetJob(id: string): Job {
    const j = this.getJob(id);
    if (!j) throw new StoreError('NOT_FOUND', `İş bulunamadı: ${id}`);
    return j;
  }

  listJobs(filter: { taskId?: string; states?: readonly JobState[] } = {}): Job[] {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.taskId) {
      where.push('task_id = ?');
      params.push(filter.taskId);
    }
    if (filter.states && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => '?').join(',')})`);
      params.push(...filter.states);
    }
    const sql = `SELECT * FROM jobs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at ASC, rowid ASC`;
    return (this.db.prepare(sql).all(...params) as Row[]).map(toJob);
  }

  /** Atomically reserves a worker slot and claims a queued job across SQLite connections. */
  claimQueuedJob(
    id: string,
    worker: string,
    maxConcurrency: number,
    maxParallelJobs: number,
  ): Job | null {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const active = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM jobs WHERE state IN ('starting','running','validating')",
        )
        .get() as { count: number };
      const workerActive = this.db
        .prepare(
          "SELECT COUNT(*) AS count FROM jobs WHERE worker = ? AND state IN ('starting','running','validating')",
        )
        .get(worker) as { count: number };
      const globalActive = Number(active.count) + otherProjectLeases(this.paths.root).length;
      if (Number(workerActive.count) >= maxConcurrency || globalActive >= maxParallelJobs) {
        this.db.exec('COMMIT;');
        return null;
      }
      const updated = this.db
        .prepare(
          "UPDATE jobs SET state = 'starting', updated_at = ? WHERE id = ? AND worker = ? AND state = 'queued'",
        )
        .run(nowIso(), id, worker);
      if (Number(updated.changes) !== 1) {
        this.db.exec('COMMIT;');
        return null;
      }
      const job = this.mustGetJob(id);
      this.db.exec('COMMIT;');
      return job;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK;');
      } catch {
        // Preserve the original claim failure if rollback also fails.
      }
      throw error;
    }
  }

  /**
   * Koşullu durum geçişi: yalnızca mevcut durum `to`'ya izinli bir kaynaksa uygular.
   * Yarış durumunda (başka süreç önce geçirdiyse) INVALID_STATE fırlatır.
   */
  transitionJob(
    id: string,
    to: JobState,
    patch: Partial<{
      pid: number | null;
      exitCode: number | null;
      error: string | null;
      sessionRef: string | null;
      result: WorkerResultV1 | null;
      warnings: string[];
      inputs: JobInputs;
      usage: TokenUsage | null;
      startedAt: string;
      endedAt: string;
      autoCheck: AutoCheck | null;
      autoContinuePending: boolean;
    }> = {},
  ): Job {
    const sources = jobSourcesFor(to);
    const cols: Record<string, SQLInputValue> = { state: to };
    if (sources.includes('needs_review')) cols.auto_continue_pending = 0;
    if (patch.pid !== undefined) cols.pid = patch.pid;
    if (patch.exitCode !== undefined) cols.exit_code = patch.exitCode;
    if (patch.error !== undefined) cols.error = patch.error;
    if (patch.sessionRef !== undefined) cols.session_ref = patch.sessionRef;
    if (patch.result !== undefined)
      cols.result_json = patch.result ? JSON.stringify(patch.result) : null;
    if (patch.autoCheck !== undefined)
      cols.auto_check_json = patch.autoCheck ? JSON.stringify(patch.autoCheck) : null;
    if (patch.autoContinuePending !== undefined)
      cols.auto_continue_pending = patch.autoContinuePending ? 1 : 0;
    if (patch.warnings !== undefined) cols.warnings_json = JSON.stringify(patch.warnings);
    if (patch.inputs !== undefined) cols.inputs_json = JSON.stringify(patch.inputs);
    if (patch.usage !== undefined)
      cols.usage_json = patch.usage ? JSON.stringify(patch.usage) : null;
    if (patch.startedAt !== undefined) cols.started_at = patch.startedAt;
    if (patch.endedAt !== undefined) cols.ended_at = patch.endedAt;
    cols.updated_at = nowIso();
    const keys = Object.keys(cols);
    const sql = `UPDATE jobs SET ${keys.map((k) => `${k} = ?`).join(', ')}
      WHERE id = ? AND state IN (${sources.map(() => '?').join(',')})`;
    const res = this.db.prepare(sql).run(...keys.map((k) => cols[k] ?? null), id, ...sources);
    if (Number(res.changes) !== 1) {
      const cur = this.getJob(id);
      if (!cur) throw new StoreError('NOT_FOUND', `İş bulunamadı: ${id}`);
      throw new StoreError('INVALID_STATE', `İş ${id}: ${cur.state} → ${to} geçişi geçersiz`);
    }
    return this.mustGetJob(id);
  }

  /** Durumu değiştirmeden alan güncelleme (pid, sessionRef, usage gibi). */
  patchJob(
    id: string,
    patch: Partial<{
      pid: number | null;
      sessionRef: string | null;
      usage: TokenUsage | null;
      autoCheck: AutoCheck | null;
      warnings: string[];
      autoContinuePending: boolean;
    }>,
  ): void {
    const cols: Record<string, SQLInputValue> = {};
    if (patch.pid !== undefined) cols.pid = patch.pid;
    if (patch.sessionRef !== undefined) cols.session_ref = patch.sessionRef;
    if (patch.usage !== undefined)
      cols.usage_json = patch.usage ? JSON.stringify(patch.usage) : null;
    if (patch.autoCheck !== undefined)
      cols.auto_check_json = patch.autoCheck ? JSON.stringify(patch.autoCheck) : null;
    if (patch.warnings !== undefined) cols.warnings_json = JSON.stringify(patch.warnings);
    if (patch.autoContinuePending !== undefined)
      cols.auto_continue_pending = patch.autoContinuePending ? 1 : 0;
    this.updateRow('jobs', id, cols);
  }

  claimAutoContinuePending(id: string): Job | null {
    this.db.exec('BEGIN IMMEDIATE;');
    try {
      const update = this.db
        .prepare(
          "UPDATE jobs SET auto_continue_pending = 0, updated_at = ? WHERE id = ? AND state = 'needs_review' AND auto_continue_pending = 1",
        )
        .run(nowIso(), id);
      const job = Number(update.changes) === 1 ? this.getJob(id) : null;
      this.db.exec('COMMIT;');
      return job;
    } catch (error) {
      this.db.exec('ROLLBACK;');
      throw error;
    }
  }

  // ---- oturumlar ----

  getSession(taskId: string, role: Role, worker: string): string | null {
    const r = this.db
      .prepare('SELECT session_ref FROM sessions WHERE task_id = ? AND role = ? AND worker = ?')
      .get(taskId, role, worker) as { session_ref: string } | undefined;
    return r?.session_ref ?? null;
  }

  saveSession(taskId: string, role: Role, worker: string, sessionRef: string, jobId: string): void {
    this.db
      .prepare(
        `INSERT INTO sessions (task_id, role, worker, session_ref, last_job_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(task_id, role, worker) DO UPDATE SET
           session_ref = excluded.session_ref, last_job_id = excluded.last_job_id,
           updated_at = excluded.updated_at`,
      )
      .run(taskId, role, worker, sessionRef, jobId, nowIso());
  }

  // ---- olaylar ----

  appendEvent(jobId: string, type: string, summary: string): JobEvent {
    const r = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM events WHERE job_id = ?')
      .get(jobId) as { next: number };
    const ev: JobEvent = { jobId, seq: Number(r.next), ts: nowIso(), type, summary };
    this.db
      .prepare('INSERT INTO events (job_id, seq, ts, type, summary) VALUES (?, ?, ?, ?, ?)')
      .run(ev.jobId, ev.seq, ev.ts, ev.type, ev.summary);
    return ev;
  }

  listEvents(jobId: string, sinceSeq = 0, limit = 100): JobEvent[] {
    return (
      this.db
        .prepare('SELECT * FROM events WHERE job_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?')
        .all(jobId, sinceSeq, limit) as Row[]
    ).map((r) => ({
      jobId: String(r.job_id),
      seq: Number(r.seq),
      ts: String(r.ts),
      type: String(r.type),
      summary: String(r.summary),
    }));
  }

  private updateRow(
    table: 'tasks' | 'jobs',
    id: string,
    cols: Record<string, SQLInputValue>,
  ): void {
    const keys = Object.keys(cols);
    if (keys.length === 0) return;
    cols.updated_at = nowIso();
    const allKeys = Object.keys(cols);
    const res = this.db
      .prepare(`UPDATE ${table} SET ${allKeys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`)
      .run(...allKeys.map((k) => cols[k] ?? null), id);
    if (Number(res.changes) !== 1) throw new StoreError('NOT_FOUND', `${table}: ${id} bulunamadı`);
  }
}

export type StoreErrorCode = 'NOT_FOUND' | 'INVALID_STATE';

export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}
