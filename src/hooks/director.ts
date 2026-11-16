import { isAbsolute, matchesGlob, relative, resolve } from 'node:path';
import { findAnaforRoot, loadConfig, type AnaforConfig } from '../core/config.js';
import { activeGrants, recordViolation, type Grant } from './grants.js';

/** Claude Code PreToolUse hook girdisinin kullandığımız alanları (F0'da doğrulandı). */
export interface PreToolUseInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
}

export type Decision =
  | { action: 'allow'; reason?: string }
  | { action: 'deny'; reason: string }
  | { action: 'warn'; reason: string };

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Dosya değiştiren shell desenleri (sezgisel; amaç disiplin, güvenlik değil).
const MUTATING_PATTERNS: [RegExp, string][] = [
  [
    /(^|[^0-9&>=-])>{1,2}(?!\s*&)(?!\s*\/dev\/null)(?!\s*\$null)(?!\s*nul\b)\s*[^\s|&;)]+/i,
    'çıktı yönlendirmesi (>)',
  ],
  [
    /(^|[\s;&|(])(rm|rmdir|mv|cp|mkdir|touch|tee|truncate|ln|chmod|chown|dd|install)\s/,
    'dosya sistemi komutu',
  ],
  [/(^|[\s;&|(])(sed|perl)\s+[^|;&]*-i\b/, 'yerinde düzenleme (-i)'],
  [
    /(^|[\s;&|(])git\s+(apply\b|am\b|checkout\s+--(\s|$)|restore\b|clean\b|stash\s+(pop|apply)\b)/,
    'çalışma ağacını değiştiren git komutu',
  ],
  [
    /\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content)\b/i,
    'dosya değiştiren PowerShell cmdlet',
  ],
  [/\[(System\.)?IO\.File\]::(Write|Append|Delete|Move|Copy)/i, '.NET dosya yazımı'],
  [/\bwriteFileSync|appendFileSync|rmSync|unlinkSync|renameSync\b/, 'betik içinde dosya yazımı'],
  [/\bopen\([^)]*['"][wa]\+?['"]/, 'betik içinde dosya yazımı'],
];

/** Shell komutu dosya değiştiriyor mu? Değiştiriyorsa neden döner. */
export function classifyShell(command: string): string | null {
  for (const [re, why] of MUTATING_PATTERNS) if (re.test(command)) return why;
  return null;
}

function toRel(root: string, cwd: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel)) return null; // proje dışı
  return rel;
}

const matchAny = (rel: string, globs: string[]) => globs.some((g) => matchesGlob(rel, g));

const DENY_MESSAGE = (what: string) =>
  `ANAFOR yönetici modu: ${what}. Sen yöneticisin; işçiliği işçiye ver: ` +
  `anafor MCP aracı job_dispatch (düzeltme için job_request_changes). ` +
  `Gerçek bir pürüz varsa (işçinin çözemediği küçük ve net sorun) önce anafor MCP aracı intervene ile gerekçeli, süreli izin al.`;

/**
 * Yönetici disiplini kararı. Saf fonksiyon: dosya sistemi yalnızca config/izin okumak için.
 */
export function decide(
  input: PreToolUseInput,
  ctx: { root: string; config: AnaforConfig; grants: Grant[] },
): Decision {
  const tool = input.tool_name ?? '';
  const cwd = input.cwd ?? ctx.root;
  const ti = input.tool_input ?? {};
  if (ctx.config.director_mode === 'off') return { action: 'allow' };
  const verdict = (reason: string): Decision =>
    ctx.config.director_mode === 'warn' ? { action: 'warn', reason } : { action: 'deny', reason };

  if (EDIT_TOOLS.has(tool)) {
    const p = String(ti.file_path ?? ti.notebook_path ?? '');
    if (!p) return { action: 'allow' };
    const rel = toRel(ctx.root, cwd, p);
    if (rel === null) return { action: 'allow', reason: 'proje dışı' };
    if (matchAny(rel, ctx.config.allow_paths)) return { action: 'allow', reason: 'izinli yol' };
    const g = ctx.grants.find((x) => matchAny(rel, x.paths));
    if (g) return { action: 'allow', reason: `müdahale izni ${g.grant_id}` };
    return verdict(DENY_MESSAGE(`'${rel}' dosyasını doğrudan düzenleme yasak`));
  }

  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(ti.command ?? '');
    const why = classifyShell(cmd);
    if (!why) return { action: 'allow' };
    if (ctx.grants.length > 0) return { action: 'allow', reason: 'aktif müdahale izni' };
    return verdict(DENY_MESSAGE(`dosya değiştiren shell komutu (${why})`));
  }

  return { action: 'allow' };
}

/** Hook giriş noktası: girdiyi değerlendirir, Claude Code'un beklediği çıktıyı üretir. */
export function runPreToolUse(input: PreToolUseInput): string {
  const root = findAnaforRoot(input.cwd ?? process.cwd());
  if (!root) return ''; // Anafor projesi değil
  const config = loadConfig(root);
  const d = decide(input, { root, config, grants: activeGrants(root) });
  if (d.action === 'allow') return '';
  recordViolation(root, {
    tool: input.tool_name,
    mode: config.director_mode,
    action: d.action,
    reason: d.reason,
    session_id: input.session_id ?? null,
  });
  if (d.action === 'warn') return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: d.reason,
    },
  });
}
