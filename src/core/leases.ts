import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { anaforHome } from '../limits/limits.js';

/**
 * Makine geneli iş kiraları: çalışan her runner `~/.anafor/running/<jobId>.json` bırakır.
 * Global eşzamanlılık sınırı (config `max_parallel_jobs`) projeler arası bu kiralarla sayılır.
 * Süreci ölmüş (PID yok) kira bayattır; okunurken silinir.
 */
export interface JobLease {
  job: string;
  project: string;
  pid: number;
  started_at: string;
}

const dir = (env?: NodeJS.ProcessEnv) => join(anaforHome(env), 'running');
const file = (jobId: string, env?: NodeJS.ProcessEnv) =>
  join(dir(env), `${jobId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

export function acquireLease(
  jobId: string,
  project: string,
  env?: NodeJS.ProcessEnv,
  pid = process.pid,
): void {
  mkdirSync(dir(env), { recursive: true });
  const lease: JobLease = {
    job: jobId,
    project: resolve(project),
    pid,
    started_at: new Date().toISOString(),
  };
  writeFileSync(file(jobId, env), JSON.stringify(lease));
}

export function releaseLease(jobId: string, env?: NodeJS.ProcessEnv): void {
  rmSync(file(jobId, env), { force: true });
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: süreç var ama sinyal izni yok → canlı say.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function liveLeases(
  env?: NodeJS.ProcessEnv,
  alive: (pid: number) => boolean = pidAlive,
): JobLease[] {
  let names: string[];
  try {
    names = readdirSync(dir(env)).filter((n) => n.endsWith('.json'));
  } catch {
    return [];
  }
  const out: JobLease[] = [];
  for (const n of names) {
    const p = join(dir(env), n);
    try {
      const l = JSON.parse(readFileSync(p, 'utf8')) as JobLease;
      if (typeof l.pid === 'number' && alive(l.pid)) out.push(l);
      else rmSync(p, { force: true });
    } catch {
      rmSync(p, { force: true });
    }
  }
  return out;
}

const norm = (p: string) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

/** Bu projenin dışındaki canlı kiralar (projenin kendi işleri durum deposundan sayılır). */
export function otherProjectLeases(project: string, env?: NodeJS.ProcessEnv): JobLease[] {
  const me = norm(project);
  return liveLeases(env).filter((l) => norm(l.project) !== me);
}
