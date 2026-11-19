import { describe, expect, it } from 'vitest';
import { waitForJobs, type JobWaitStore } from '../../src/core/job-wait.js';
import type { Job, JobEvent } from '../../src/store/store.js';

function harness() {
  let time = 0;
  const jobs = new Map<string, Job>([
    [
      'a',
      {
        id: 'a',
        state: 'running',
        worker: 'codex',
        startedAt: new Date(0).toISOString(),
        endedAt: null,
        result: null,
      } as Job,
    ],
    [
      'b',
      {
        id: 'b',
        state: 'running',
        worker: 'cirak',
        startedAt: new Date(0).toISOString(),
        endedAt: null,
        result: null,
      } as Job,
    ],
  ]);
  const events = new Map<string, JobEvent[]>([
    ['a', []],
    ['b', []],
  ]);
  const store: JobWaitStore = {
    mustGetJob(id) {
      const job = jobs.get(id);
      if (!job) throw new Error(`unknown job ${id}`);
      return job;
    },
    listEvents(id, seq = 0) {
      return events.get(id)!.filter((e) => e.seq > seq);
    },
  };
  return {
    jobs,
    events,
    store,
    now: () => time,
    advance: (ms: number, complete = true) => {
      time += ms;
      if (complete && time >= 1000) jobs.get('a')!.state = 'needs_review';
      if (complete && time >= 2000) jobs.get('b')!.state = 'failed';
    },
    sleep: async (ms: number) => {
      time += ms;
      if (time >= 1000) jobs.get('a')!.state = 'needs_review';
      if (time >= 2000) jobs.get('b')!.state = 'failed';
    },
  };
}

describe('waitForJobs', () => {
  it('returns on any or all completion using shared wait states', async () => {
    const any = harness();
    expect(
      (await waitForJobs(any.store, ['a', 'b'], { mode: 'any', silenceS: 300, ...any })).finished,
    ).toHaveLength(1);
    const all = harness();
    expect(
      (await waitForJobs(all.store, ['a', 'b'], { mode: 'all', silenceS: 300, ...all })).finished,
    ).toHaveLength(2);
  });

  it('reports timeout with pending jobs', async () => {
    const h = harness();
    const result = await waitForJobs(h.store, ['b'], {
      mode: 'all',
      timeoutS: 1,
      silenceS: 300,
      ...h,
    });
    expect(result.timedOut).toBe(true);
    expect(result.pending.map((j) => j.id)).toEqual(['b']);
  });

  it('warns once per silence period and resets after an event', async () => {
    const h = harness();
    const warnings: string[] = [];
    let calls = 0;
    const sleep = async (ms: number) => {
      h.advance(ms, false);
      calls++;
      if (calls === 3)
        h.events.get('b')!.push({ jobId: 'b', seq: 1, ts: '', type: 'progress', summary: '' });
    };
    const result = await waitForJobs(h.store, ['b'], {
      mode: 'all',
      timeoutS: 3,
      silenceS: 1,
      now: h.now,
      sleep,
      onSilence: (job) => warnings.push(job.id),
    });
    expect(result.timedOut).toBe(true);
    expect(warnings).toHaveLength(2);
  });

  it('rejects unknown ids', async () => {
    const h = harness();
    await expect(
      waitForJobs(h.store, ['missing'], { mode: 'all', silenceS: 1, ...h }),
    ).rejects.toThrow('unknown job');
  });
});
