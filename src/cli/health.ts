import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { findAnaforRoot } from '../core/config.js';
import { anaforHome, formatWindows, type LimitWindow } from '../limits/limits.js';
import { readSetupState } from '../setup/setup.js';
import { ANAFOR_VERSION } from '../version.js';
import { c } from './ui.js';

/**
 * Kararlılık sinyalleri (F28): statusline'da `anafor doctor` / `anafor setup` önerisi için.
 * Ucuz kalır: yalnızca küçük JSON dosyaları ve salt okunur tek bir SQLite sorgusu.
 */
export interface Health {
  ok: boolean;
  at: string;
  version: string;
  problems: string[];
}

const healthFile = (env?: NodeJS.ProcessEnv) => join(anaforHome(env), 'health.json');

export function writeHealth(h: Omit<Health, 'at' | 'version'>, env?: NodeJS.ProcessEnv): void {
  mkdirSync(anaforHome(env), { recursive: true });
  writeFileSync(
    healthFile(env),
    JSON.stringify({ ...h, at: new Date().toISOString(), version: ANAFOR_VERSION }, null, 2),
  );
}

export function readHealth(env?: NodeJS.ProcessEnv): Health | null {
  try {
    return JSON.parse(readFileSync(healthFile(env), 'utf8')) as Health;
  } catch {
    return null;
  }
}

/** Son `hours` saatte başarısız biten iş sayısı (salt okunur). */
export function recentFailures(root: string, hours = 2, now = Date.now()): number {
  const db = join(root, '.anafor', 'state.db');
  if (!existsSync(db)) return 0;
  let conn: DatabaseSync | null = null;
  try {
    conn = new DatabaseSync(db, { readOnly: true });
    const since = new Date(now - hours * 3600_000).toISOString();
    const r = conn
      .prepare(
        "SELECT COUNT(*) AS n FROM jobs WHERE state IN ('failed','timed_out','invalid_output') AND ended_at >= ?",
      )
      .get(since) as { n: number } | undefined;
    return r?.n ?? 0;
  } catch {
    return 0;
  } finally {
    conn?.close();
  }
}

export type Signal = { level: 'warn' | 'error'; text: string; command: string };

/** Statusline için öneriler: eski plugin, başarısız doctor, art arda başarısız işler. */
export function healthSignals(cwd: string | undefined, env?: NodeJS.ProcessEnv): Signal[] {
  const out: Signal[] = [];
  const setup = readSetupState(env);
  if (setup?.plugin_installed && setup.version !== ANAFOR_VERSION)
    out.push({ level: 'warn', text: `plugin v${setup.version}`, command: 'anafor setup' });
  const h = readHealth(env);
  if (h && !h.ok) out.push({ level: 'error', text: 'sorun var', command: 'anafor doctor' });
  else if (cwd) {
    const root = findAnaforRoot(cwd);
    const n = root ? recentFailures(root) : 0;
    if (n >= 2) out.push({ level: 'warn', text: `${n} iş başarısız`, command: 'anafor doctor' });
  }
  return out;
}

/** Statusline satırı (saf; test edilebilir). Renkler zorla açılır (çıktı boruya gider). */
export function statusLine(i: {
  version: string;
  model?: string;
  windows: LimitWindow[];
  update: string | null;
  signals: Signal[];
}): string {
  const parts = [`${c('cyan', 'anafor', true)} ${c('gray', `v${i.version}`, true)}`];
  if (i.update) parts.push(c('yellow', `⬆ v${i.update}: anafor update`, true));
  for (const s of i.signals)
    parts.push(c(s.level === 'error' ? 'red' : 'yellow', `⚠ ${s.text}: ${s.command}`, true));
  if (i.model) parts.push(i.model);
  if (i.windows.length) parts.push(formatWindows(i.windows));
  return parts.join(c('gray', ' · ', true));
}
