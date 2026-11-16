import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Bir projenin `.anafor/` altındaki yolları. */
export interface ProjectPaths {
  root: string;
  projectId: string;
  anaforDir: string;
  dbFile: string;
  jobsDir: string;
  worktreesDir: string;
  grantsDir: string;
  auditDir: string;
  jobDir(jobId: string): string;
}

export function normalizeProjectRoot(root: string): string {
  return resolve(root).replace(/[\\/]+$/, '');
}

export function projectIdFor(root: string): string {
  return createHash('sha256').update(normalizeProjectRoot(root).toLowerCase()).digest('hex');
}

export function projectPaths(root: string): ProjectPaths {
  const r = normalizeProjectRoot(root);
  const anaforDir = join(r, '.anafor');
  const jobsDir = join(anaforDir, 'jobs');
  return {
    root: r,
    projectId: projectIdFor(r),
    anaforDir,
    dbFile: join(anaforDir, 'state.db'),
    jobsDir,
    worktreesDir: join(anaforDir, 'worktrees'),
    grantsDir: join(anaforDir, 'grants'),
    auditDir: join(anaforDir, 'audit'),
    jobDir: (jobId: string) => join(jobsDir, jobId),
  };
}

export function ensureProjectDirs(p: ProjectPaths): void {
  for (const d of [p.anaforDir, p.jobsDir, p.worktreesDir, p.grantsDir, p.auditDir]) {
    mkdirSync(d, { recursive: true });
  }
}
