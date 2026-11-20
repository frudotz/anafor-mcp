import { mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

export interface LoopState {
  state: 'running' | 'paused' | 'stopped' | 'done';
  goal?: string;
  backlog?: string;
  cycle: number;
  session_id: string | null;
  started_at: string;
  paused_reason: string | null;
  resume_at: string | null;
  auto_resume: boolean;
  max_cycles: number | null;
  until: string | null;
  last_task: string | null;
  completed_items: string[];
  accept?: boolean;
  merge?: boolean;
  profile?: string;
  model?: string;
  error_count?: number;
  pending_intervene_expires_at?: string | null;
  pid?: number;
  shutdown_on_finish?: boolean;
  shutdown_scheduled_at?: string | null;
  shutdown_cancel_command?: string | null;
  shutdown_error?: string | null;
  shutdown_cancel_error?: string | null;
  shutdown_pending?: boolean;
  shutdown_cancelled?: boolean;
}
const paths = (root: string) => ({
  dir: join(root, '.anafor'),
  state: join(root, '.anafor', 'loop.json'),
  lock: join(root, '.anafor', 'loop.lock'),
});
export function readLoopState(root: string): LoopState | null {
  try {
    return JSON.parse(readFileSync(paths(root).state, 'utf8')) as LoopState;
  } catch {
    return null;
  }
}
export function writeLoopState(root: string, state: LoopState): void {
  const p = paths(root);
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.state, JSON.stringify(state, null, 2) + '\n');
}
export function acquireLoopLock(root: string, pid = process.pid): boolean {
  const p = paths(root);
  mkdirSync(p.dir, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(
        p.lock,
        JSON.stringify({ pid, brain_pid: null, started_at: new Date().toISOString() }),
        {
          flag: 'wx',
        },
      );
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
    }
    let oldPid: number;
    let brainPid: number | null;
    try {
      const existing = JSON.parse(readFileSync(p.lock, 'utf8')) as {
        pid?: unknown;
        brain_pid?: unknown;
      };
      oldPid = Number(existing.pid);
      brainPid = typeof existing.brain_pid === 'number' ? existing.brain_pid : null;
    } catch {
      return false;
    }
    if (!Number.isInteger(oldPid) || oldPid < 1) return false;
    try {
      process.kill(oldPid, 0);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ESRCH') return false; // EPERM means the process is alive but inaccessible.
    }
    if (brainPid !== null) {
      try {
        process.kill(brainPid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return false;
      }
    }
    try {
      unlinkSync(p.lock);
    } catch {
      return false;
    }
  }
  return false;
}
export function setLoopBrainPid(root: string, brainPid: number | null): void {
  const p = paths(root);
  try {
    const lock = JSON.parse(readFileSync(p.lock, 'utf8')) as { pid?: number; started_at?: string };
    writeFileSync(p.lock, JSON.stringify({ ...lock, brain_pid: brainPid }));
  } catch {
    /* Loop may already be shutting down. */
  }
}

/** Synchronous best-effort cleanup used for signals and process exit. */
export function cleanupLoopProcess(root: string, reason: string, killBrain: () => void): void {
  try {
    killBrain();
  } catch {
    /* best effort */
  }
  const state = readLoopState(root);
  if (
    state &&
    (state.state === 'running' ||
      (state.state === 'paused' && !state.paused_reason?.startsWith('blocked:')))
  )
    writeLoopState(root, { ...state, state: 'paused', paused_reason: reason, resume_at: null });
  releaseLoopLock(root);
}
export function releaseLoopLock(root: string): void {
  try {
    unlinkSync(paths(root).lock);
  } catch {
    /* already released */
  }
}
