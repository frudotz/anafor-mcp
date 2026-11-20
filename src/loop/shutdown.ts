import type { LoopState } from './state.js';
import { readLoopState, writeLoopState } from './state.js';

export function shouldShutdown(finalState: LoopState, onFinish: 'none' | 'shutdown'): boolean {
  return (
    onFinish === 'shutdown' &&
    (finalState.state === 'done' ||
      (finalState.state === 'paused' && finalState.paused_reason?.startsWith('blocked:') === true))
  );
}

export function loopControlChanged(finalState: LoopState, liveState: LoopState | null): boolean {
  return (
    liveState === null ||
    liveState.state === 'stopped' ||
    liveState.state !== finalState.state ||
    (liveState.state === 'paused' && liveState.paused_reason !== finalState.paused_reason)
  );
}

export function planShutdownCommand(platform: string): {
  cmd: string;
  args: string[];
  cancel: string;
} {
  return platform === 'win32'
    ? {
        cmd: 'shutdown',
        args: ['/s', '/t', '120', '/c', 'Anafor: döngü bitti'],
        cancel: 'shutdown /a',
      }
    : { cmd: 'shutdown', args: ['-h', '+2'], cancel: 'shutdown -c' };
}

export function scheduleShutdown(
  plan: { cmd: string; args: string[]; cancel: string },
  runner: (
    cmd: string,
    args: string[],
  ) => { status: number | null; error?: Error; stderr?: string },
): string | null {
  try {
    const result = runner(plan.cmd, plan.args);
    return result.error || result.status !== 0
      ? (result.error?.message ?? result.stderr ?? 'permission denied')
      : null;
  } catch (error) {
    return (error as Error).message;
  }
}

export function shutdownStartNotice(
  enabled: boolean,
  platform: string,
  warning: (cancel: string) => string,
): string | null {
  return enabled ? warning(planShutdownCommand(platform).cancel) : null;
}

export function applyShutdownResult<
  T extends {
    shutdown_scheduled_at?: string | null;
    shutdown_error?: string | null;
    shutdown_cancel_command?: string | null;
  },
>(state: T, plan: { cancel: string }, error: string | null, at: string): T {
  return {
    ...state,
    shutdown_cancel_command: plan.cancel,
    shutdown_scheduled_at: error ? null : at,
    shutdown_error: error,
    shutdown_cancel_error: null,
  };
}

export function cancelScheduledShutdown(
  state: LoopState,
  platform: string,
  runner: (
    cmd: string,
    args: string[],
  ) => { status: number | null; error?: Error; stderr?: string },
): { state: LoopState; attempted: boolean; error: string | null } {
  if (!state.shutdown_scheduled_at) return { state, attempted: false, error: null };
  const plan = planShutdownCommand(platform);
  const error = scheduleShutdown(
    { cmd: plan.cmd, args: platform === 'win32' ? ['/a'] : ['-c'], cancel: plan.cancel },
    runner,
  );
  return {
    state: {
      ...state,
      shutdown_scheduled_at: error ? state.shutdown_scheduled_at : null,
      shutdown_pending: false,
      shutdown_cancelled: !error,
      shutdown_cancel_error: error,
    },
    attempted: true,
    error,
  };
}

export function isShutdownTerminal(state: LoopState): boolean {
  return (
    state.state === 'done' ||
    (state.state === 'paused' && state.paused_reason?.startsWith('blocked:') === true)
  );
}

export function markShutdownCancelled(root: string): LoopState | null {
  const state = readLoopState(root);
  if (!state) return null;
  state.shutdown_cancelled = true;
  state.shutdown_pending = false;
  writeLoopState(root, state);
  return state;
}

export async function waitForJobs(
  list: () => { id: string }[],
  cancel: (id: string) => void,
  sleep: (ms: number) => Promise<void>,
  timeoutMs = 30 * 60_000,
  stopped: () => boolean = () => false,
  now: () => number = Date.now,
): Promise<boolean> {
  const deadline = now() + timeoutMs;
  while (list().length && now() < deadline) {
    if (stopped()) return false;
    await sleep(Math.min(10_000, deadline - now()));
  }
  if (stopped()) return false;
  for (const job of list()) cancel(job.id);
  return true;
}
