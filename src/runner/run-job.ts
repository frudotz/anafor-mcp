import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AdapterRegistry } from '../adapters/registry.js';
import type { RunHandle, WorkerEvent } from '../adapters/types.js';
import {
  extractJson,
  validateWorkerResult,
  WORKER_RESULT_SCHEMA_PATH,
} from '../contracts/worker-result.js';
import { loadConfig } from '../core/config.js';
import { jobDeltas, recordJobCost } from '../capacity/capacity.js';
import {
  currentLimits,
  formatWindows,
  limitAccount,
  recordLimits,
  statusFrom,
  rateLimitedUntil,
  recordRateLimitedUntil,
} from '../limits/limits.js';
import { nowIso } from '../core/ids.js';
import { memoryContext } from '../core/memory-context.js';
import { applyDepCache } from '../git/dep-cache.js';
import { git } from '../git/git.js';
import { compilePrompt } from '../core/prompt.js';
import { resolveEffort } from '../core/token-profile.js';
import { recordMemoryMetric } from '../governance/memory.js';
import { ACTIVE_JOB_STATES } from '../core/states.js';
import { isRateLimitError } from '../core/rate-limit.js';
import { detectTestCommand, generateTestEvidenceAsync } from '../governance/evidence.js';
import { StoreError, type Job, type Store, type TokenUsage } from '../store/store.js';
import { m } from '../i18n/index.js';

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
    case 'limits':
      return formatWindows(ev.windows);
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

  // Yeni worktree'de bağımlılık kurulumu (config: worktree_setup).
  const config = loadConfig(store.paths.root);
  const setup = config.worktree_setup;
  const failoverContinuation =
    job.parentJobId !== null && store.getJob(job.parentJobId)?.state === 'failed_over';
  const freshWorktree =
    job.workspaceMode === 'worktree' &&
    !job.isCorrection &&
    !job.sessionRef &&
    !failoverContinuation;
  // Bağımlılık önbelleği (config: worktree_cache): uygulanırsa worktree_setup atlanır.
  let cached = false;
  if (config.worktree_cache && freshWorktree) {
    const c = await applyDepCache(store.paths.root, job.workdir, config.worktree_cache);
    cached = c.applied;
    store.appendEvent(
      job.id,
      'cache',
      c.applied
        ? `${config.worktree_cache.paths.join(', ')}: ${c.files} dosya hardlink, ${c.ms} ms`
        : `önbellek kullanılmadı: ${c.reason}`,
    );
  }
  if (setup && freshWorktree && !cached) {
    store.appendEvent(job.id, 'setup', setup);
    const r = spawnSync(setup, {
      cwd: job.workdir,
      shell: true,
      encoding: 'utf8',
      timeout: 15 * 60_000,
      windowsHide: true,
    });
    writeFileSync(
      join(artifactsDir, 'setup.log'),
      `${r.stdout ?? ''}
${r.stderr ?? ''}`,
    );
    if (r.status !== 0) return fail(`worktree_setup başarısız (${r.status}): ${setup}`);
  }

  // Yerel şema zorlaması olmayan işçilere şema prompt'ta verilir; çıktı extractJson ile ayıklanır.
  const prompted = adapter.capabilities().structuredOutput === 'prompted';
  // Lat.md hafızası: yalnızca yeni oturumlarda (düzeltme/devam oturumunda bağlam zaten var).
  const memory =
    config.memory_context && !job.isCorrection && !job.sessionRef
      ? memoryContext(store.paths.root, `${task.title} ${task.objective} ${job.instructions}`)
      : null;
  if (memory) {
    store.appendEvent(job.id, 'memory', `${memory.method}: ${memory.sections} bölüm`);
    try {
      recordMemoryMetric(join(store.paths.anaforDir, 'memory'), store.paths.projectId, {
        task_id: task.id,
        query_label: `job/${job.id}`,
        method: memory.method === 'lat-cli' ? 'lat-cli' : 'manual',
        index_status: 'unknown',
        query_count: 1,
        sections_retrieved: memory.sections,
        content_characters: memory.text.length,
        outcome: memory.method === 'lat-cli' ? 'completed' : 'manual-fallback',
      });
    } catch {
      // ölçüm işi durdurmaz
    }
  }
  const resumed = !!(job.sessionRef && adapter.resume);
  let environment: { working: string[]; unavailable: string[]; note: string } | undefined;
  if (config.env_probe !== false && job.worker === 'codex' && process.platform === 'win32') {
    try {
      const probeAdapter = adapter as typeof adapter & {
        probeEnvironment?: (
          cwd: string,
          tools: string[],
          cacheDir: string,
        ) => Promise<{ tools: Record<string, { ok: boolean; preferred?: string }> } | null>;
      };
      const command = config.test_command ?? detectTestCommand(job.workdir);
      const names = [
        'node',
        'git',
        'npm',
        'npx',
        'bun',
        'lat',
        'python',
        'cargo',
        ...(command ? [command.split(/\s+/)[0]!] : []),
      ];
      const result = await probeAdapter.probeEnvironment?.(
        job.workdir,
        names,
        store.paths.anaforDir,
      );
      if (result) {
        const working = Object.entries(result.tools)
          .filter(([, v]) => v.ok)
          .map(([n, v]) => v.preferred ?? n);
        const unavailable = Object.entries(result.tools)
          .filter(([, v]) => !v.ok)
          .map(([n]) => n);
        environment = {
          working,
          unavailable,
          note: 'Testleri Anafor iş sonrasında sandbox dışında çalıştıracak; çalışmayan araç için alternatif arama.',
        };
      }
    } catch {
      /* optional discovery must not fail a job */
    }
  }
  const prompt = compilePrompt(task, job, {
    ...(resumed ? { resumed } : {}),
    ...(memory ? { memory } : {}),
    ...(job.inputs.findings ? { findings: job.inputs.findings } : {}),
    ...(prompted ? { schemaText: readFileSync(WORKER_RESULT_SCHEMA_PATH, 'utf8') } : {}),
    ...(environment ? { environment } : {}),
    ...(job.inputs.reviewContext ? { reviewContext: job.inputs.reviewContext } : {}),
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
    effort: resolveEffort(config.token_profile, job.role, config.workers[job.worker]?.effort),
  };
  // ANAFOR_WORKER: işçi süreci (ör. cirak) yönetici hook'larına takılmasın.
  const ctx = { artifactsDir, env: { ...(opts.env ?? process.env), ANAFOR_WORKER: '1' } };

  // Kapasite ölçümü (F20): işten önceki limit gözlemi.
  const account = limitAccount(job.worker);
  const limitsBefore = currentLimits(account, opts.env);
  const startedMs = Date.now();

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
  let lastErrorFatal = false;
  let rateResetAt: number | null = null;
  try {
    for await (const ev of handle.events) {
      appendFileSync(eventsFile, JSON.stringify({ ts: nowIso(), ...ev }) + '\n');
      store.appendEvent(job.id, ev.type, summarize(ev));
      if (ev.type === 'session') store.patchJob(job.id, { sessionRef: ev.sessionRef });
      if (ev.type === 'error') {
        lastError = ev.message;
        lastErrorFatal ||= ev.fatal;
      }
      if (ev.type === 'limits') {
        const resets = ev.windows
          .filter((w) => w.used_percent >= config.failover.threshold_percent)
          .map((w) => w.resets_at)
          .filter((v): v is number => v !== null && v * 1000 > Date.now());
        if (resets.length) rateResetAt = Math.max(rateResetAt ?? 0, ...resets);
        recordLimits({
          worker: limitAccount(job.worker),
          source: `${job.worker} akışı`,
          observed_at: nowIso(),
          status: statusFrom(ev.windows),
          windows: ev.windows,
        });
      }
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
  learnCost();

  if (outcome.sessionRef) {
    store.patchJob(job.id, { sessionRef: outcome.sessionRef });
    store.saveSession(job.taskId, job.role, job.worker, outcome.sessionRef, job.id);
  }
  if (outcome.timedOut) return fail(`Zaman aşımı (${job.timeoutS} sn)`, 'timed_out');
  if (outcome.cancelled) return fail('İptal edildi', 'cancelled');
  const rateLimitError = lastError ?? '';
  const rateLimited =
    (outcome.exitCode !== 0 || lastErrorFatal) && isRateLimitError(rateLimitError);
  if (outcome.exitCode !== 0 || rateLimited) {
    const error = rateLimitError;
    if (rateLimited) {
      if (job.inputs.explicitWorker) {
        store.appendEvent(
          job.id,
          'failover',
          m().service.failoverExplicit(job.worker, error.slice(0, 200)),
        );
      } else if (config.failover.enabled) {
        const until = rateResetAt ?? Math.floor(Date.now() / 1000) + 15 * 60;
        recordRateLimitedUntil(job.worker, until, opts.env);
        const chain = [...new Set([...(config.routing[job.role] ?? []), config.default_worker])];
        const after = chain.slice(Math.max(0, chain.indexOf(job.worker) + 1));
        const alternate = (
          await Promise.all(
            after.map(async (id) => {
              const candidate = adapters.get(id);
              if (!candidate || !candidate.capabilities().roles.includes(job.role)) return null;
              const reviewTargetWorker = job.inputs.reviewContext?.targetWorker;
              if (
                job.role === 'review' &&
                (limitAccount(id) === limitAccount(job.worker) ||
                  (reviewTargetWorker !== undefined &&
                    limitAccount(id) === limitAccount(reviewTargetWorker)))
              )
                return null;
              if (rateLimitedUntil(id, opts.env)) return null;
              const limit = currentLimits(limitAccount(id), opts.env);
              const now = Date.now() / 1000;
              if (
                limit?.windows.some(
                  (w) =>
                    (w.used_percent >= 100 ||
                      ((w.name.startsWith('five_hour') || w.name.startsWith('seven_day')) &&
                        w.used_percent >= config.failover.threshold_percent)) &&
                    (w.resets_at === null || w.resets_at > now),
                )
              )
                return null;
              if (
                store.listJobs({ states: ACTIVE_JOB_STATES }).filter((j) => j.worker === id)
                  .length >= candidate.capabilities().maxConcurrency
              )
                return null;
              const detected = await candidate.detect();
              return detected.available && detected.authOk !== false ? id : null;
            }),
          )
        ).find((id): id is string => id !== null);
        if (alternate) {
          let next: Job | null = null;
          store.db.exec('BEGIN IMMEDIATE');
          try {
            if (!store.listJobs({ taskId: job.taskId }).some((j) => j.state === 'failed_over')) {
              next = store.createJob({
                taskId: job.taskId,
                role: job.role,
                worker: alternate,
                model: config.workers[alternate]?.model ?? null,
                workspaceMode: job.workspaceMode,
                workdir: job.workdir,
                branch: job.branch,
                instructions: `${job.instructions}\n\n${m().service.failoverContinuation}`,
                inputs: { ...job.inputs, explicitWorker: false },
                timeoutS: job.timeoutS,
                baseSha: job.baseSha,
                parentJobId: job.id,
              });
              store.transitionJob(job.id, 'failed_over', {
                error: `Rate limit: ${error.slice(0, 300)}`,
                endedAt: nowIso(),
                inputs: { ...job.inputs, failoverJobId: next.id },
              });
              store.appendEvent(
                job.id,
                'failover',
                m().service.failoverTransferred(job.worker, alternate, next.id),
              );
            }
            store.db.exec('COMMIT');
          } catch (e) {
            store.db.exec('ROLLBACK');
            throw e;
          }
          if (next) {
            settleTask(store, job.taskId);
            await runJob(store, next.id, adapters, opts);
            return store.mustGetJob(job.id);
          }
        }
      }
    }
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
  let resultWarnings = v.warnings;
  if (config.auto_check && job.role === 'implementation' && job.workspaceMode === 'worktree') {
    const command = config.test_command ?? detectTestCommand(job.workdir);
    const evidenceDir = join(store.paths.root, '.anafor', 'evidence');
    if (command) {
      const checked = await generateTestEvidenceAsync(
        store.paths.root,
        job.workdir,
        evidenceDir,
        `${job.taskId}-${job.id}-auto`,
        command,
        config.auto_check_timeout_s * 1000,
      );
      const autoCheck = {
        command,
        passed: checked.passed,
        exit_code: checked.passed ? 0 : 1,
        summary: checked.summary,
        evidence: checked.path,
        workdir: job.workdir,
        head_sha: git(job.workdir, ['rev-parse', 'HEAD']).stdout.trim() || undefined,
      };
      store.patchJob(job.id, { autoCheck });
      writeFileSync(
        join(evidenceDir, `${job.taskId}-${job.id}-auto-check.json`),
        JSON.stringify(autoCheck, null, 2),
      );
      store.appendEvent(job.id, 'auto_check', `${command} → ${autoCheck.exit_code}`);
    } else {
      resultWarnings = [...v.warnings, 'auto_check: test komutu bulunamadı'];
      store.appendEvent(job.id, 'auto_check', 'Test komutu bulunamadı; otomatik kontrol atlandı');
    }
  }
  store.transitionJob(job.id, 'needs_review', {
    result: v.value,
    warnings: resultWarnings,
    endedAt: nowIso(),
  });
  settleTask(store, job.taskId);
  return store.mustGetJob(job.id);

  /** İş tek başına çalıştıysa (aynı hesapta başka iş yoksa) pencere farkını maliyet olarak kaydet. */
  function learnCost(): void {
    try {
      const others = store
        .listJobs({ states: ACTIVE_JOB_STATES })
        .filter((j) => j.id !== job.id && limitAccount(j.worker) === account);
      if (others.length) return;
      const deltas = jobDeltas(limitsBefore, currentLimits(account, opts.env), startedMs);
      recordJobCost(account, job.role, deltas, opts.env);
      if (Object.keys(deltas).length) {
        store.appendEvent(
          job.id,
          'capacity',
          Object.entries(deltas)
            .map(([w, d]) => `${w} +${d} KP`)
            .join(', '),
        );
      }
    } catch {
      // ölçüm işi durdurmaz
    }
  }

  function invalid(error: string): Job {
    store.appendEvent(job.id, 'error', `invalid_output: ${error}`);
    store.transitionJob(job.id, 'invalid_output', { error, endedAt: nowIso() });
    settleTask(store, job.taskId);
    return store.mustGetJob(job.id);
  }
}
