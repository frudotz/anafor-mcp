import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Decision, PreToolUseInput } from '../hooks/director.js';
import { mcpStatus, projectMcpServers, skillDirs, skillStatus } from './registry.js';
import { m } from '../i18n/index.js';

/**
 * Eklenti koruması (F23, PreToolUse). Yönetici modundan bağımsızdır (`extensions.enforce`):
 *  - kayıtsız/değişmiş skill çağrısı (Skill aracı) ve proje MCP sunucusu aracı engellenir
 *  - skill dizinlerine / .mcp.json'a doğrudan yazma ve resmi kurulum komutları Anafor kapısına yönlendirilir
 *  - risk onayı (--accept-risk) ajan tarafından verilemez; kullanıcının kendi terminalinde verilir
 */
export type EnforceMode = 'block' | 'warn' | 'off';

export interface ExtensionsConfig {
  enforce: EnforceMode;
  /** SkillSpector ikilisi (boşsa ~/.anafor/tools/skillspector veya PATH). */
  skillspector_bin: string | null;
}

export const DEFAULT_EXTENSIONS: ExtensionsConfig = { enforce: 'block', skillspector_bin: null };

const INSTALL_PATTERNS: [RegExp, string][] = [
  [/\bclaude\s+plugins?\s+(install|i|marketplace\s+add)\b/i, 'claude plugin install'],
  [/\bclaude\s+mcp\s+(add|add-json|add-from-claude-desktop)\b/i, 'claude mcp add'],
  [/\bcodex\s+mcp\s+add\b/i, 'codex mcp add'],
  [/\bgemini\s+(mcp\s+add|extensions?\s+install)\b/i, 'gemini mcp/extensions'],
  [/\b(npx|bunx|pnpm\s+dlx)\s+(-y\s+)?skills?\s+(add|install)\b/i, 'skills add'],
];
const ACCEPT_RISK = /\banafor\s+ext\b[^|;&]*--accept-risk\b/i;

export function extensionGuard(
  input: PreToolUseInput,
  ctx: {
    root: string;
    config: { extensions: ExtensionsConfig };
    home?: string;
    env?: NodeJS.ProcessEnv;
  },
): Decision | null {
  const mode = ctx.config.extensions.enforce;
  if (mode === 'off') return null;
  const verdict = (reason: string): Decision =>
    mode === 'warn' ? { action: 'warn', reason } : { action: 'deny', reason };
  const tool = input.tool_name ?? '';
  const ti = input.tool_input ?? {};
  const home = ctx.home ?? homedir();
  const t = m().guard;

  // 1) Skill çağrısı: yerel (proje/kullanıcı) skill dizini varsa kayıt ve özet kontrolü.
  if (tool === 'Skill') {
    const name = String(ti.skill ?? ti.name ?? '');
    if (!name || name.includes(':') || name.includes('/') || name.includes('\\')) return null;
    const dirs = skillDirs(ctx.root, home);
    for (const scope of ['project', 'user'] as const) {
      const dir = join(dirs[scope], name);
      if (!existsSync(join(dir, 'SKILL.md'))) continue;
      const st = skillStatus(ctx.root, scope, name, dir, ctx.env);
      if (st === 'ok') return { action: 'allow', reason: t.skillOk };
      return verdict(
        t.skillBlocked(
          name,
          st === 'changed' ? t.changed : t.unscanned,
          `anafor ext adopt ${name}${scope === 'user' ? ' --user' : ''}`,
        ),
      );
    }
    return null;
  }

  // 2) Proje .mcp.json sunucusunun aracı.
  const mcpMatch = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(tool);
  if (mcpMatch) {
    const servers = projectMcpServers(ctx.root);
    const server = mcpMatch[1]!;
    if (!(server in servers)) return null;
    const st = mcpStatus(ctx.root, server, servers[server]!, ctx.env);
    if (st === 'ok') return { action: 'allow', reason: t.mcpOk };
    return verdict(t.mcpBlocked(server, st === 'changed' ? t.mcpChanged : t.unscanned));
  }

  // 3) Skill dizinlerine veya .mcp.json'a doğrudan yazma.
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(tool)) {
    const p = String(ti.file_path ?? ti.notebook_path ?? '');
    if (!p) return null;
    const abs = isAbsolute(p) ? p : resolve(input.cwd ?? ctx.root, p);
    const inside = (base: string) => {
      const r = relative(base, abs);
      return r !== '' && !r.startsWith('..') && !isAbsolute(r);
    };
    const dirs = skillDirs(ctx.root, home);
    if (
      inside(dirs.project) ||
      inside(dirs.user) ||
      resolve(abs) === resolve(join(ctx.root, '.mcp.json'))
    ) {
      return verdict(t.directWrite);
    }
    return null;
  }

  // 4) Kurulum komutları ve ajanın risk onayı vermesi.
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(ti.command ?? '');
    if (ACCEPT_RISK.test(cmd)) {
      return {
        action: 'deny',
        reason: t.acceptRisk,
      };
    }
    for (const [re, what] of INSTALL_PATTERNS) if (re.test(cmd)) return verdict(t.installCmd(what));
  }
  return null;
}
