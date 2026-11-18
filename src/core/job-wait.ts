import { isJobWaitComplete } from './states.js';
import type { Job, JobEvent } from '../store/store.js';

export interface JobWaitStore {
  mustGetJob(id: string): Job;
  listEvents(id: string, sinceSeq?: number, limit?: number): JobEvent[];
}

/** Long-running CLI wait loop, with time and sleeping injected for deterministic tests. */
export async function waitForJobs(
  store: JobWaitStore,
  ids: string[],
  options: {
    mode: 'any' | 'all';
    timeoutS?: number;
    silenceS: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    onSilence?: (job: Job) => void;
    pollMs?: number;
  },
) {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const deadline = options.timeoutS === undefined ? Infinity : started + options.timeoutS * 1000;
  const activity = new Map(ids.map((id) => [id, { seq: 0, at: started, warned: false }]));
  for (;;) {
    const jobs = ids.map((id) => store.mustGetJob(id));
    for (const job of jobs) {
      const state = activity.get(job.id)!;
      const events = store.listEvents(job.id, state.seq, 200);
      if (events.length) {
        state.seq = events[events.length - 1]!.seq;
        state.at = now();
        state.warned = false;
      }
      if (
        !isJobWaitComplete(job.state) &&
        !state.warned &&
        now() - state.at >= options.silenceS * 1000
      ) {
        state.warned = true;
        options.onSilence?.(job);
      }
    }
    const finished = jobs.filter((j) => isJobWaitComplete(j.state));
    const pending = jobs.filter((j) => !isJobWaitComplete(j.state));
    if ((options.mode === 'any' ? finished.length > 0 : pending.length === 0) || now() >= deadline)
      return {
        finished,
        pending,
        timedOut:
          now() >= deadline &&
          (options.mode === 'all' ? pending.length > 0 : finished.length === 0),
      };
    await sleep(Math.min(options.pollMs ?? 500, Math.max(1, deadline - now())));
  }
}
