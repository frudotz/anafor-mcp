import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { isWindowsShim, quoteCmdArg, killTree } from '../adapters/process.js';
import { m } from '../i18n/index.js';

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

/** Aynı hesabı paylaşan işçiler tek limit kaydı kullanır (cirak = beyin Claude hesabı). */
export function limitAccount(worker: string): string {
  return worker === 'cirak' || worker === 'claude-lite' || worker === 'director'
    ? 'claude'
    : worker;
}

/** Kullanıcı düzeyi Anafor dizini (limitler hesap genelidir). ANAFOR_HOME ile ezilebilir. */
export function anaforHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.ANAFOR_HOME ?? join(homedir(), '.anafor');
}

const limitsFile = (env?: NodeJS.ProcessEnv) => join(anaforHome(env), 'limits.json');
const rateLimitedDir = (env?: NodeJS.ProcessEnv) => join(anaforHome(env), 'rate-limited');
const rateLimitedFile = (worker: string, env?: NodeJS.ProcessEnv) =>
  join(rateLimitedDir(env), `${encodeURIComponent(worker)}.json`);

export function rateLimitedUntil(
  worker: string,
  env?: NodeJS.ProcessEnv,
  now = Date.now(),
): number | null {
  try {
    const value = JSON.parse(readFileSync(rateLimitedFile(worker, env), 'utf8')) as {
      rate_limited_until?: unknown;
    };
    const until = value.rate_limited_until;
    return typeof until === 'number' && until * 1000 > now ? until : null;
  } catch {
    return null;
  }
}

export function recordRateLimitedUntil(
  worker: string,
  until: number,
  env?: NodeJS.ProcessEnv,
): void {
  mkdirSync(rateLimitedDir(env), { recursive: true });
  const file = rateLimitedFile(worker, env);
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify({ worker, rate_limited_until: until }, null, 2));
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        renameSync(temp, file);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // temp may not have been created
    }
    throw error;
  }
}

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
  const codexHome = env.CODEX_HOME || join(homedir(), '.codex');
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

/** Read Codex's official, read-only rate limit endpoint over app-server JSON-RPC. */
export async function readCodexLimitsLive(
  env: NodeJS.ProcessEnv = process.env,
  bin = env.ANAFOR_CODEX_BIN || 'codex',
  timeoutMs = 15_000,
  appServerArgs = ['app-server'],
): Promise<WorkerLimits | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      const args = appServerArgs;
      const shim = isWindowsShim(bin);
      child = spawn(bin, shim ? args.map(quoteCmdArg) : args, {
        env,
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
        shell: shim,
      });
    } catch {
      resolve(null);
      return;
    }
    let done = false;
    let buffer = '';
    let initialized = false;
    const finish = (value: WorkerLimits | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child.exitCode === null) killTree(child);
      resolve(value);
    };
    const send = (obj: object) => child.stdin?.write(`${JSON.stringify(obj)}\n`);
    const timer = setTimeout(() => finish(null), timeoutMs);
    child.on('error', () => finish(null));
    child.on('close', () => finish(null));
    child.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let i: number;
      while ((i = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, i).trim();
        buffer = buffer.slice(i + 1);
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (msg.id === 1 && !initialized) {
          initialized = true;
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (msg.id === 2) {
          if (msg.error) {
            finish(null);
            return;
          }
          const result = (msg.result ?? {}) as Record<string, unknown>;
          const rl = (result.rateLimits ?? {}) as Record<string, unknown>;
          const windows: LimitWindow[] = [];
          for (const [key, name] of [
            ['primary', 'five_hour'],
            ['secondary', 'seven_day'],
          ] as const) {
            const w = rl[key] as Record<string, unknown> | undefined;
            if (w && typeof w.usedPercent === 'number')
              windows.push({
                name,
                used_percent: w.usedPercent,
                resets_at: typeof w.resetsAt === 'number' ? w.resetsAt : null,
                window_minutes:
                  typeof w.windowDurationMins === 'number' ? w.windowDurationMins : null,
              });
          }
          if (!windows.length) {
            finish(null);
            return;
          }
          const limits = rl.rateLimitReachedType ? 'limited' : statusFrom(windows);
          const status =
            result.ordinaryUsageAllowed === false && limits === 'ok' ? 'warning' : limits;
          finish({
            worker: 'codex',
            source: 'codex app-server',
            observed_at: new Date().toISOString(),
            status,
            windows,
          });
        }
      }
    });
    child.stdin?.on('error', () => finish(null));
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'anafor', version: '1' } } });
  });
}

/** İnsan okunur kısa özet: "5s %44 (14:30'da sıfırlanır) · 7g %26" (dil: F24). */
export function formatWindows(windows: LimitWindow[], now = Date.now()): string {
  const t = m().windows;
  const label = (n: string) =>
    n === 'five_hour' ? t.fiveHour : n.startsWith('seven_day') ? t.sevenDay : n;
  return windows
    .map((w) => {
      // Sıfırlanma zamanı geçmişse gözlem bayattır: pencere sıfırlanmıştır.
      if (w.resets_at !== null && w.resets_at * 1000 <= now) return `${label(w.name)} ${t.reset}`;
      const reset = w.resets_at
        ? ` (${new Date(w.resets_at * 1000).toLocaleString(t.locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' })})`
        : '';
      return `${label(w.name)} %${w.used_percent}${reset}`;
    })
    .join(' · ');
}

/** Bir hesabın en güncel önbelleklenmiş limit gözlemi. */
export function currentLimits(
  account: string,
  env: NodeJS.ProcessEnv = process.env,
): WorkerLimits | null {
  const stored = readStoredLimits(env)[account] ?? null;
  if (account !== 'codex') return stored;
  return stored;
}

/** Refresh Codex cache via app-server, falling back to a newer rollout observation only. */
export async function refreshCodexLimits(
  env: NodeJS.ProcessEnv = process.env,
  bin = env.ANAFOR_CODEX_BIN || 'codex',
  timeoutMs = 15_000,
  appServerArgs = ['app-server'],
): Promise<WorkerLimits | null> {
  const live = await readCodexLimitsLive(env, bin, timeoutMs, appServerArgs);
  const stored = readStoredLimits(env).codex ?? null;
  const candidate = live ?? readCodexLimits(env);
  if (!candidate) return stored;
  if (live || !stored || Date.parse(candidate.observed_at) > Date.parse(stored.observed_at)) {
    recordLimits(candidate, env);
    return candidate;
  }
  return stored;
}
