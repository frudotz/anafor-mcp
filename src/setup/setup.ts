import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { anaforHome } from '../limits/limits.js';
import { ANAFOR_VERSION } from '../version.js';
import { m } from '../i18n/index.js';

const dist = (rel: string) => fileURLToPath(new URL(`../${rel}`, import.meta.url));
const repoPlugin = () => fileURLToPath(new URL('../../plugin', import.meta.url));
const q = (p: string) => `"${p}"`;

export interface SetupState {
  version: string;
  plugin_dir: string;
  marketplace_dir: string;
  plugin_installed: boolean;
  statusline_installed: boolean;
  updated_at: string;
  /** Kurulumda seçilen arayüz dili (F24). */
  language?: 'tr' | 'en';
  /** Kurulumda seçilen abonelikler (F26). */
  subscriptions?: string[];
}

const stateFile = (env?: NodeJS.ProcessEnv) => join(anaforHome(env), 'setup.json');

export function readSetupState(env?: NodeJS.ProcessEnv): SetupState | null {
  try {
    return JSON.parse(readFileSync(stateFile(env), 'utf8')) as SetupState;
  } catch {
    return null;
  }
}

export function writeSetupState(s: SetupState, env?: NodeJS.ProcessEnv): void {
  mkdirSync(anaforHome(env), { recursive: true });
  writeFileSync(stateFile(env), JSON.stringify(s, null, 2));
}

/** Persist the explicit Antigravity opt-in only in the uncommitted local config. */
export function enableAntigravity(root?: string): boolean {
  if (!root) return false;
  const dir = join(root, '.anafor');
  const file = join(dir, 'config.json');
  mkdirSync(dir, { recursive: true });
  let config: Record<string, any> = {};
  if (existsSync(file)) config = JSON.parse(readFileSync(file, 'utf8')) as Record<string, any>;
  config.workers ??= {};
  config.workers.antigravity = {
    ...config.workers.antigravity,
    enabled: true,
    accept_terms_risk: true,
  };
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  return true;
}

/**
 * Kullanıcı düzeyi plugin + yerel marketplace üretir. Komutlar bu kurulumun node ve dist
 * yollarını MUTLAK olarak kullanır; böylece plugin Claude Code önbelleğine kopyalansa da çalışır.
 */
export function buildUserPlugin(env?: NodeJS.ProcessEnv): {
  pluginDir: string;
  marketplaceDir: string;
} {
  const marketplaceDir = join(anaforHome(env), 'marketplace');
  const pluginDir = join(marketplaceDir, 'plugins', 'anafor');
  const node = process.execPath;
  const cli = dist('cli/main.js');
  const server = dist('server/main.js');
  mkdirSync(join(pluginDir, '.claude-plugin'), { recursive: true });
  mkdirSync(join(pluginDir, 'hooks'), { recursive: true });
  mkdirSync(join(marketplaceDir, '.claude-plugin'), { recursive: true });

  const manifest = JSON.parse(
    readFileSync(join(repoPlugin(), '.claude-plugin', 'plugin.json'), 'utf8'),
  ) as Record<string, unknown>;
  writeFileSync(
    join(pluginDir, '.claude-plugin', 'plugin.json'),
    JSON.stringify({ ...manifest, version: ANAFOR_VERSION }, null, 2),
  );
  writeFileSync(
    join(pluginDir, '.mcp.json'),
    JSON.stringify({ mcpServers: { anafor: { command: node, args: [server] } } }, null, 2),
  );
  const hook = (event: string) => ({
    type: 'command',
    command: `${q(node)} ${q(cli)} hook ${event}`,
    timeout: 10,
  });
  writeFileSync(
    join(pluginDir, 'hooks', 'hooks.json'),
    JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: 'Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell|Skill|mcp__.*',
              hooks: [hook('pre-tool-use')],
            },
          ],
          SessionStart: [{ hooks: [hook('session-start')] }],
        },
      },
      null,
      2,
    ),
  );
  cpSync(join(repoPlugin(), 'commands'), join(pluginDir, 'commands'), { recursive: true });
  writeFileSync(
    join(marketplaceDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify(
      {
        name: 'anafor-local',
        owner: { name: 'anafor' },
        plugins: [
          {
            name: 'anafor',
            source: './plugins/anafor',
            description:
              'Claude Code yönetici, Codex/Haiku/yerel modeller işçi: Anafor orkestrasyonu',
            version: ANAFOR_VERSION,
          },
        ],
      },
      null,
      2,
    ),
  );
  return { pluginDir, marketplaceDir };
}

