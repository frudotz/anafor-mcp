import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anaforHome, type LimitWindow, type WorkerLimits } from '../limits/limits.js';
import { m } from '../i18n/index.js';

/**
 * Kapasite modeli (F20). Birim: KP (kapasite puanı) = bir limit penceresinin %1'i.
 * İş başına KP, işten önceki/sonraki pencere kullanım farkından öğrenilir (EMA + p80).
 * Kullanıcının etkileşimli kullanımı için pencere başına rezerv ayrılır.
 */

export interface CapacityConfig {
  /** 5 saatlik pencerede kullanıcıya ayrılan pay (%). */
  reserve_five_hour: number;
  /** Haftalık (ve diğer uzun) pencerelerde ayrılan pay (%). */
  reserve_weekly: number;
  /** Tempo (kullanım / geçen süre oranı) bu eşiği aşarsa "hızlı tükeniyor". */
  pace_threshold: number;
}

export const DEFAULT_CAPACITY: CapacityConfig = {
  reserve_five_hour: 10,
  reserve_weekly: 15,
  pace_threshold: 1.2,
};

export interface CostEntry {
  ema: number;
  n: number;
  samples: number[];
}
/** hesap → rol → pencere → maliyet */
export type CostBook = Record<string, Record<string, Record<string, CostEntry>>>;

const costFile = (env?: NodeJS.ProcessEnv) => join(anaforHome(env), 'capacity-costs.json');
const ALPHA = 0.3;
const MAX_SAMPLES = 20;

export function readCosts(env?: NodeJS.ProcessEnv): CostBook {
  try {
    return JSON.parse(readFileSync(costFile(env), 'utf8')) as CostBook;
  } catch {
    return {};
  }
}

export function p80(samples: number[]): number {
  if (!samples.length) return 0;
  const s = [...samples].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(0.8 * s.length) - 1)]!;
}

/** Bir gözlemi maliyet defterine ekler (saf; yeni defter döner). */
export function addCost(book: CostBook, account: string, role: string, window: string, kp: number) {
  const acc = (book[account] ??= {});
  const r = (acc[role] ??= {});
  const cur = r[window];
  r[window] = cur
    ? {
        ema: Math.round((ALPHA * kp + (1 - ALPHA) * cur.ema) * 100) / 100,
        n: cur.n + 1,
        samples: [...cur.samples, kp].slice(-MAX_SAMPLES),
      }
    : { ema: kp, n: 1, samples: [kp] };
  return book;
}

/**
 * İşten önceki ve sonraki limit gözlemlerinden pencere başına KP farkını çıkarır.
 * Gözlem iş başladıktan sonra yapılmadıysa veya pencere bu arada sıfırlandıysa ölçüm yok.
 */
export function jobDeltas(
  before: WorkerLimits | null,
  after: WorkerLimits | null,
  startedAtMs: number,
  nowMs = Date.now(),
): Record<string, number> {
  if (!after || Date.parse(after.observed_at) < startedAtMs) return {};
  const out: Record<string, number> = {};
  const nowS = nowMs / 1000;
  for (const w of after.windows) {
    const b = before?.windows.find((x) => x.name === w.name);
    // Önceki gözlemin sıfırlanma anı geçmişse pencere sıfırdan başlamıştır.
    const prev = !b
      ? null
      : b.resets_at !== null && b.resets_at * 1000 <= startedAtMs
        ? 0
        : b.resets_at !== null && w.resets_at !== null && Math.abs(w.resets_at - b.resets_at) > 120
          ? null // farklı pencere (sıfırlanma iş sırasında oldu)
          : b.used_percent;
    if (prev === null || (w.resets_at !== null && w.resets_at < nowS - 60)) continue;
    const d = Math.round((w.used_percent - prev) * 10) / 10;
    if (d >= 0 && d <= 100) out[w.name] = d;
  }
  return out;
}

/** Ölçülen farkları kalıcı deftere yazar. */
export function recordJobCost(
  account: string,
  role: string,
  deltas: Record<string, number>,
  env?: NodeJS.ProcessEnv,
): void {
  if (!Object.keys(deltas).length) return;
  const book = readCosts(env);
  for (const [w, kp] of Object.entries(deltas)) addCost(book, account, role, w, kp);
  mkdirSync(anaforHome(env), { recursive: true });
  writeFileSync(costFile(env), JSON.stringify(book, null, 2));
}

export interface WindowState {
  name: string;
  used: number;
  reserve: number;
  /** Rezerv düşüldükten sonra işlere kalan KP. */
  free: number;
  resets_at: number | null;
  /** Kullanım oranı / geçen süre oranı (1 = pencere sonunda tam dolar). */
  pace: number | null;
  /** Bu tempoyla dolmasına kalan saniye. */
  eta_full_s: number | null;
}

export const windowLabel = (n: string) =>
  n === 'five_hour' ? m().windows.fiveHour : n.startsWith('seven_day') ? m().windows.sevenDay : n;

