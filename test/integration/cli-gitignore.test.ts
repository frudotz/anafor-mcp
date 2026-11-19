import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { configureAnaforIgnore } from '../../src/cli/gitignore.js';
import { git } from '../../src/git/git.js';
import { tempDir } from '../helpers.js';

function initRepo(root: string): void {
  git(root, ['init', '-q', '-b', 'main']);
  writeFileSync(join(root, 'README.md'), 'init\n');
  git(root, ['add', 'README.md']);
  git(root, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

describe('init .anafor ignore configuration', () => {
  it('worktree içinden --exclude-local ortak info/exclude dosyasına yazar', () => {
    const t = tempDir();
    try {
      initRepo(t.dir);
      const worktree = join(t.dir, '.anafor', 'worktrees', 'init-test');
      mkdirSync(join(t.dir, '.anafor', 'worktrees'), { recursive: true });
      git(t.dir, ['worktree', 'add', '-q', '-b', 'init-test', worktree, 'main']);
      expect(configureAnaforIgnore(worktree, true)).toBe(false);
      const common = git(worktree, ['rev-parse', '--git-common-dir']).stdout.trim();
      expect(readFileSync(join(common, 'info', 'exclude'), 'utf8')).toContain('.anafor/');
      expect(existsSync(join(worktree, '.gitignore'))).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it('varsayılan yapılandırma .gitignore dosyasını güncellediğini bildirir', () => {
    const t = tempDir();
    try {
      initRepo(t.dir);
      expect(configureAnaforIgnore(t.dir, false)).toBe(true);
      expect(readFileSync(join(t.dir, '.gitignore'), 'utf8')).toContain('.anafor/');
    } finally {
      t.cleanup();
    }
  });
});
