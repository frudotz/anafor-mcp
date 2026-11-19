import { readFileSync } from 'node:fs';
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
  type LoopState,
} from '../loop/state.js';
import { parseLoopCompletion, runLoop } from '../loop/run.js';
import { readSetupState } from '../setup/setup.js';
import { m } from '../i18n/index.js';
import { runBrainTurn } from '../loop/brain-turn.js';
import type { SetupState } from '../setup/setup.js';
import { TOKEN_PROFILES, type TokenProfile } from '../core/token-profile.js';

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

export async function runLoopCommand(root: string, args: string[]): Promise<number> {
  const action = args[0];
  let state = readLoopState(root);
  if (action === 'status') {
    console.log(JSON.stringify(state, null, 2) ?? 'null');
    return 0;
  }
  if (action === 'pause' || action === 'stop') {
    if (!state) return 1;
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
    model: value('model'),
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
          console.log(m().cli.loopStarted);
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
  writeLoopState(root, { ...stateNew, pid: process.pid });
  console.log(m().cli.loopStarted);
  return execute(root, stateNew, true);
}

async function execute(root: string, state: LoopState, lockHeld = false): Promise<number> {
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
  try {
    state = { ...state, state: 'running', paused_reason: null, resume_at: null, pid: process.pid };
    state = { ...state, profile: defaultLoopProfile(state.profile, readSetupState()) };
    writeLoopState(root, state);
    const cfg = loadConfig(root);
    const model = state.model;
    const profile = defaultLoopProfile(state.profile, readSetupState());
    const final = await runLoop({
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
                  effort: TOKEN_PROFILES[profile].implementation,
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
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
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
    if (
      (final.state === 'paused' || final.state === 'stopped') &&
      final.paused_reason?.startsWith('error:')
    ) {
      console.error(final.paused_reason);
      return 1;
    }
    return final.state === 'paused' ? 3 : 0;
  } finally {
    process.off('exit', onExit);
    for (const signal of signals) process.off(signal, onSignal);
    releaseLoopLock(root);
  }
}
