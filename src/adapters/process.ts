import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { RawOutcome, RunHandle, WorkerEvent } from './types.js';

/** Basit eşzamansız kuyruk: üretici push eder, tüketici for-await ile okur. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** Süreç ağacını öldürür (Windows: taskkill /T, POSIX: süreç grubu). */
export function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

export interface LineProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: string;
  artifactsDir: string;
  /** stdout'un her satırı için; olay(lar) döndürür. */
  parseLine(line: string): WorkerEvent[];
  /** Süreç bitince son mesajı ve oturumu belirler. */
  finalize(state: { lastMessage: string | null; sessionRef: string | null }): {
    finalMessage: string | null;
    sessionRef: string | null;
  };
}

/**
 * Satır tabanlı (JSONL) çıktı veren bir işçi sürecini başlatır.
 * Ham stdout/stderr artefakt dizinine yazılır.
 */
export function runLineProcess(opts: LineProcessOptions): RunHandle {
  const queue = new EventQueue<WorkerEvent>();
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  const stdoutLog = createWriteStream(join(opts.artifactsDir, 'stdout.log')).on(
    'error',
    () => undefined,
  );
  const stderrLog = createWriteStream(join(opts.artifactsDir, 'stderr.log')).on(
    'error',
    () => undefined,
  );
  child.stderr?.pipe(stderrLog);

  let lastMessage: string | null = null;
  let sessionRef: string | null = null;
  let stopReason: 'timeout' | 'cancel' | null = null;

  const rl = createInterface({ input: child.stdout! });
  rl.on('line', (line) => {
    stdoutLog.write(line + '\n');
    let events: WorkerEvent[] = [];
    try {
      events = opts.parseLine(line);
    } catch {
      events = [];
    }
    for (const ev of events) {
      if (ev.type === 'message') lastMessage = ev.text;
      if (ev.type === 'session') sessionRef = ev.sessionRef;
      queue.push(ev);
    }
  });

  child.stdin?.on('error', () => undefined);
  child.stdin?.end(opts.stdin);

  const done = new Promise<RawOutcome>((resolve) => {
    let spawnError: string | null = null;
    child.on('error', (err) => {
      spawnError = err.message;
      queue.push({ type: 'error', message: `Süreç başlatılamadı: ${err.message}`, fatal: true });
    });
    child.on('close', (code) => {
      rl.close();
      stdoutLog.end();
      stderrLog.end();
      const fin = opts.finalize({ lastMessage, sessionRef });
      queue.close();
      resolve({
        exitCode: spawnError ? -1 : code,
        finalMessage: fin.finalMessage,
        sessionRef: fin.sessionRef,
        timedOut: stopReason === 'timeout',
        cancelled: stopReason === 'cancel',
      });
    });
  });

  return {
    pid: child.pid,
    events: queue,
    done,
    cancel: async (reason) => {
      stopReason = reason;
      killTree(child);
      await done.catch(() => undefined);
    },
  };
}
