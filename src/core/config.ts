import { DEFAULT_BALANCER, type BalancerConfig } from '../capacity/balancer.js';
import { DEFAULT_CAPACITY, type CapacityConfig } from '../capacity/capacity.js';
import { DEFAULT_EXTENSIONS, type ExtensionsConfig } from '../extensions/guard.js';
import type { DepCacheConfig } from '../git/dep-cache.js';
import type { EffortSetting, TokenProfile } from './token-profile.js';
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
  /** Worktree bağımlılık önbelleği (hardlink); null = kapalı. */
  worktree_cache: DepCacheConfig | null;
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
  /** Yeni işlerde Lat.md hafızasından ilgili bölümleri iş emrine ekle (lat.md/ varsa). */
  memory_context: boolean;
  /** Kullanıcının abonelikleri (meta profili kimlikleri; ör. "claude-max", "chatgpt-plus"). */
  subscriptions: string[];
  /** Kapasite modeli: rezervler ve tempo eşiği. */
  capacity: CapacityConfig;
  /** Harici skill/MCP kapısı (SkillSpector). */
  extensions: ExtensionsConfig;
  /** Yük dengeleyici: rol zincirini abonelik kapasitesine göre yeniden sıralar. */
  balancer: BalancerConfig;
  /** Rol başına akıl yürütme düzeyi profili (saver | balanced | quality | off). */
  token_profile: TokenProfile;
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
  /** Antigravity: headless modda izin verilen BİREBİR komutlar (test_command otomatik eklenir). */
  allowed_commands?: string[];
  /** Akıl yürütme düzeyi: tek değer veya rol başına (token_profile'ı ezer). */
  effort?: EffortSetting;
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
  memory_context: true,
  subscriptions: [],
  capacity: DEFAULT_CAPACITY,
  extensions: DEFAULT_EXTENSIONS,
  balancer: DEFAULT_BALANCER,
  token_profile: 'balanced',
  worktree_setup: null,
  worktree_cache: null,
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
  const local = read(join(root, '.anafor', 'config.json'));
  const project = read(join(root, 'anafor.config.json'));
  return {
    ...DEFAULT_CONFIG,
    ...local,
    ...project,
    capacity: { ...DEFAULT_CAPACITY, ...local.capacity, ...project.capacity },
    extensions: { ...DEFAULT_EXTENSIONS, ...local.extensions, ...project.extensions },
    balancer: { ...DEFAULT_BALANCER, ...local.balancer, ...project.balancer },
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
