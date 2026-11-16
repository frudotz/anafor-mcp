/** İş (job) durumları ve izinli geçişler. Bkz. vault: İş Yaşam Döngüsü. */
export const JOB_STATES = [
  'queued',
  'starting',
  'running',
  'validating',
  'needs_review',
  'approved',
  'changes_requested',
  'merged',
  'failed',
  'timed_out',
  'cancelled',
  'invalid_output',
] as const;
export type JobState = (typeof JOB_STATES)[number];

const JOB_TRANSITIONS: Record<JobState, readonly JobState[]> = {
  queued: ['starting', 'cancelled', 'failed'],
  starting: ['running', 'failed', 'cancelled'],
  running: ['validating', 'failed', 'timed_out', 'cancelled'],
  validating: ['needs_review', 'invalid_output', 'failed'],
  needs_review: ['approved', 'changes_requested'],
  approved: ['merged'],
  changes_requested: [],
  merged: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  invalid_output: [],
};

export const ACTIVE_JOB_STATES: readonly JobState[] = [
  'queued',
  'starting',
  'running',
  'validating',
];

export function isTerminalJobState(s: JobState): boolean {
  return JOB_TRANSITIONS[s].length === 0;
}

export function canTransitionJob(from: JobState, to: JobState): boolean {
  return JOB_TRANSITIONS[from].includes(to);
}

/** `to` durumuna hangi durumlardan geçilebileceği (koşullu UPDATE için). */
export function jobSourcesFor(to: JobState): JobState[] {
  return JOB_STATES.filter((s) => JOB_TRANSITIONS[s].includes(to));
}

export const TASK_STATES = [
  'open',
  'in_progress',
  'in_review',
  'accepted',
  'blocked',
  'abandoned',
  'superseded',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

export function isClosedTaskState(s: TaskState): boolean {
  return s === 'accepted' || s === 'abandoned' || s === 'superseded';
}

/** Bir görevde izin verilen en fazla düzeltme işi. */
export const MAX_CORRECTIONS = 5;