export function windowState(w: LimitWindow, cfg: CapacityConfig, nowMs: number): WindowState {
  const nowS = nowMs / 1000;
  const reset = w.resets_at !== null && w.resets_at <= nowS;
  const used = reset ? 0 : w.used_percent;
  const reserve = w.name === 'five_hour' ? cfg.reserve_five_hour : cfg.reserve_weekly;
  let pace: number | null = null;
  let eta: number | null = null;
  if (!reset && w.window_minutes && w.resets_at !== null) {
    const total = w.window_minutes * 60;
    const elapsed = total - (w.resets_at - nowS);
    if (elapsed > total * 0.05 && elapsed <= total) {
      pace = Math.round((used / 100 / (elapsed / total)) * 100) / 100;
      if (used > 0 && used < 100) eta = Math.round(((100 - used) * elapsed) / used);
    }
  }
  return {
    name: w.name,
    used,
    reserve,
    free: Math.max(0, Math.round((100 - used - reserve) * 10) / 10),
    resets_at: reset ? null : w.resets_at,
    pace,
    eta_full_s: eta,
  };
}

export interface AccountCapacity {
  account: string;
  workers: string[];
  observed: boolean;
  observed_at: string | null;
  windows: WindowState[];
  /** Rol başına planlama maliyeti (p80, en kısıtlı pencere) ve kalan iş tahmini. */
  roles: Record<string, { kp_p80: number; samples: number; jobs_left: number | null }>;
  /** Yeni iş almaya uygun mu (tüm pencerelerde boş alan > 0 ve tahmini maliyet sığıyor). */
  healthy: boolean;
}

export interface CapacityInput {
  /** hesap → bu hesabı kullanan işçiler */
  accounts: Record<string, string[]>;
  limits: Record<string, WorkerLimits | null>;
  costs: CostBook;
  /** rol → tercih sırası (config.routing) */
  routing: Record<string, string[]>;
  accountOf: (worker: string) => string;
  cfg: CapacityConfig;
  now?: number;
}

const hhmm = (s: number) =>
  new Date(s * 1000).toLocaleString(m().windows.locale, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
const dur = (s: number) =>
  s >= 86400
    ? m().capacity.days(Math.round(s / 3600 / 24))
    : m().capacity.hours(Math.max(1, Math.round(s / 3600)));

/** Hesap kapasiteleri + kullanıcıya gösterilecek ipuçları. */
export function capacityReport(input: CapacityInput): {
  accounts: AccountCapacity[];
  hints: string[];
} {
  const now = input.now ?? Date.now();
  const t = m().capacity;
  const hints: string[] = [];
  const accounts: AccountCapacity[] = [];
  const roles = Object.keys(input.routing);

  for (const [account, workers] of Object.entries(input.accounts)) {
    const l = input.limits[account] ?? null;
    const windows = (l?.windows ?? []).map((w) => windowState(w, input.cfg, now));
    const roleCosts: AccountCapacity['roles'] = {};
    const usedBy = roles.filter((r) =>
      (input.routing[r] ?? []).some((w) => input.accountOf(w) === account),
    );
    for (const r of usedBy) {
      const byWin = input.costs[account]?.[r] ?? {};
      let kp = 0;
      let samples = 0;
      let left: number | null = null;
      for (const w of windows) {
        const c = byWin[w.name];
        if (!c) continue;
        const cost = Math.max(p80(c.samples), 0.5);
        samples = Math.max(samples, c.n);
        const n = Math.floor(w.free / cost);
        if (left === null || n < left) {
          left = n;
          kp = cost;
        }
      }
      roleCosts[r] = { kp_p80: kp, samples, jobs_left: left };
    }
    const healthy =
      windows.every((w) => w.free > 0) &&
      Object.values(roleCosts).every((c) => c.jobs_left === null || c.jobs_left > 0);
    accounts.push({
      account,
      workers,
      observed: !!l,
      observed_at: l?.observed_at ?? null,
      windows,
      roles: roleCosts,
      healthy,
    });

    if (!l) {
      if (usedBy.length) hints.push(t.notObserved(account, usedBy.join(', ')));
      continue;
    }
    for (const w of windows) {
      const label = windowLabel(w.name);
      if (w.free <= 0) {
        hints.push(
          t.reserveReached(
            account,
            label,
            w.used,
            w.reserve,
            w.resets_at ? hhmm(w.resets_at) : null,
          ),
        );
      } else if (w.pace !== null && w.pace > input.cfg.pace_threshold && w.eta_full_s !== null) {
        const before = w.resets_at !== null && now / 1000 + w.eta_full_s < w.resets_at;
        if (before)
          hints.push(t.fastDrain(account, label, w.pace, dur(w.eta_full_s), hhmm(w.resets_at!)));
      }
    }
    for (const [r, c] of Object.entries(roleCosts)) {
      if (c.jobs_left !== null && c.jobs_left <= 2 && c.samples >= 2) {
        hints.push(t.jobsLeft(account, r, c.jobs_left, c.kp_p80));
      }
    }
  }

  // Yönlendirme ipucu: rolün ilk işçisi sağlıksızsa, zincirde sağlıklı bir sonraki işçiyi öner.
  const health = new Map(accounts.map((a) => [a.account, a]));
  for (const r of roles) {
    const chain = input.routing[r] ?? [];
    const first = chain[0];
    if (!first) continue;
    const fa = health.get(input.accountOf(first));
    if (!fa || !fa.observed || fa.healthy) continue;
    const next = chain.slice(1).find((w) => {
      const a = health.get(input.accountOf(w));
      return a && (a.healthy || !a.observed);
    });
    hints.push(
      next
        ? t.promote(
            r,
            first,
            next,
            `anafor roles set ${r} ${[next, ...chain.filter((w) => w !== next)].join(',')}`,
          )
        : t.noBackup(r, first),
    );
  }
  return { accounts, hints };
}