/** Plugin'i Claude Code'a kalıcı kurar (resmi `claude plugin` komutlarıyla). */
export function installPluginToClaude(
  marketplaceDir: string,
  bin = 'claude',
): { ok: boolean; log: string } {
  const run = (args: string[]) => spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  const log: string[] = [];
  const add = run(['plugin', 'marketplace', 'add', marketplaceDir]);
  log.push(
    `marketplace add: ${add.status} ${(add.stdout + add.stderr).trim().split('\n').pop() ?? ''}`,
  );
  const up = run(['plugin', 'marketplace', 'update', 'anafor-local']);
  log.push(`marketplace update: ${up.status}`);
  const inst = run(['plugin', 'install', 'anafor@anafor-local']);
  log.push(`install: ${inst.status} ${(inst.stdout + inst.stderr).trim().split('\n').pop() ?? ''}`);
  return {
    ok: inst.status === 0 || /already|zaten/i.test(inst.stdout + inst.stderr),
    log: log.join('\n'),
  };
}

/**
 * Claude Code statusLine'ını `anafor statusline` olarak ayarlar (beyin limitleri için).
 * Mevcut bir statusLine varsa DOKUNMAZ. Değiştirmeden önce yedek alır.
 */
export function installStatusline(
  claudeSettingsPath = join(homedir(), '.claude', 'settings.json'),
): { changed: boolean; ok: boolean; reason: string } {
  const command = `${q(process.execPath)} ${q(dist('cli/main.js'))} statusline`;
  let settings: Record<string, unknown> = {};
  let updating = false;
  if (existsSync(claudeSettingsPath)) {
    try {
      settings = JSON.parse(readFileSync(claudeSettingsPath, 'utf8')) as Record<string, unknown>;
    } catch {
      return {
        changed: false,
        ok: false,
        reason: m().setupLib.settingsInvalid,
      };
    }
    const cur = (settings.statusLine as { command?: unknown } | undefined)?.command;
    if (cur === command) return { changed: false, ok: true, reason: m().setupLib.statusAlready };
    if (settings.statusLine && !isAnaforStatusline(cur)) {
      return { changed: false, ok: false, reason: m().setupLib.statusOther };
    }
    // Yok veya Anafor'un eski yolu (kurulum yeri değişmiş): yedekle ve yaz.
    updating = settings.statusLine !== undefined;
    copyFileSync(claudeSettingsPath, `${claudeSettingsPath}.anafor-backup`);
  } else {
    mkdirSync(join(claudeSettingsPath, '..'), { recursive: true });
  }
  settings.statusLine = { type: 'command', command };
  writeFileSync(claudeSettingsPath, JSON.stringify(settings, null, 2) + '\n');
  return {
    changed: true,
    ok: true,
    reason: updating ? m().setupLib.statusUpdated : m().setupLib.statusAdded,
  };
}

/** Komut Anafor'un statusline'ı mı? (`…anafor…/dist/cli/main.js" statusline`) */
export function isAnaforStatusline(command: unknown): boolean {
  return (
    typeof command === 'string' &&
    /anafor/i.test(command) &&
    /dist[\\/]+cli[\\/]+main\.js"?\s+statusline\s*$/.test(command)
  );
}

/** Eksik işçiler için kurulum ipuçları (resmi kaynaklar). */
export const installHints = (): Record<string, string> => m().setupLib.hints;
