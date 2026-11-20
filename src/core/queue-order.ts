import type { Job, Priority } from '../store/store.js';

const PRIORITY_RANK: Record<Priority, number> = { critical: 0, high: 1, normal: 2, low: 3 };

/** Shared queue ordering: task priority first, then creation order (stable FIFO). */
export function sortQueuedJobs(jobs: Job[], priorityOf: (taskId: string) => Priority): Job[] {
  return [...jobs].sort(
    (a, b) =>
      PRIORITY_RANK[priorityOf(a.taskId)] - PRIORITY_RANK[priorityOf(b.taskId)] ||
      a.createdAt.localeCompare(b.createdAt),
  );
}

export function queuePositions(
  jobs: Job[],
  priorityOf: (taskId: string) => Priority,
): Map<string, number> {
  return new Map(sortQueuedJobs(jobs, priorityOf).map((job, index) => [job.id, index + 1]));
}
