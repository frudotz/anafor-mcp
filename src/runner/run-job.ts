import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { RunHandle, WorkerEvent } from '../adapters/types.js';
import {
  extractJson,
  validateWorkerResult,
  WORKER_RESULT_SCHEMA_PATH,
} from '../contracts/worker-result.js';
import { nowIso } from '../core/ids.js';
import { compilePrompt } from '../core/prompt.js';
import { ACTIVE_JOB_STATES } from '../core/states.js';
import { StoreError, type Job, type Store, type TokenUsage } from '../store/store.js';

export interface RunJobOptions {
  env?: NodeJS.ProcessEnv;
}

function summarize(ev: WorkerEvent): string {
  switch (ev.type) {
    case 'session':
      return ev.sessionRef;
    case 'message':
      return ev.text.slice(0, 300);
    case 'command':
      return `${ev.command.slice(0, 200)} → ${ev.exitCode ?? '?'}`;
    case 'file_change':
      return `${ev.kind} ${ev.path}`;
    case 'usage':
      return `in=${ev.inputTokens ?? '?'} out=${ev.outputTokens ?? '?'}`;
    case 'error':
      return `${ev.fatal ? 'FATAL ' : ''}${ev.message.slice(0, 300)}`;
  }
}

/** Geçiş başka bir süreç (ör. job_cancel) tarafından önce yapıldıysa sessizce yok sayar. */
function tryTransition(fn: () => Job): Job | null {
  try {
    return fn();
  } catch (e) {
    if (e instanceof StoreError && e.code === 'INVALID_STATE') return null;
    throw e;
  }
}

/** Görevin tüm işleri bittiyse görevi incelemeye alır. */
function settleTask(store: Store, taskId: string): void {
  const task = store.getTask(taskId);
  if (!task || task.state !== 'in_progress') return;
  if (store.listJobs({ taskId, states: ACTIVE_JOB_STATES }).length === 0) {
    store.updateTask(taskId, { state: 'in_review' });
  }
}

/**
 * Bir işi baştan sona yürütür: prompt → adaptör → olaylar → doğrulama → son durum.
 * Ayrık runner sürecinde veya testlerde süreç içinde çağrılır.
 */
export async function runJob(
  store: Store,
  jobId: string,
  adapters: AdapterRegistry,
  opts: RunJobOptions = {},
): Promise<Job> {
  const job = store.mustGetJob(jobId);
  const task = store.mustGetTask(job.taskId);
  const artifactsDir = store.paths.jobDir(job.id);
  mkdirSync(artifactsDir, { recursive: true });
  const eventsFile = join(artifactsDir, 'events.jsonl');

  const fail = (error: string, to: 'failed' | 'timed_out' | 'cancelled' = 'failed') => {
    store.appendEvent(job.id, 'error', error);
    tryTransition(() => store.transitionJob(job.id, to, { error, endedAt: nowIso() }));
    settleTask(store, job.taskId);
    return store.mustGetJob(job.id);
  };

  if (!tryTransition(() => store.transitionJob(job.id, 'starting'))) {
    return store.mustGetJob(job.id); // iptal edilmiş veya zaten başlatılmış
  }

  const adapter = adapters.get(job.worker);
  if (!adapter) return fail(`Bilinmeyen işçi: ${job.worker}`);

  const prompt = compilePrompt(task, job, {
    ...(job.inputs.findings ? { findings: job.inputs.findings } : {}),
  });
  writeFileSync(join(artifactsDir, 'prompt.md'), prompt);

  const spec = {
    jobId: job.id,
    taskId: job.taskId,
    role: job.role,
    model: job.model ?? undefined,
    prompt,
    outputSchemaPath: WORKER_RESULT_SCHEMA_PATH,
    workdir: job.workdir,
    sandbox:
      job.workspaceMode === 'readonly' ? ('read-only' as const) : ('workspace-write' as const),
    timeoutMs: job.timeoutS * 1000,
    resumeSessionRef: job.sessionRef ?? undefined,
  };
  const ctx = { artifactsDir, env: opts.env ?? process.env };

  let handle: RunHandle;
  try {
    handle =
      job.sessionRef && adapter.resume ? adapter.resume(spec, ctx) : adapter.start(spec, ctx);
  } catch (e) {
    return fail(`Başlatma hatası: ${(e as Error).message}`);
  }

  if (
    !tryTransition(() =>
      store.transitionJob(job.id, 'running', { pid: handle.pid ?? null, startedAt: nowIso() }),
    )
  ) {
    await handle.cancel('cancel');
    return store.mustGetJob(job.id);
  }

  const timer = setTimeout(() => void handle.cancel('timeout'), spec.timeoutMs);
  let usage = null as TokenUsage | null;
  let lastError: string | null = null;
  try {
    for await (const ev of handle.events) {
      appendFileSync(eventsFile, JSON.stringify({ ts: nowIso(), ...ev }) + '\n');
      store.appendEvent(job.id, ev.type, summarize(ev));
      if (ev.type === 'session') store.patchJob(job.id, { sessionRef: ev.sessionRef });
      if (ev.type === 'error') lastError = ev.message;
      if (ev.type === 'usage') {
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + (ev.inputTokens ?? 0),
          cachedInputTokens: (usage?.cachedInputTokens ?? 0) + (ev.cachedInputTokens ?? 0),
          outputTokens: (usage?.outputTokens ?? 0) + (ev.outputTokens ?? 0),
          reasoningOutputTokens:
            (usage?.reasoningOutputTokens ?? 0) + (ev.reasoningOutputTokens ?? 0),
        };
        store.patchJob(job.id, { usage });
      }
    }
  } finally {
    clearTimeout(timer);
  }
  const outcome = await handle.done;

  if (outcome.sessionRef) {
    store.patchJob(job.id, { sessionRef: outcome.sessionRef });
    store.saveSession(job.taskId, job.role, job.worker, outcome.sessionRef, job.id);
  }
  if (outcome.timedOut) return fail(`Zaman aşımı (${job.timeoutS} sn)`, 'timed_out');
  if (outcome.cancelled) return fail('İptal edildi', 'cancelled');
  if (outcome.exitCode !== 0) {
    return fail(`İşçi çıkış kodu ${outcome.exitCode}${lastError ? `: ${lastError}` : ''}`);
  }

  if (!tryTransition(() => store.transitionJob(job.id, 'validating', { exitCode: 0 }))) {
    return store.mustGetJob(job.id);
  }

  let parsed: unknown;
  try {
    parsed = extractJson(outcome.finalMessage ?? '');
  } catch (e) {
    return invalid(`Son mesaj JSON değil: ${(e as Error).message}`);
  }
  const v = validateWorkerResult(parsed, { taskId: job.taskId, jobId: job.id, role: job.role });
  if (!v.ok) return invalid(v.errors.join('; '));

  writeFileSync(join(artifactsDir, 'result.json'), JSON.stringify(v.value, null, 2));
  store.transitionJob(job.id, 'needs_review', {
    result: v.value,
    warnings: v.warnings,
    endedAt: nowIso(),
  });
  settleTask(store, job.taskId);
  return store.mustGetJob(job.id);

  function invalid(error: string): Job {
    store.appendEvent(job.id, 'error', `invalid_output: ${error}`);
    store.transitionJob(job.id, 'invalid_output', { error, endedAt: nowIso() });
    settleTask(store, job.taskId);
    return store.mustGetJob(job.id);
  }
}
