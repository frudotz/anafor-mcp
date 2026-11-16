import { spawnSync } from 'node:child_process';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function git(cwd: string, args: string[]): GitResult {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export function isGitRepo(cwd: string): boolean {
  return git(cwd, ['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
}

/** HEAD commit'i; depo yoksa veya hiç commit yoksa null. */
export function headSha(cwd: string): string | null {
  const r = git(cwd, ['rev-parse', 'HEAD']);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** İzlenmeyen (untracked, ignore edilmemiş) dosyalar. */
export function untrackedFiles(cwd: string): string[] {
  return git(cwd, ['ls-files', '--others', '--exclude-standard'])
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface WorkDiff {
  base: string | null;
  stat: string;
  patch: string;
  changedFiles: string[];
  untracked: string[];
}

/**
 * Çalışma ağacının tabana göre farkı (izlenen dosyalar) + izlenmeyen yeni dosyalar.
 * Taban yoksa (hiç commit yok) yalnızca izlenmeyen dosyalar raporlanır.
 */
export function workDiff(cwd: string, base: string | null): WorkDiff {
  const untracked = untrackedFiles(cwd).filter((f) => !f.startsWith('.anafor/'));
  if (!base) return { base, stat: '', patch: '', changedFiles: untracked, untracked };
  const stat = git(cwd, ['diff', '--stat', base, '--', '.', ':(exclude).anafor']).stdout;
  const patch = git(cwd, ['diff', base, '--', '.', ':(exclude).anafor']).stdout;
  const names = git(cwd, ['diff', '--name-only', base, '--', '.', ':(exclude).anafor'])
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  return { base, stat, patch, changedFiles: [...new Set([...names, ...untracked])], untracked };
}
