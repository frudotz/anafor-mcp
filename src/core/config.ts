import { DEFAULT_BALANCER, type BalancerConfig } from '../capacity/balancer.js';
import { DEFAULT_CAPACITY, type CapacityConfig } from '../capacity/capacity.js';
import { DEFAULT_EXTENSIONS, type ExtensionsConfig } from '../extensions/guard.js';
import type { DepCacheConfig } from '../git/dep-cache.js';
import type { EffortSetting, TokenProfile } from './token-profile.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { m } from '../i18n/index.js';
import { warnOnce } from './warn-once.js';

export type DirectorMode = 'enforce' | 'warn' | 'off';
export type RoutingMode = 'static' | 'adaptive';

export interface AnaforConfig {
  review: { require_for: 'standard' | 'deep' | 'none'; worker: string; model: string };
  /** Statusline'da limitleri gösterilecek işçiler. */
  statusline: { workers: string[] };
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
  auto_check: boolean;
  env_probe: boolean;
  auto_check_timeout_s: number;
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
  limits: { brain: { warn_at: number; pause_at: number; pause_at_weekly: number } };
  failover: { enabled: boolean; threshold_percent: number };
  loop: { turn_timeout_min: number; min_turn_gap_sec: number; recover_on_crash: boolean };
  brain: { lean: boolean; model?: string; effort?: import('../adapters/types.js').Effort };
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
  /** Explicit acceptance for optional Antigravity consumer-plan use. */
  accept_terms_risk?: boolean;
  /** OpenCode'da anthropic/* modellerine (yalnızca API anahtarıyla) izin. */
  allow_anthropic_api?: boolean;
  /** Codex, yalnızca Windows: işler için `windows.sandbox` ("elevated" testlerin alt süreç başlatabilmesi için). */
  windows_sandbox?: 'elevated' | 'unelevated';
  /** Personal CLI config isolation. */
  user_config?: 'isolate' | 'inherit';
  /** Antigravity: headless modda izin verilen BİREBİR komutlar (test_command otomatik eklenir). */
  allowed_commands?: string[];
  /** Akıl yürütme düzeyi: tek değer veya rol başına (token_profile'ı ezer). */
  effort?: EffortSetting;
}

let legacyWorkerWarned = false;
export function canonicalWorkerId(id: string): string {
  if (id !== 'claude-lite') return id;
  if (!legacyWorkerWarned) {
    legacyWorkerWarned = true;
    console.warn(m().adapters.legacyWorkerAlias);
  }
  return 'cirak';
}

export const DEFAULT_CONFIG: AnaforConfig = {
  review: { require_for: 'standard', worker: 'cirak', model: 'sonnet' },
  statusline: { workers: ['codex'] },
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
  limits: { brain: { warn_at: 75, pause_at: 90, pause_at_weekly: 95 } },
  failover: { enabled: true, threshold_percent: 95 },
  loop: { turn_timeout_min: 60, min_turn_gap_sec: 30, recover_on_crash: true },
  brain: { lean: true },
  worktree_setup: null,
  worktree_cache: null,
  escalation: { failure_threshold: 3, stall_minutes: 60, takeover_minutes: 120 },
  test_command: null,
  auto_check: true,
  env_probe: true,
  auto_check_timeout_s: 900,
  workers: { codex: { user_config: 'isolate' }, cirak: { user_config: 'isolate' } },
  routing: {
    implementation: ['codex', 'cirak'],
    test: ['cirak', 'codex'],
    analysis: ['cirak', 'codex'],
    review: ['codex', 'cirak'],
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
  if (project.workers?.antigravity?.accept_terms_risk === true)
    warnOnce('agy-project-ack', m().adapters.projectAntigravityAckIgnored);
  for (const cfg of [local, project]) {
    if (cfg.workers?.['claude-lite'])
      cfg.workers.cirak = { ...cfg.workers['claude-lite'], ...cfg.workers.cirak };
    if (cfg.routing)
      for (const role of Object.keys(cfg.routing) as (keyof AnaforConfig['routing'])[]) {
        const chain = cfg.routing[role];
        if (chain) cfg.routing[role] = chain.map(canonicalWorkerId);
      }
    if (cfg.statusline?.workers)
      cfg.statusline.workers = cfg.statusline.workers.map(canonicalWorkerId);
  }
  const workerIds = new Set([
    ...Object.keys(DEFAULT_CONFIG.workers),
    ...Object.keys(local.workers ?? {}),
    ...Object.keys(project.workers ?? {}),
  ]);
  const workers: Record<string, WorkerSettings> = {};
  for (const id of workerIds) {
    workers[id] = {
      ...DEFAULT_CONFIG.workers[id],
      ...local.workers?.[id],
      ...project.workers?.[id],
    };
  }
  if (workers.antigravity && local.workers?.antigravity?.accept_terms_risk !== true) {
    workers.antigravity = { ...workers.antigravity };
    delete workers.antigravity.accept_terms_risk;
  }
  if (workers.antigravity && local.workers?.antigravity?.accept_terms_risk === true)
    workers.antigravity.accept_terms_risk = true;
  const result = {
    ...DEFAULT_CONFIG,
    ...local,
    ...project,
    review: { ...DEFAULT_CONFIG.review, ...local.review, ...project.review },
    statusline: { workers: ['codex'], ...local.statusline, ...project.statusline },
    workers,
    capacity: { ...DEFAULT_CAPACITY, ...local.capacity, ...project.capacity },
    extensions: { ...DEFAULT_EXTENSIONS, ...local.extensions, ...project.extensions },
    balancer: { ...DEFAULT_BALANCER, ...local.balancer, ...project.balancer },
    limits: {
      brain: { ...DEFAULT_CONFIG.limits.brain, ...local.limits?.brain, ...project.limits?.brain },
    },
    failover: { ...DEFAULT_CONFIG.failover, ...local.failover, ...project.failover },
    loop: { ...DEFAULT_CONFIG.loop, ...local.loop, ...project.loop },
    brain: { ...DEFAULT_CONFIG.brain, ...local.brain, ...project.brain },
  };
  for (const id of ['codex', 'cirak']) {
    const localValue = local.workers?.[id]?.user_config;
    const projectValue = project.workers?.[id]?.user_config;
    if (projectValue === 'inherit') console.warn(m().adapters.projectInheritIgnored(id));
    const value =
      localValue ??
      (projectValue === 'inherit' ? DEFAULT_CONFIG.workers[id]?.user_config : projectValue);
    if (value !== undefined && value !== 'isolate' && value !== 'inherit') {
      throw new Error(m().adapters.invalidUserConfig(id, String(value)));
    }
    const settings = result.workers[id]!;
    delete settings.user_config;
    if (value !== undefined) settings.user_config = value;
  }
  return result;
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

/** Shared project-root precedence for MCP, hooks, and CLI. */
export function resolveProjectRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  if (env.ANAFOR_PROJECT_ROOT) return { root: resolve(env.ANAFOR_PROJECT_ROOT), initialized: true };
  const start = env.CLAUDE_PROJECT_DIR ?? cwd;
  const found = findAnaforRoot(start);
  return found ? { root: found, initialized: true } : { root: resolve(start), initialized: false };
}
