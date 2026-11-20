import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { BrainSession } from '../chat/brain.js';
import { loadConfig } from '../core/config.js';
import { createCheckpoint } from '../governance/checkpoint.js';
import { currentLimits } from '../limits/limits.js';
import {
  acquireLoopLock,
  readLoopState,
  releaseLoopLock,
  setLoopBrainPid,
  cleanupLoopProcess,
  writeLoopState,
  updateLoopHeartbeat,
  type LoopState,
} from '../loop/state.js';
import { parseLoopCompletion, runLoop } from '../loop/run.js';
import { readSetupState } from '../setup/setup.js';
import { m } from '../i18n/index.js';
import { runBrainTurn } from '../loop/brain-turn.js';
import type { SetupState } from '../setup/setup.js';
import { TOKEN_PROFILES, type TokenProfile } from '../core/token-profile.js';
import { spawnSync } from 'node:child_process';
import { Store } from '../store/store.js';
import { ACTIVE_JOB_STATES } from '../core/states.js';
import { defaultAdapters } from '../adapters/registry.js';
import { AnaforService } from '../server/service.js';
import {
  shouldShutdown,
  loopControlChanged,
  planShutdownCommand,
  scheduleShutdown,
  shutdownStartNotice,
  applyShutdownResult,
  cancelScheduledShutdown,
  markShutdownCancelled,
  isShutdownTerminal,
  waitForJobs,
} from '../loop/shutdown.js';
import { recoverEnabled, recoverLoop } from '../loop/recover.js';
import { watchdogCommand } from '../loop/watchdog.js';

export function defaultLoopProfile(
  override: string | undefined,
  setup: SetupState | null,
): Exclude<TokenProfile, 'off'> {
  if (override === 'economy' || override === 'saver') return 'saver';
  if (override === 'balanced' || override === 'quality') return override;
  return setup?.subscriptions?.includes('claude-pro') ? 'saver' : 'balanced';
}

export function createLoopShutdownHandler(
  root: string,
  killBrain: () => void,
): (reason: string) => void {
  let handled = false;
  return (reason) => {
    if (handled) return;
    handled = true;
    cleanupLoopProcess(root, reason, killBrain);
  };
}

export function loopSignals(platform = process.platform): readonly string[] {
  return platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM', 'SIGHUP'];
}

