import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { defaultAdapters } from '../adapters/registry.js';
import { findAnaforRoot, loadConfig } from '../core/config.js';
import { formatWindows, readCodexLimits, readStoredLimits } from '../limits/limits.js';
import {
  buildUserPlugin,
  INSTALL_HINTS,
  installPluginToClaude,
  installStatusline,
  readSetupState,
  writeSetupState,
} from '../setup/setup.js';
import { ANAFOR_VERSION } from '../version.js';

const ok = (b: boolean) => (b ? '\x1b[32m✔\x1b[0m' : '\x1b[31m✘\x1b[0m');

export interface SetupOptions {
  yes: boolean;
  plugin: boolean;
  statusline: boolean;
  init: (dir: string) => void;
}

/** İlk kurulum sihirbazı: ortam, işçiler, kalıcı plugin, statusline, proje. */
export async function runSetup(opts: SetupOptions): Promise<number> {
  const rl = opts.yes ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (question: string, def = true): Promise<boolean> => {
    if (!rl) return def;
    const a = (await rl.question(`${question} ${def ? '[E/h]' : '[e/H]'} `)).trim().toLowerCase();
    return a === '' ? def : a.startsWith('e') || a.startsWith('y');
  };
  try {
    console.log(`\x1b[1mAnafor kurulum sihirbazı\x1b[0m (v${ANAFOR_VERSION})\n`);

    // 1. Ortam
    const nodeOk = Number(process.versions.node.split('.')[0]) >= 24;
    const git = spawnSync('git', ['--version'], { encoding: 'utf8' });
    const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true });
    console.log('1) Ortam');
    console.log(`   ${ok(nodeOk)} Node ${process.versions.node} (24+ gerekli)`);
    console.log(
      `   ${ok(git.status === 0)} ${git.status === 0 ? git.stdout.trim() : 'git bulunamadı'}`,
    );
    console.log(
      `   ${ok(claude.status === 0)} Claude Code ${claude.status === 0 ? claude.stdout.trim() : 'bulunamadı: https://claude.com/claude-code'}`,
    );
    if (!nodeOk || claude.status !== 0) {
      console.log('\nGerekli bileşenler eksik; kurup sihirbazı yeniden çalıştırın.');
      return 1;
    }

    // 2. İşçiler
    console.log('\n2) İşçiler (beyin: Claude Code)');
    const root = findAnaforRoot(process.cwd());
    const adapters = defaultAdapters(root ? loadConfig(root) : undefined);
    const limits = {
      ...readStoredLimits(),
      ...((): Record<string, ReturnType<typeof readCodexLimits>> => {
        const c = readCodexLimits();
        return c ? { codex: c } : {};
      })(),
    };
    for (const id of ['codex', 'claude-lite', 'gemini', 'opencode', 'local', 'antigravity']) {
      const a = adapters.get(id);
      const d = a ? await a.detect() : null;
      const avail = !!d?.available && d.authOk !== false;
      const lim = limits[id === 'claude-lite' ? 'claude' : id];
      const extra = avail
        ? `${d?.version ?? ''}${lim ? ` · ${formatWindows(lim.windows)}` : ''}`
        : (d?.reason ?? 'yapılandırılmamış');
      console.log(`   ${ok(avail)} ${id.padEnd(12)} ${extra}`);
      if (!avail && INSTALL_HINTS[id]) console.log(`      ↳ ${INSTALL_HINTS[id]}`);
    }

    // 3. Plugin
    console.log(
      '\n3) Claude Code plugin’i (yönetici hook’ları + Anafor MCP + /anafor:* komutları)',
    );
    const { pluginDir, marketplaceDir } = buildUserPlugin();
    console.log(`   plugin üretildi: ${pluginDir}`);
    let pluginInstalled = readSetupState()?.plugin_installed ?? false;
    if (
      opts.plugin &&
      (await ask('   Claude Code’a kalıcı olarak kurulsun mu? (claude plugin install)'))
    ) {
      const r = installPluginToClaude(marketplaceDir);
      pluginInstalled = r.ok;
      console.log(`   ${ok(r.ok)} ${r.ok ? 'kuruldu: anafor@anafor-local' : 'kurulamadı'}`);
      if (!r.ok) console.log(r.log.replace(/^/gm, '      '));
    } else {
      console.log(`   kalıcı kurulmadı; oturumluk kullanım: claude --plugin-dir "${pluginDir}"`);
    }

    // 4. Statusline
    let statusline = readSetupState()?.statusline_installed ?? false;
    console.log('\n4) Statusline (Claude limitleri için)');
    if (
      opts.statusline &&
      (await ask('   Claude Code statusLine kurulsun mu? (mevcut ayar korunur)'))
    ) {
      const r = installStatusline();
      statusline = r.changed || statusline;
      console.log(`   ${ok(r.changed)} ${r.reason}`);
    }

    // 5. Proje
    console.log('\n5) Proje');
    const inRepo =
      spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
      }).stdout.trim() === 'true';
    if (root) {
      console.log(`   ${ok(true)} bu dizin zaten Anafor projesi: ${root}`);
    } else if (
      inRepo &&
      (await ask(`   Bu git deposu (${process.cwd()}) Anafor’a bağlansın mı?`))
    ) {
      opts.init(process.cwd());
    } else {
      console.log('   Bir projede: anafor init');
    }

    writeSetupState({
      version: ANAFOR_VERSION,
      plugin_dir: pluginDir,
      marketplace_dir: marketplaceDir,
      plugin_installed: pluginInstalled,
      statusline_installed: statusline,
      updated_at: new Date().toISOString(),
    });

    console.log(`
\x1b[1mHazır.\x1b[0m Sonraki adımlar:
  anafor chat            beyin ajanla terminalden konuş
  claude                 veya Claude Code içinde: /anafor:plan <hedef>
  anafor roles           işçi rolleri · anafor limits  limitler · anafor doctor  kontrol
Kılavuz: https://github.com/frudotz/anafor-mcp/blob/main/docs/kurulum.md`);
    return 0;
  } finally {
    rl?.close();
  }
}

export function setupStateSummary(): string {
  const s = readSetupState();
  if (!s) return 'kurulum sihirbazı çalıştırılmamış (anafor setup)';
  return `plugin ${s.plugin_installed ? 'kalıcı kurulu' : 'kurulu değil'} · statusline ${s.statusline_installed ? 'kurulu' : 'yok'} · ${existsSync(s.plugin_dir) ? s.plugin_dir : 'plugin dizini yok'}`;
}
