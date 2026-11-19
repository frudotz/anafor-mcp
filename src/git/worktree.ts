import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { git, headSha } from './git.js';

/** Dal adları: görev entegrasyon dalı ve iş dalı. */
export const taskBranchName = (taskId: string) => `anafor/${taskId}`;
export const jobBranchName = (taskId: string, jobId: string) => `anafor/${taskId}-${jobId}`;

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

function must(cwd: string, args: string[]): string {
  const r = git(cwd, args);
  if (r.code !== 0) throw new GitError(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout.trim();
}

export function branchExists(root: string, branch: string): boolean {
  return git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).code === 0;
}

/** Görev dalını tabandan oluşturur (çalışma ağacına dokunmaz). Varsa olduğu gibi bırakır. */
export function ensureTaskBranch(
  root: string,
  taskId: string,
  baseRef = 'HEAD',
): { branch: string; base: string } {
  const branch = taskBranchName(taskId);
  if (!branchExists(root, branch)) must(root, ['branch', branch, baseRef]);
  return { branch, base: must(root, ['rev-parse', branch]) };
}

/** İş için görev dalından yeni dal ve worktree açar. */
export function createJobWorktree(
  root: string,
  worktreesDir: string,
  taskId: string,
  jobId: string,
): { path: string; branch: string; base: string } {
  const { branch: taskBranch } = ensureTaskBranch(root, taskId);
  const branch = jobBranchName(taskId, jobId);
  const path = join(worktreesDir, jobId);
  mkdirSync(worktreesDir, { recursive: true });
  must(root, ['worktree', 'add', '-q', '-b', branch, path, taskBranch]);
  return { path, branch, base: must(root, ['rev-parse', taskBranch]) };
}

export function hasChanges(path: string): boolean {
  return git(path, ['status', '--porcelain']).stdout.trim().length > 0;
}

function identityArgs(cwd: string): string[] {
  const email = git(cwd, ['config', 'user.email']).stdout.trim();
  return email ? [] : ['-c', 'user.name=Anafor', '-c', 'user.email=anafor@localhost'];
}

/** Worktree'deki değişiklikleri iş dalına commit eder. Değişiklik yoksa null. */
export function commitWorktree(path: string, message: string): string | null {
  if (!hasChanges(path)) return null;
  // Exclude pathspec'leri, dizin gitignore'da da varsa "ignored paths" uyarısıyla çıkış 1 verir;
  // bu yüzden önce her şeyi ekleyip Anafor'un çalışma dizinlerini index'ten geri alırız.
  must(path, ['add', '-A', '--', '.']);
  must(path, ['reset', '-q', '--', '.anafor', '.anafor-tmp']);
  must(path, [...identityArgs(path), 'commit', '-q', '--no-verify', '-m', message]);
  return headSha(path);
}

export interface MergeOutcome {
  merged: boolean;
  taskBranch: string;
  commit: string | null;
  conflicts: string[];
}

/**
 * İş dalını görev dalına birleştirir. Görev dalı için ayrı bir entegrasyon worktree'si
 * kullanılır; kullanıcının çalışma ağacına dokunulmaz. Çakışmada birleştirme geri alınır.
 */
export function mergeIntoTaskBranch(
  root: string,
  worktreesDir: string,
  taskId: string,
  jobBranch: string,
  message: string,
): MergeOutcome {
  const taskBranch = taskBranchName(taskId);
  const integ = join(worktreesDir, `_task-${taskId}`);
  if (!existsSync(integ)) must(root, ['worktree', 'add', '-q', integ, taskBranch]);
  const r = git(integ, [
    ...identityArgs(integ),
    'merge',
    '--no-ff',
    '--no-edit',
    '-m',
    message,
    jobBranch,
  ]);
  if (r.code !== 0) {
    const conflicts = git(integ, ['diff', '--name-only', '--diff-filter=U'])
      .stdout.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    git(integ, ['merge', '--abort']);
    return { merged: false, taskBranch, commit: null, conflicts };
  }
  return { merged: true, taskBranch, commit: headSha(integ), conflicts: [] };
}

/** Worktree'yi ve (istenirse) dalını kaldırır. Kaydedilmemiş değişiklik varsa reddeder. */
export function removeWorktree(
  root: string,
  path: string,
  branch: string | null,
  deleteBranch: boolean,
): void {
  if (existsSync(path) && hasChanges(path)) {
    throw new GitError(`Worktree'de kaydedilmemiş değişiklik var, silinmedi: ${path}`);
  }
  if (existsSync(path)) must(root, ['worktree', 'remove', path]);
  git(root, ['worktree', 'prune']);
  if (deleteBranch && branch && branchExists(root, branch)) must(root, ['branch', '-D', branch]);
}
