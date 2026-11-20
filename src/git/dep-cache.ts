import { spawnSync } from 'node:child_process';
import { promises as fs, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Worktree bağımlılık önbelleği (F17): ana çalışma ağacındaki bağımlılık dizini (ör.
 * node_modules) yeni worktree'ye HARDLINK kopya ile çoğaltılır; `worktree_setup` atlanır.
 *
 * Neden junction/symlink değil: `git worktree remove --force` junction'ı takip edip HEDEFİ
 * (ana projenin node_modules'ünü) siler (2026-11-17'de doğrulandı). Hardlink'in silinmesi
 * yalnızca o adı kaldırır. Aynı nedenle kaynakta symlink/junction varsa önbellek kullanılmaz.
 */
export interface DepCacheConfig {
  /** Proje köküne göre bağımlılık dizinleri, ör. ["node_modules"]. */
  paths: string[];
  /** İçeriği ana ağaçla worktree'de birebir aynı olmalı, ör. ["package-lock.json"]. */
  key_files: string[];
}

export interface DepCacheResult {
  applied: boolean;
  reason: string;
  files: number;
  ms: number;
}

const same = (a: string, b: string) =>
  existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));

function ignored(worktree: string, rel: string): boolean {
  // Sondaki / ile sorulur: dizin henüz yokken de `node_modules/` deseni eşleşsin.
  return (
    spawnSync('git', ['check-ignore', '-q', `${rel.replace(/[\\/]+$/, '')}/`], {
      cwd: worktree,
      windowsHide: true,
    }).status === 0
  );
}

/** Ön koşullar sağlanıyorsa null, değilse neden. */
export function cacheBlocker(root: string, worktree: string, cfg: DepCacheConfig): string | null {
  if (!cfg.paths.length) return 'paths boş';
  for (const k of cfg.key_files) {
    if (!same(join(root, k), join(worktree, k))) return `${k} ana ağaçla aynı değil veya yok`;
  }
  for (const p of cfg.paths) {
    const src = join(root, p);
    if (!existsSync(src) || !statSync(src).isDirectory()) return `${p} ana ağaçta yok`;
    if (existsSync(join(worktree, p))) return `${p} worktree'de zaten var`;
    if (!ignored(worktree, p)) return `${p} gitignore'da değil (commit'e girebilir)`;
  }
  return null;
}

/** Kaynaktaki dosyaları listeler; symlink/junction görürse null (güvenli değil). */
async function listTree(src: string): Promise<{ dirs: string[]; files: string[] } | null> {
  const dirs: string[] = [''];
  const files: string[] = [];
  for (let i = 0; i < dirs.length; i++) {
    const rel = dirs[i]!;
    for (const e of await fs.readdir(join(src, rel), { withFileTypes: true })) {
      const r = rel ? join(rel, e.name) : e.name;
      if (e.isSymbolicLink()) return null;
      if (e.isDirectory()) dirs.push(r);
      else if (e.isFile()) files.push(r);
    }
  }
  return { dirs, files };
}

export async function hardlinkTree(src: string, dst: string, concurrency = 32): Promise<number> {
  const tree = await listTree(src);
  if (!tree) throw new Error('kaynakta symlink/junction var');
  for (const d of tree.dirs) await fs.mkdir(join(dst, d), { recursive: true });
  let i = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (i < tree.files.length) {
        const f = tree.files[i++]!;
        // Farklı birimde (EXDEV) veya hardlink desteklenmezse kopya.
        await fs
          .link(join(src, f), join(dst, f))
          .catch(() => fs.copyFile(join(src, f), join(dst, f)));
      }
    }),
  );
  return tree.files.length;
}

export async function applyDepCache(
  root: string,
  worktree: string,
  cfg: DepCacheConfig,
): Promise<DepCacheResult> {
  const t = Date.now();
  const blocker = cacheBlocker(root, worktree, cfg);
  if (blocker) return { applied: false, reason: blocker, files: 0, ms: 0 };
  let files = 0;
  for (const p of cfg.paths) {
    try {
      files += await hardlinkTree(join(root, p), join(worktree, p));
    } catch (e) {
      // Yarım kopyayı geri al (yalnızca worktree içindeki adlar; kaynak etkilenmez).
      for (const q of cfg.paths) await fs.rm(join(worktree, q), { recursive: true, force: true });
      return {
        applied: false,
        reason: `${p}: ${(e as Error).message}`,
        files: 0,
        ms: Date.now() - t,
      };
    }
  }
  return { applied: true, reason: 'hardlink', files, ms: Date.now() - t };
}
