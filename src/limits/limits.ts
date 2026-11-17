import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * İşçi oturum/kullanım limitleri. Yalnızca resmi araçların kendi yazdığı veya akış olarak
 * verdiği bilgiler okunur; hiçbir kimlik bilgisine dokunulmaz.
 */
export interface LimitWindow {
  name: string; // five_hour | seven_day | primary | secondary ...
  used_percent: number; // 0–100
  resets_at: number | null; // unix saniye
  window_minutes: number | null;
}

export interface WorkerLimits {
  worker: string;
  source: string;
  observed_at: string;
  status: 'ok' | 'warning' | 'limited' | 'unknown';
  windows: LimitWindow[];
  note?: string;
}

/** Aynı hesabı paylaşan işçiler tek limit kaydı kullanır (claude-lite = beyin Claude hesabı). */
export function limitAccount(worker: string): string {
  return worker === 'claude-lite' || worker === 'director' ? 'claude' : worker;
}

/** Kullanıcı düzeyi Anafor dizini (limitler hesap genelidir). ANAFOR_HOME ile ezilebilir. */
export function anaforHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANAFOR_HOME ?? join(homedir(), '.anafor');
}

const limitsFile = (env?: NodeJS.ProcessEnv) => join(anaforHome(env), 'limits.json');

export function readStoredLimits(env?: NodeJS.ProcessEnv): Record<string, WorkerLimits> {
  try {
    return JSON.parse(readFileSync(limitsFile(env), 'utf8')) as Record<string, WorkerLimits>;
  } catch {
    return {};
  }
}

export function recordLimits(l: WorkerLimits, env?: NodeJS.ProcessEnv): void {
  const all = readStoredLimits(env);
  all[l.worker] = l;
  mkdirSync(anaforHome(env), { recursive: true });
  writeFileSync(limitsFile(env), JSON.stringify(all, null, 2));
}

export function statusFrom(windows: LimitWindow[]): WorkerLimits['status'] {
  if (!windows.length) return 'unknown';
  const max = Math.max(...windows.map((w) => w.used_percent));
  return max >= 100 ? 'limited' : max >= 80 ? 'warning' : 'ok';
}

/** Claude Code stream-json `rate_limit_event.rate_limit_info` (2.1.325'te camelCase). */
export function parseClaudeRateLimitInfo(info: Record<string, unknown>): LimitWindow[] {
  const out: LimitWindow[] = [];
  const unified = (info.unifiedWindows ?? info.unified_windows) as
    Record<string, Record<string, unknown>> | undefined;
  const num = (v: unknown) => (typeof v === 'number' ? v : null);
  if (unified && typeof unified === 'object') {
    for (const [name, w] of Object.entries(unified)) {
      const u = num(w.utilization);
      if (u === null) continue;
      out.push({
        name,
        used_percent: Math.round(u * 1000) / 10,
        resets_at: num(w.resetsAt ?? w.resets_at),
        window_minutes: name === 'five_hour' ? 300 : name.startsWith('seven_day') ? 10080 : null,
      });
    }
  } else {
    const u = num(info.utilization);
    const name = String(info.rateLimitType ?? info.rate_limit_type ?? 'unknown');
    if (u !== null)
      out.push({
        name,
        used_percent: Math.round(u * 1000) / 10,
        resets_at: num(info.resetsAt ?? info.resets_at),
        window_minutes: null,
      });
  }
  return out;
}

/** Claude Code statusline girdisi: `rate_limits.five_hour.used_percentage` (0–100) ve `resets_at`. */
export function parseClaudeStatusline(input: Record<string, unknown>): LimitWindow[] {
  const rl = input.rate_limits as Record<string, Record<string, unknown>> | undefined;
  if (!rl || typeof rl !== 'object') return [];
  const out: LimitWindow[] = [];
  for (const [name, w] of Object.entries(rl)) {
    if (!w || typeof w.used_percentage !== 'number') continue;
    out.push({
      name,
      used_percent: w.used_percentage,
      resets_at: typeof w.resets_at === 'number' ? w.resets_at : null,
      window_minutes: name === 'five_hour' ? 300 : name.startsWith('seven_day') ? 10080 : null,
    });
  }
  return out;
}

/** En yeni dosyaları bulmak için tarih dizinlerini (YYYY/MM/DD) tersten gezer. */
function newestRollouts(sessionsDir: string, max = 5): string[] {
  const out: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (out.length >= max || !existsSync(dir)) return;
    const entries = readdirSync(dir).sort().reverse();
    if (depth === 3) {
      const files = entries
        .filter((f) => f.startsWith('rollout-') && f.endsWith('.jsonl'))
        .map((f) => join(dir, f))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
      out.push(...files.slice(0, max - out.length));
      return;
    }
    for (const e of entries) walk(join(dir, e), depth + 1);
  };
  walk(sessionsDir, 0);
  return out;
}

/**
 * Codex limitleri: `~/.codex/sessions/**\/rollout-*.jsonl` içindeki son `token_count`
 * olayının `rate_limits` alanı (primary ≈ 5 saat, secondary ≈ haftalık).
 */
export function readCodexLimits(env: NodeJS.ProcessEnv = process.env): WorkerLimits | null {
  const codexHome = env.CODEX_HOME ?? join(homedir(), '.codex');
  for (const file of newestRollouts(join(codexHome, 'sessions'))) {
    const lines = readFileSync(file, 'utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i]!;
      if (!l.includes('"rate_limits"')) continue;
      try {
        const ev = JSON.parse(l) as {
          timestamp?: string;
          payload?: { rate_limits?: Record<string, unknown> };
        };
        const rl = ev.payload?.rate_limits;
        if (!rl) continue;
        const windows: LimitWindow[] = [];
        for (const name of ['primary', 'secondary']) {
          const w = rl[name] as Record<string, number> | null | undefined;
          if (w && typeof w.used_percent === 'number') {
            windows.push({
              name:
                w.window_minutes === 300
                  ? 'five_hour'
                  : w.window_minutes === 10080
                    ? 'seven_day'
                    : name,
              used_percent: w.used_percent,
              resets_at: w.resets_at ?? null,
              window_minutes: w.window_minutes ?? null,
            });
          }
        }
        return {
          worker: 'codex',
          source: 'codex rollout token_count',
          observed_at: ev.timestamp ?? new Date(statSync(file).mtimeMs).toISOString(),
          status: statusFrom(windows),
          windows,
        };
      } catch {
        continue;
      }
    }
  }
  return null;
}

/** İnsan okunur kısa özet: "5s %44 (14:30'da sıfırlanır) · 7g %26". */
export function formatWindows(windows: LimitWindow[]): string {
  const label = (n: string) => (n === 'five_hour' ? '5s' : n.startsWith('seven_day') ? '7g' : n);
  return windows
    .map((w) => {
      const reset = w.resets_at
        ? ` (${new Date(w.resets_at * 1000).toLocaleString('tr-TR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })})`
        : '';
      return `${label(w.name)} %${w.used_percent}${reset}`;
    })
    .join(' · ');
}
