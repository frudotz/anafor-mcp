import {
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  mkdirSync,
  openSync,
  closeSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { resolveProjectRoot } from '../core/config.js';
import { readLoopState, type LoopState } from './state.js';

export type RecoveryDecision = 'recover' | 'ignore';
export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH';
  }
};

export function recoveryDecision(
  state: LoopState | null,
  lockPid: number | null,
  now = Date.now(),
  isAlive = pidAlive,
): RecoveryDecision {
  if (!state || state.state !== 'running') return 'ignore';
  if (lockPid !== null && (!Number.isInteger(lockPid) || lockPid < 1 || isAlive(lockPid)))
    return 'ignore';
  const heartbeat = Date.parse(state.heartbeat_at ?? state.started_at);
  return Number.isFinite(heartbeat) && now - heartbeat > 3 * 60_000 ? 'recover' : 'ignore';
}

const cliEntry = () => fileURLToPath(new URL('../cli/main.js', import.meta.url));
type RecoverOptions = {
  now?: number;
  spawnChild?: typeof spawn;
  isAlive?: (pid: number) => boolean;
};
type LoopLock = { pid?: unknown; brain_pid?: unknown };
const isAlive = (opts: RecoverOptions, pid: number) => (opts.isAlive ?? pidAlive)(pid);

export async function recoverLoop(root: string, opts: RecoverOptions = {}): Promise<boolean> {
  const dir = join(root, '.anafor');
  mkdirSync(dir, { recursive: true });
  const guard = join(dir, 'loop.recover.lock');
  const now = opts.now ?? Date.now();
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(
        guard,
        JSON.stringify({ pid: process.pid, started_at: new Date(now).toISOString() }),
        { flag: 'wx' },
      );
      break;
    } catch {
      type GuardData = { pid?: number; started_at?: string };
      let previous: GuardData | null = null;
      let previousBytes: string;
      try {
        previousBytes = readFileSync(guard, 'utf8');
        previous = JSON.parse(previousBytes) as GuardData;
      } catch {
        try {
          previousBytes = readFileSync(guard, 'utf8');
          if (now - statSync(guard).mtimeMs <= 10 * 60_000) return false;
        } catch {
          return false;
        }
      }
      const started = Date.parse(previous?.started_at ?? '');
      const oldEnough = Number.isFinite(started) && now - started > 10 * 60_000;
      if (previous?.pid && isAlive(opts, previous.pid) && !oldEnough) return false;
      const stale = `${guard}.${process.pid}.${attempt}.stale`;
      try {
        renameSync(guard, stale);
        const claimed = readFileSync(stale, 'utf8');
        if (claimed !== previousBytes) {
          if (!existsSync(guard)) renameSync(stale, guard);
          else unlinkSync(stale);
          return false;
        }
        unlinkSync(stale);
      } catch {
        return false;
      }
    }
  }
  let ownsGuard = false;
  try {
    ownsGuard = JSON.parse(readFileSync(guard, 'utf8')).pid === process.pid;
  } catch {
    return false;
  }
  if (!ownsGuard) return false;
  try {
    const state = readLoopState(root);
    if (!state || state.state !== 'running') return false;
    const recoveryMarker = join(dir, 'loop.recovered-at');
    if (existsSync(recoveryMarker)) {
      const lastRecovery = Number(readFileSync(recoveryMarker, 'utf8')) || 0;
      if (lastRecovery > 0 && now - lastRecovery < 3 * 60_000) return false;
    }
    const lockPath = join(dir, 'loop.lock');
    let lock: LoopLock | null = null;
    let lockBytes: string | null = null;
    try {
      lockBytes = readFileSync(lockPath, 'utf8');
      lock = JSON.parse(lockBytes) as LoopLock;
    } catch {
      if (existsSync(lockPath)) return false;
      /* missing lock is recoverable if the heartbeat is stale */
    }
    const lockPid = lock ? Number(lock.pid) : null;
    if (recoveryDecision(state, lockPid, now, (pid) => isAlive(opts, pid)) !== 'recover')
      return false;
    const brainPid = typeof lock?.brain_pid === 'number' ? lock.brain_pid : null;
    if (brainPid !== null && isAlive(opts, brainPid)) return false;
    writeFileSync(join(dir, 'loop.recover-trigger'), String(now));

    let claimedLock: string | null = null;
    if (lockBytes !== null) {
      claimedLock = `${lockPath}.${process.pid}.recovering`;
      try {
        renameSync(lockPath, claimedLock);
        if (readFileSync(claimedLock, 'utf8') !== lockBytes) {
          if (!existsSync(lockPath)) renameSync(claimedLock, lockPath);
          else unlinkSync(claimedLock);
          return false;
        }
        // A concurrent manual start may have created a new lock while the old one was claimed.
        if (existsSync(lockPath)) {
          unlinkSync(claimedLock);
          return false;
        }
        unlinkSync(claimedLock);
      } catch {
        return false;
      }
    }
    if (readLoopState(root)?.state !== 'running') return false;
    const logFd = openSync(join(dir, 'loop-recover.log'), 'a');
    try {
      const child = (opts.spawnChild ?? spawn)(
        process.execPath,
        [cliEntry(), 'loop', '_recover-resume', '--project-root', root],
        {
          cwd: homedir(),
          env: { ...process.env, ANAFOR_PROJECT_ROOT: root },
          detached: true,
          windowsHide: true,
          stdio: ['ignore', logFd, logFd],
        },
      );
      child.unref();
      writeFileSync(recoveryMarker, String(now));
    } finally {
      closeSync(logFd);
    }
    return true;
  } finally {
    try {
      if (JSON.parse(readFileSync(guard, 'utf8')).pid === process.pid) unlinkSync(guard);
    } catch {
      /* stale guard can be claimed on the next attempt */
    }
  }
}

