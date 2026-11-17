import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDepCache, cacheBlocker } from '../../src/git/dep-cache.js';
import { createJobWorktree, removeWorktree } from '../../src/git/worktree.js';
import { tempDir } from '../helpers.js';

const git = (cwd: string, ...a: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
    cwd,
    encoding: 'utf8',
  });

describe('worktree bağımlılık önbelleği (F17)', () => {
  let t: ReturnType<typeof tempDir>;
  let root: string;
  const cfg = { paths: ['node_modules'], key_files: ['package-lock.json'] };

  beforeEach(() => {
    t = tempDir();
    root = join(t.dir, 'repo');
    mkdirSync(join(root, 'node_modules', 'pkg', 'lib'), { recursive: true });
    writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'module.exports = 1;');
    writeFileSync(join(root, 'node_modules', 'pkg', 'lib', 'a.js'), 'a');
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    writeFileSync(join(root, '.gitignore'), 'node_modules/\n.anafor/\n');
    git(root, 'init', '-q');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'init');
  });
  afterEach(() => t.cleanup());

  const worktree = (job = 'J-1') =>
    createJobWorktree(root, join(root, '.anafor', 'worktrees'), 'T-1', job);

  it('hardlink kopya; worktree silinince ANA node_modules sağlam kalır', async () => {
    const wt = worktree();
    const r = await applyDepCache(root, wt.path, cfg);
    expect(r).toMatchObject({ applied: true, files: 2 });
    expect(readFileSync(join(wt.path, 'node_modules', 'pkg', 'lib', 'a.js'), 'utf8')).toBe('a');
    expect(git(wt.path, 'status', '--porcelain')).toBe('');
    if (process.platform !== 'win32') {
      // aynı inode = gerçek hardlink
      expect(statSync(join(wt.path, 'node_modules/pkg/index.js')).ino).toBe(
        statSync(join(root, 'node_modules/pkg/index.js')).ino,
      );
    }
    removeWorktree(root, wt.path, wt.branch, true);
    expect(existsSync(wt.path)).toBe(false);
    expect(readFileSync(join(root, 'node_modules', 'pkg', 'index.js'), 'utf8')).toBe(
      'module.exports = 1;',
    );
    expect(readFileSync(join(root, 'node_modules', 'pkg', 'lib', 'a.js'), 'utf8')).toBe('a');
  });

  it('kilit dosyası farklıysa uygulanmaz', async () => {
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"x":1}');
    const wt = worktree();
    expect(await applyDepCache(root, wt.path, cfg)).toMatchObject({
      applied: false,
      reason: expect.stringMatching(/package-lock\.json/),
    });
    expect(existsSync(join(wt.path, 'node_modules'))).toBe(false);
  });

  it('gitignore dışındaki dizin uygulanmaz', () => {
    writeFileSync(join(root, '.gitignore'), '.anafor/\n');
    git(root, 'commit', '-qam', 'no-ignore');
    const wt = worktree();
    expect(cacheBlocker(root, wt.path, cfg)).toMatch(/gitignore/);
  });

  it('kaynakta symlink/junction varsa uygulanmaz ve yarım kopya geri alınır', async () => {
    mkdirSync(join(root, 'packages', 'ws'), { recursive: true });
    symlinkSync(
      join(root, 'packages', 'ws'),
      join(root, 'node_modules', 'ws'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const wt = worktree();
    const r = await applyDepCache(root, wt.path, cfg);
    expect(r).toMatchObject({ applied: false, reason: expect.stringMatching(/symlink/) });
    expect(existsSync(join(wt.path, 'node_modules'))).toBe(false);
    expect(existsSync(join(root, 'packages', 'ws'))).toBe(true);
  });
});
