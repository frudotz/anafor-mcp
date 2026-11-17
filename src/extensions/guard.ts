import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { Decision, PreToolUseInput } from '../hooks/director.js';
import { mcpStatus, projectMcpServers, skillDirs, skillStatus } from './registry.js';

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

const GUIDE =
  'Harici skill/MCP yalnızca SkillSpector kapısından kurulur: `anafor ext add <kaynak>` (skill) veya `anafor ext add-mcp <ad> --source <kaynak> -- <komut…>`; mevcut olanı taratmak için `anafor ext adopt <ad>`.';

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

  // 1) Skill çağrısı: yerel (proje/kullanıcı) skill dizini varsa kayıt ve özet kontrolü.
  if (tool === 'Skill') {
    const name = String(ti.skill ?? ti.name ?? '');
    if (!name || name.includes(':') || name.includes('/') || name.includes('\\')) return null;
    const dirs = skillDirs(ctx.root, home);
    for (const scope of ['project', 'user'] as const) {
      const dir = join(dirs[scope], name);
      if (!existsSync(join(dir, 'SKILL.md'))) continue;
      const st = skillStatus(ctx.root, scope, name, dir, ctx.env);
      if (st === 'ok') return { action: 'allow', reason: 'kayıtlı skill' };
      return verdict(
        `ANAFOR eklenti kapısı: '${name}' skill'i ${st === 'changed' ? 'tarandıktan sonra DEĞİŞMİŞ' : 'SkillSpector ile taranmamış'}. Kullanıcıdan \`anafor ext adopt ${name}${scope === 'user' ? ' --user' : ''}\` çalıştırmasını isteyin.`,
      );
    }
    return null;
  }

  // 2) Proje .mcp.json sunucusunun aracı.
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(tool);
  if (m) {
    const servers = projectMcpServers(ctx.root);
    const server = m[1]!;
    if (!(server in servers)) return null;
    const st = mcpStatus(ctx.root, server, servers[server]!, ctx.env);
    if (st === 'ok') return { action: 'allow', reason: 'kayıtlı MCP' };
    return verdict(
      `ANAFOR eklenti kapısı: '${server}' MCP sunucusu ${st === 'changed' ? 'komutu kayıttan farklı' : 'SkillSpector ile taranmamış'}. ${GUIDE}`,
    );
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
      return verdict(`ANAFOR eklenti kapısı: skill/MCP dosyalarına doğrudan yazılamaz. ${GUIDE}`);
    }
    return null;
  }

  // 4) Kurulum komutları ve ajanın risk onayı vermesi.
  if (tool === 'Bash' || tool === 'PowerShell') {
    const cmd = String(ti.command ?? '');
    if (ACCEPT_RISK.test(cmd)) {
      return {
        action: 'deny',
        reason:
          'ANAFOR eklenti kapısı: CAUTION riskini yalnızca kullanıcı onaylayabilir. Bulguları kullanıcıya gösterin; onaylarsa komutu kendi terminalinde çalıştırsın.',
      };
    }
    for (const [re, what] of INSTALL_PATTERNS)
      if (re.test(cmd))
        return verdict(`ANAFOR eklenti kapısı: '${what}' doğrudan kullanılamaz. ${GUIDE}`);
  }
  return null;
}