export function recoverTrigger(
  root: string,
  opts: {
    throttleMs?: number;
    now?: number;
    spawnChild?: typeof spawn;
    env?: NodeJS.ProcessEnv;
  } = {},
): boolean {
  const env = opts.env ?? process.env;
  if (env.ANAFOR_DISABLE_BACKGROUND === '1') return false;
  const resolved = resolveProjectRoot({ ...env, ANAFOR_PROJECT_ROOT: root }, root);
  if (
    !resolved.initialized ||
    !readLoopState(resolved.root) ||
    readLoopState(resolved.root)?.state !== 'running'
  )
    return false;
  const dir = join(resolved.root, '.anafor');
  const marker = join(dir, 'loop.recover-trigger');
  const now = opts.now ?? Date.now();
  try {
    mkdirSync(dir, { recursive: true });
    const last = existsSync(marker) ? Number(readFileSync(marker, 'utf8')) || 0 : 0;
    if (last > 0 && now - last < (opts.throttleMs ?? 3 * 60_000)) return false;
    const state = readLoopState(resolved.root);
    const lockPath = join(dir, 'loop.lock');
    let lock: { pid?: unknown; brain_pid?: unknown } | null = null;
    try {
      lock = JSON.parse(readFileSync(lockPath, 'utf8')) as LoopLock;
    } catch {
      if (existsSync(lockPath)) return false;
    }
    if (recoveryDecision(state, lock ? Number(lock.pid) : null, now) !== 'recover') return false;
    if (typeof lock?.brain_pid === 'number' && pidAlive(lock.brain_pid)) return false;
    writeFileSync(marker, String(now));
    const child = (opts.spawnChild ?? spawn)(
      process.execPath,
      [cliEntry(), 'loop', 'recover', '--project-root', resolved.root],
      {
        cwd: homedir(),
        env: { ...env, ANAFOR_PROJECT_ROOT: resolved.root },
        detached: true,
        windowsHide: true,
        stdio: 'ignore',
      },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export function recoverEnabled(root: string): boolean {
  try {
    const config = JSON.parse(readFileSync(join(root, '.anafor', 'config.json'), 'utf8')) as {
      loop?: { recover_on_crash?: boolean };
    };
    return config.loop?.recover_on_crash !== false;
  } catch {
    return true;
  }
}
