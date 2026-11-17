import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { m } from '../i18n/index.js';

/**
 * NVIDIA SkillSpector entegrasyonu (F23). Tarama her zaman `--no-llm` ile yapılır:
 * dosya içeriği hiçbir LLM sağlayıcısına gönderilmez (yalnızca bağımlılık adları OSV.dev'e).
 * Rapor stdout'tan okunur (Windows'ta `--output` "safe file output" desteklenmiyor).
 */

export interface ScanIssue {
  rule: string;
  severity: string;
  title: string;
  file: string | null;
}

export type ScanResult =
  | {
      ok: true;
      score: number;
      severity: string;
      recommendation: string;
      counts: Record<string, number>;
      top: ScanIssue[];
      scanner: string;
    }
  | { ok: false; error: string };

/** SkillSpector ikilisi: config → ANAFOR_SKILLSPECTOR_BIN → ~/.anafor/tools/skillspector → PATH. */
export function findSkillspector(
  configured?: string | null,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (configured) return configured;
  if (env.ANAFOR_SKILLSPECTOR_BIN) return env.ANAFOR_SKILLSPECTOR_BIN;
  const base = join(env.ANAFOR_HOME ?? join(homedir(), '.anafor'), 'tools', 'skillspector');
  for (const p of [join(base, 'Scripts', 'skillspector.exe'), join(base, 'bin', 'skillspector')])
    if (existsSync(p)) return p;
  const probe = spawnSync('skillspector', ['--version'], { encoding: 'utf8', windowsHide: true });
  return probe.status === 0 ? 'skillspector' : null;
}

export function skillspectorVersion(bin: string): string | null {
  const r = spawnSync(bin, ['--version'], { encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** JSON raporunu ayrıştırır (saf; test edilebilir). */
export function parseReport(stdout: string, scanner = 'skillspector'): ScanResult {
  let d: {
    risk_assessment?: { score?: number; severity?: string; recommendation?: string };
    issues?: {
      rule_id?: string;
      id?: string;
      severity?: string;
      title?: string;
      message?: string;
      category?: string;
      pattern?: string;
      file?: string;
      location?: { file?: string };
    }[];
  };
  try {
    d = JSON.parse(stdout.slice(stdout.indexOf('{'))) as typeof d;
  } catch {
    return { ok: false, error: m().skillspector.notJson };
  }
  const ra = d.risk_assessment;
  if (!ra || typeof ra.score !== 'number' || !ra.recommendation) {
    return { ok: false, error: m().skillspector.noRisk };
  }
  const issues = d.issues ?? [];
  const counts: Record<string, number> = {};
  for (const i of issues) {
    const s = (i.severity ?? 'UNKNOWN').toUpperCase();
    counts[s] = (counts[s] ?? 0) + 1;
  }
  const rank = (s?: string) =>
    ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].indexOf((s ?? '').toUpperCase()) + 1 || 9;
  const top = [...issues]
    .sort((a, b) => rank(a.severity) - rank(b.severity))
    .slice(0, 5)
    .map((i) => ({
      rule: i.rule_id ?? i.id ?? '?',
      severity: (i.severity ?? '?').toUpperCase(),
      title: i.pattern ? `${i.category ?? ''}: ${i.pattern}` : (i.title ?? i.message ?? ''),
      file: i.location?.file ?? i.file ?? null,
    }));
  return {
    ok: true,
    score: ra.score,
    severity: ra.severity ?? '?',
    recommendation: ra.recommendation,
    counts,
    top,
    scanner,
  };
}

/** Yerel dizini tarar. Çıkış 0/1 = rapor var; 2 veya rapor yok = hata (fail-closed). */
export function scanPath(bin: string, target: string, timeoutMs = 10 * 60_000): ScanResult {
  const r = spawnSync(bin, ['scan', target, '--no-llm', '--format', 'json'], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', NO_COLOR: '1' },
  });
  if (r.error) return { ok: false, error: m().skillspector.spawnFailed(r.error.message) };
  if (r.status !== 0 && r.status !== 1) {
    const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' ');
    return { ok: false, error: m().skillspector.failed(String(r.status), msg) };
  }
  return parseReport(r.stdout, skillspectorVersion(bin) ?? 'skillspector');
}