export async function runLoopCommand(
  root: string,
  args: string[],
  injected: Pick<LoopExecuteDeps, 'shutdownRunner'> = {},
): Promise<number> {
  const action = args[0];
  let state = readLoopState(root);
  if (action === 'recover') {
    if (loadConfig(root).loop.recover_on_crash && recoverEnabled(root)) await recoverLoop(root);
    return 0;
  }
  if (action === '_recover-resume') {
    if (state?.state !== 'running') return 0;
    return execute(root, state, false, {}, true);
  }
  if (action === 'watchdog') {
    const result = watchdogCommand(args[1] ?? '', process.platform, undefined, root);
    for (const line of result.lines) console.log(line);
    return result.code;
  }
  if (action === 'status') {
    console.log(JSON.stringify(state, null, 2) ?? 'null');
    return 0;
  }
  if (action === 'pause' || action === 'stop') {
    if (!state) return 1;
    const shutdownWait =
      (state.shutdown_pending || (state.shutdown_on_finish && !state.shutdown_scheduled_at)) &&
      isShutdownTerminal(state);
    if (shutdownWait) {
      markShutdownCancelled(root);
      console.log(m().cli.loopShutdownCancelled);
      return 0;
    }
    if (state.shutdown_scheduled_at && isShutdownTerminal(state)) {
      const result = cancelScheduledShutdown(state, process.platform, (cmd, commandArgs) =>
        (
          injected.shutdownRunner ??
          ((c, a) => spawnSync(c, a, { encoding: 'utf8', windowsHide: true, timeout: 30_000 }))
        )(cmd, commandArgs),
      );
      if (result.attempted) {
        if (result.error) {
          const message = m().cli.loopShutdownCancelFailed(
            result.error,
            result.state.shutdown_cancel_command ?? '',
          );
          console.warn(message);
          appendFileSync(
            join(root, '.anafor', 'loop.log'),
            `${new Date().toISOString()} ${message}\n`,
          );
        }
        writeLoopState(root, result.state);
        console.log(
          result.error
            ? m().cli.loopShutdownCancelFailed(
                result.error,
                result.state.shutdown_cancel_command ?? '',
              )
            : m().cli.loopShutdownCancelled,
        );
        return result.error ? 1 : 0;
      }
    }
    writeLoopState(root, {
      ...state,
      state: action === 'stop' ? 'stopped' : 'paused',
      paused_reason: action === 'pause' ? 'manual' : 'stopped',
    });
    return 0;
  }
  if (action === 'resume') {
    if (!state) return 1;
    state = { ...state, state: 'running', paused_reason: null, resume_at: null };
    return execute(root, state);
  }
  if (action !== 'start') {
    console.error(m().cli.loopUsage);
    return 2;
  }
  const value = (name: string) => {
    const i = args.indexOf(`--${name}`);
    return i < 0 ? undefined : args[i + 1];
  };
  const backlog = value('backlog');
  const valueFlags = new Set(['--backlog', '--max-cycles', '--until', '--profile', '--model']);
  const positionals: string[] = [];
  for (let i = 1; i < args.length; i++) {
    if (valueFlags.has(args[i]!)) {
      i++;
      continue;
    }
    if (!args[i]!.startsWith('-')) positionals.push(args[i]!);
  }
  const goal = positionals.join(' ').trim() || undefined;
  const maxCycles = value('max-cycles');
  const until = value('until');
  const profileArg = value('profile');
  if (
    (!goal && !backlog) ||
    (goal && backlog) ||
    (maxCycles !== undefined && (!/^\d+$/.test(maxCycles) || Number(maxCycles) <= 0)) ||
    (until !== undefined &&
      (!/^\d{4}-\d\d-\d\dT/.test(until) || !Number.isFinite(Date.parse(until)))) ||
    (profileArg !== undefined && !['economy', 'saver', 'balanced', 'quality'].includes(profileArg))
  ) {
    console.error(m().cli.loopUsage);
    return 2;
  }
  const setup = readSetupState();
  const stateNew: LoopState = {
    state: 'running',
    ...(goal ? { goal } : { backlog }),
    cycle: 0,
    session_id: null,
    started_at: new Date().toISOString(),
    paused_reason: null,
    resume_at: null,
    auto_resume: args.includes('--auto-resume'),
    max_cycles: maxCycles ? Number(maxCycles) : null,
    until: until ?? null,
    last_task: null,
    completed_items: [],
    accept: args.includes('--accept'),
    merge: args.includes('--merge'),
    profile: defaultLoopProfile(profileArg, setup),
    model: value('model') ?? loadConfig(root).brain.model,
    shutdown_on_finish:
      args.includes('--shutdown-on-finish') || loadConfig(root).loop.on_finish === 'shutdown',
  };
  if (args.includes('--detach')) {
    const childArgs = args.filter((a) => a !== '--detach');
    const child = spawn(
      process.execPath,
      [process.argv[1]!, 'loop', ...childArgs, '--_detached-child'],
      {
        cwd: root,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    );
    child.unref();
    if (child.pid === undefined) return 1;
    for (let tries = 0; tries < 100; tries++) {
      try {
        const liveState = JSON.parse(readFileSync(join(root, '.anafor', 'loop.json'), 'utf8')) as {
          pid?: number;
        };
        if (liveState.pid === child.pid) {
          const notice = shutdownStartNotice(
            stateNew.shutdown_on_finish ?? false,
            process.platform,
            m().cli.loopShutdownWarning,
          );
          console.log(`${m().cli.loopStarted}${notice ? `\n${notice}` : ''}`);
          return 0;
        }
      } catch {
        /* child has not acquired lock yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return 1;
  }
  if (!acquireLoopLock(root)) {
    console.error(m().cli.loopLocked);
    return 1;
  }
  writeLoopState(root, { ...stateNew, pid: process.pid, heartbeat_at: new Date().toISOString() });
  console.log(m().cli.loopStarted);
  return execute(root, stateNew, true);
}

export interface LoopExecuteDeps {
  shutdownRunner?: (
    cmd: string,
    args: string[],
  ) => { status: number | null; error?: Error; stderr?: string };
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  loopRunner?: typeof runLoop;
}

export async function execute(
  root: string,
  state: LoopState,
  lockHeld = false,
  injected: LoopExecuteDeps = {},
  onlyIfRunning = false,
): Promise<number> {
  if (!lockHeld && !acquireLoopLock(root)) {
    console.error(m().cli.loopLocked);
    return 1;
  }
  let activeBrain: BrainSession | null = null;
  const shutdown = createLoopShutdownHandler(root, () => activeBrain?.kill());
  const onExit = () => shutdown('process exit');
  const signals = loopSignals();
  const onSignal = (signal: (typeof signals)[number]) => {
    shutdown(`signal: ${signal}`);
    process.exit(
      128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : signal === 'SIGHUP' ? 1 : 21),
    );
  };
  for (const signal of signals) process.on(signal, onSignal);
  process.on('exit', onExit);
  const heartbeat = setInterval(() => updateLoopHeartbeat(root), 60_000);
  try {
    const current = readLoopState(root);
    if (onlyIfRunning && current?.state !== 'running') return 0;
    if (onlyIfRunning) state = current!;
    state = {
      ...state,
      state: 'running',
      paused_reason: null,
      resume_at: null,
      pid: process.pid,
      shutdown_pending: false,
      shutdown_cancelled: false,
      shutdown_scheduled_at: null,
      shutdown_cancel_command: null,
      shutdown_error: null,
    };
    state = { ...state, profile: defaultLoopProfile(state.profile, readSetupState()) };
    writeLoopState(root, state);
    const cfg = loadConfig(root);
    const shutdownPlan = planShutdownCommand(process.platform);
    if (state.shutdown_on_finish) {
      const warning = m().cli.loopShutdownWarning(shutdownPlan.cancel);
      console.warn(warning);
      appendFileSync(join(root, '.anafor', 'loop.log'), `${new Date().toISOString()} ${warning}\n`);
    }
    const model = state.model ?? cfg.brain.model;
    const profile = defaultLoopProfile(state.profile, readSetupState());
    const run = injected.loopRunner ?? runLoop;
    const final = await run({
      root,
      state,
      brain: {
        async turn(prompt, options) {
          const result = await runBrainTurn(
            (onEvent) => {
              activeBrain = new BrainSession(
                {
                  root,
                  model,
                  effort: cfg.brain.effort ?? TOKEN_PROFILES[profile].implementation,
                  lean: cfg.brain.lean,
                  merge: state.merge,
                  isolated: true,
                  sessionId: options.sessionId ?? undefined,
                  resumeSessionId: options.resume ? (options.sessionId ?? undefined) : undefined,
                  newSession: !options.resume && options.sessionId === null,
                },
                onEvent,
              );
              return activeBrain;
            },
            prompt,
            Math.max(1, cfg.loop.turn_timeout_min) * 60_000,
            10_000,
            (pid) => setLoopBrainPid(root, pid),
          );
          activeBrain = null;
          setLoopBrainPid(root, null);
          return {
            ...result,
            ...(result.resultText !== undefined
              ? { completion: parseLoopCompletion(result.resultText) }
              : {}),
          };
        },
      },
      now: Date.now,
      sleep: injected.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
      readLimits: () => currentLimits('claude'),
      checkpoint: () =>
        createCheckpoint(root, join(root, '.anafor', 'checkpoints'), {
          projectId: root,
          taskId: null,
          actor: 'loop',
          reason: 'limit pause',
        }),
      log: console.log,
      limitConfig: cfg.limits.brain,
      minTurnGapSec: cfg.loop.min_turn_gap_sec,
    });
    const onFinish =
      state.shutdown_on_finish || cfg.loop.on_finish === 'shutdown' ? 'shutdown' : 'none';
    const postRunState = readLoopState(root);
    if (
      postRunState?.state === 'stopped' ||
      postRunState?.shutdown_cancelled ||
      (postRunState?.state === 'paused' && postRunState.paused_reason === 'manual')
    )
      return 0;
    if (state.shutdown_on_finish && shouldShutdown(final, onFinish)) {
      final.shutdown_pending = true;
      final.shutdown_cancelled = false;
      final.shutdown_cancel_command = shutdownPlan.cancel;
      writeLoopState(root, final);
      const store = new Store(root);
      const active = () => store.listJobs({ states: ACTIVE_JOB_STATES });
      const service = new AnaforService(
        store,
        defaultAdapters(cfg),
        undefined,
        cfg.default_worker,
        cfg.routing,
        cfg.routing_mode,
        cfg.max_parallel_jobs,
      );
      try {
        const completedWait = await waitForJobs(
          active,
          (id) => {
            try {
              service.jobCancel(id, 'Loop shutdown timeout');
            } catch {
              /* Job finished during the timeout race. */
            }
          },
          injected.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
          30 * 60_000,
          () => {
            const liveState = readLoopState(root);
            return liveState?.shutdown_cancelled === true || loopControlChanged(final, liveState);
          },
          injected.now,
        );
        if (!completedWait) return 0;
      } finally {
        store.close();
      }
      const live = readLoopState(root);
      if (live?.shutdown_cancelled || loopControlChanged(final, live)) return 0;
      const plan = shutdownPlan;
      console.warn(m().cli.loopShutdownScheduled(plan.cancel));
      appendFileSync(
        join(root, '.anafor', 'loop.log'),
        `${new Date().toISOString()} ${m().cli.loopShutdownScheduled(plan.cancel)}\n`,
      );
      const error = scheduleShutdown(
        plan,
        injected.shutdownRunner ??
          ((cmd, commandArgs) =>
            spawnSync(cmd, commandArgs, { encoding: 'utf8', windowsHide: true, timeout: 30_000 })),
      );
      const afterCommand = readLoopState(root);
      if (!error && afterCommand?.shutdown_cancelled) {
        const cancelled = cancelScheduledShutdown(
          { ...final, shutdown_scheduled_at: new Date((injected.now ?? Date.now)()).toISOString() },
          process.platform,
          injected.shutdownRunner ??
            ((cmd, commandArgs) =>
              spawnSync(cmd, commandArgs, {
                encoding: 'utf8',
                windowsHide: true,
                timeout: 30_000,
              })),
        );
        Object.assign(final, cancelled.state, { shutdown_pending: false });
        if (cancelled.error) {
          const message = m().cli.loopShutdownCancelFailed(cancelled.error, plan.cancel);
          console.warn(message);
          appendFileSync(
            join(root, '.anafor', 'loop.log'),
            `${new Date().toISOString()} ${message}\n`,
          );
        }
        writeLoopState(root, final);
        return 0;
      }
      const resultState = applyShutdownResult(
        final,
        plan,
        error,
        new Date((injected.now ?? Date.now)()).toISOString(),
      );
      if (error) console.warn(m().cli.loopShutdownFailed(error));
      Object.assign(final, resultState);
      final.shutdown_pending = false;
      writeLoopState(root, final);
    }
    if (
      (final.state === 'paused' || final.state === 'stopped') &&
      final.paused_reason?.startsWith('error:')
    ) {
      console.error(final.paused_reason);
      return 1;
    }
    return final.state === 'paused' ? 3 : 0;
  } finally {
    clearInterval(heartbeat);
    process.off('exit', onExit);
    for (const signal of signals) process.off(signal, onSignal);
    releaseLoopLock(root);
  }
}
