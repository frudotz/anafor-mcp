import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export type DirectorMode = 'enforce' | 'warn' | 'off';

export interface AnaforConfig {
  /** Yönetici modunda Claude'un doğrudan düzenleme yapması: engelle / uyar / serbest. */
  director_mode: DirectorMode;
  /** Yönetici modunda her zaman düzenlenebilir yollar (proje köküne göre glob). */
  allow_paths: string[];
  /** Doğrulama komutlarına (test, lint, build) izin ver. */
  allow_verify_commands: boolean;
  /** Varsayılan işçi. */
  default_worker: string;
  /** Yeni worktree'de işçiden önce çalışacak kurulum komutu (ör. "npm ci"). */
  worktree_setup: string | null;
  /** İşçiler başarısız olunca yöneticinin görevi devralma eşikleri. */
  escalation: { failure_threshold: number; stall_minutes: number; takeover_minutes: number };
  /** İşçi başına ayarlar. */
  workers: Record<string, WorkerSettings>;
  /** Rol → tercih edilen işçi sırası (ilk uygun olan seçilir). */
  routing: Partial<Record<'implementation' | 'review' | 'analysis' | 'test', string[]>>;
}

export interface WorkerSettings {
  bin?: string;
  model?: string;
  max_concurrency?: number;
  allowed_tools?: string[];
  enabled?: boolean;
}

export const DEFAULT_CONFIG: AnaforConfig = {
  director_mode: 'enforce',
  allow_paths: [
    'lat.md/**',
    '.anafor/evidence/**',
    'anafor.config.json',
    'CLAUDE.md',
    'AGENTS.md',
    'docs/**',
    '**/*.md',
  ],
  allow_verify_commands: true,
  default_worker: 'codex',
  worktree_setup: null,
  escalation: { failure_threshold: 3, stall_minutes: 60, takeover_minutes: 120 },
  workers: {},
  routing: {
    implementation: ['codex', 'claude-lite'],
    test: ['claude-lite', 'codex'],
    analysis: ['claude-lite', 'codex'],
    review: ['codex', 'claude-lite'],
  },
};

/** `.anafor/config.json` + proje `anafor.config.json` (proje dosyası önceliklidir). */
export function loadConfig(root: string): AnaforConfig {
  const read = (p: string): Partial<AnaforConfig> => {
    if (!existsSync(p)) return {};
    try {
      return JSON.parse(readFileSync(p, 'utf8')) as Partial<AnaforConfig>;
    } catch {
      return {};
    }
  };
  return {
    ...DEFAULT_CONFIG,
    ...read(join(root, '.anafor', 'config.json')),
    ...read(join(root, 'anafor.config.json')),
  };
}

/** Başlangıç dizininden yukarı doğru `.anafor/` içeren ilk dizini bulur. */
export function findAnaforRoot(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, '.anafor');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
