import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export type DirectorMode = 'enforce' | 'warn' | 'off';
export type RoutingMode = 'static' | 'adaptive';

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
  /** Kanıt üretiminde kullanılacak test komutu (yoksa package.json'dan tahmin). */
  test_command: string | null;
  /** İşçi başına ayarlar. */
  workers: Record<string, WorkerSettings>;
  /** Rol → tercih edilen işçi sırası (ilk uygun olan seçilir). */
  routing: Partial<Record<'implementation' | 'review' | 'analysis' | 'test', string[]>>;
  /** Uyarlamalı yönlendirme: yeterli geçmişi olan işçileri kabul oranıyla sırala. */
  routing_mode: RoutingMode;
  /** Makine genelinde aynı anda çalışabilecek toplam iş (tüm işçiler ve projeler). */
  max_parallel_jobs: number;
}

export interface WorkerSettings {
  bin?: string;
  model?: string;
  max_concurrency?: number;
  allowed_tools?: string[];
  enabled?: boolean;
  /** OpenAI uyumlu uç nokta (local). */
  base_url?: string;
  /** API anahtarının okunacağı ortam değişkeni adı. */
  api_key_env?: string;
  /** Gri alandaki işçiler (antigravity) için koşulların okunduğu onayı. */
  acknowledge_terms?: boolean;
  /** OpenCode'da anthropic/* modellerine (yalnızca API anahtarıyla) izin. */
  allow_anthropic_api?: boolean;
  /** Codex, yalnızca Windows: işler için `windows.sandbox` ("elevated" testlerin alt süreç başlatabilmesi için). */
  windows_sandbox?: 'elevated' | 'unelevated';
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
  routing_mode: 'static',
  max_parallel_jobs: 4,
  worktree_setup: null,
  escalation: { failure_threshold: 3, stall_minutes: 60, takeover_minutes: 120 },
  test_command: null,
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
export function findAnaforRoot(start: string, home = homedir()): string | null {
  let dir = resolve(start);
  // Ev dizinindeki ~/.anafor kullanıcı düzeyi veridir (limitler), proje değildir.
  const homeNorm = resolve(home).toLowerCase();
  for (;;) {
    // Ev dizinine gelince dur: ev dizini proje değildir, üstü de aranmaz.
    if (dir.toLowerCase() === homeNorm) return null;
    const candidate = join(dir, '.anafor');
    if (existsSync(candidate) && statSync(candidate).isDirectory()) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
