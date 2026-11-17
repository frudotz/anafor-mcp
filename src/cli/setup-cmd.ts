import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { defaultAdapters } from '../adapters/registry.js';
import { findAnaforRoot, loadConfig } from '../core/config.js';
import { currentLimits, formatWindows, limitAccount } from '../limits/limits.js';
import {
  buildUserPlugin,
  INSTALL_HINTS,
  installPluginToClaude,
  installStatusline,
  readSetupState,
  writeSetupState,
} from '../setup/setup.js';
import { ANAFOR_VERSION } from '../version.js';
import { ask, c, mark, p, rows, withSpinner } from './ui.js';

export interface SetupOptions {
  yes: boolean;
  plugin: boolean;
  statusline: boolean;
  /** Proje bağlama adımı (ör. `anafor update` sonrası atlanır). */
  project?: boolean;
  init: (dir: string) => void;
}

const WORKERS = ['codex', 'claude-lite', 'gemini', 'opencode', 'local', 'antigravity'];

/** İlk kurulum sihirbazı: ortam, işçiler, kalıcı plugin, statusline, proje. */
export async function runSetup(opts: SetupOptions): Promise<number> {
  p.intro(c(['bgCyan', 'black'], ` Anafor kurulumu · v${ANAFOR_VERSION} `));

  // 1. Ortam
  const env = await withSpinner('Ortam denetleniyor', () => {
    const nodeOk = Number(process.versions.node.split('.')[0]) >= 24;
    const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
    const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true });
    return { nodeOk, git, claude };
  });
  const envOk = env.nodeOk && env.claude.status === 0;
  p.note(
    rows([
      [mark[env.nodeOk ? 'ok' : 'fail'](), 'Node', `${process.versions.node} (24+ gerekli)`],
      [
        mark[env.git.status === 0 ? 'ok' : 'fail'](),
        'git',
        env.git.status === 0 ? env.git.stdout.trim().replace(/^git version /, '') : 'bulunamadı',
      ],
      [
        mark[env.claude.status === 0 ? 'ok' : 'fail'](),
        'Claude Code',
        env.claude.status === 0
          ? env.claude.stdout.trim().replace(/\s*\(Claude Code\)$/, '')
          : 'bulunamadı',
        env.claude.status === 0 ? undefined : 'https://claude.com/claude-code',
      ],
    ]),
    '1 · Ortam',
  );
  if (!envOk) {
    p.cancel('Gerekli bileşenler eksik; kurup `anafor setup` komutunu yeniden çalıştırın.');
    return 1;
  }

  // 2. İşçiler
  const root = findAnaforRoot(process.cwd());
  const adapters = defaultAdapters(root ? loadConfig(root) : undefined);
  const found = await withSpinner('İşçiler algılanıyor', () =>
    Promise.all(
      WORKERS.map(async (id) => {
        const a = adapters.get(id);
        return { id, d: a ? await a.detect() : null };
      }),
    ),
  );
  const ready = found.filter((w) => w.d?.available && w.d.authOk !== false);
  p.note(
    rows(
      found.map(({ id, d }) => {
        const avail = !!d?.available && d.authOk !== false;
        const lim = avail ? currentLimits(limitAccount(id)) : null;
        const info = avail
          ? `${c('gray', (d?.version ?? '').replace(/\s*\(Claude Code\)$/, ''))}${lim ? `  ${formatWindows(lim.windows)}` : ''}`
          : c('gray', !d?.reason || d.reason.length > 40 ? 'kullanılamıyor' : d.reason);
        // Uzun neden ipucu satırına; kısa nedende kurulum ipucu gösterilir.
        const hint = avail
          ? undefined
          : d?.reason && d.reason.length > 40
            ? d.reason
            : INSTALL_HINTS[id];
        return [avail ? mark.ok() : mark.off(), id, info, hint];
      }),
    ),
    `2 · İşçiler (${ready.length}/${WORKERS.length} hazır · beyin: Claude Code)`,
  );

  // 3. Plugin
  const { pluginDir, marketplaceDir } = buildUserPlugin();
  let pluginInstalled = readSetupState()?.plugin_installed ?? false;
  p.log.step(
    `${c('bold', '3 · Claude Code plugin’i')}  ${c('gray', 'yönetici hook’ları, Anafor MCP, /anafor:* komutları')}`,
  );
  if (opts.plugin && (await ask('Plugin Claude Code’a kalıcı kurulsun mu?', true, opts.yes))) {
    const r = await withSpinner('claude plugin install', () =>
      installPluginToClaude(marketplaceDir),
    );
    pluginInstalled = r.ok;
    if (r.ok) p.log.success(`Kuruldu: anafor@anafor-local ${c('gray', `(v${ANAFOR_VERSION})`)}`);
    else p.log.error(`Kurulamadı\n${c('gray', r.log)}`);
  } else {
    p.log.info(`Kalıcı kurulmadı; oturumluk: ${c('cyan', `claude --plugin-dir "${pluginDir}"`)}`);
  }

  // 4. Statusline
  let statusline = readSetupState()?.statusline_installed ?? false;
  p.log.step(
    `${c('bold', '4 · Statusline')}  ${c('gray', 'sürüm, güncelleme, limitler ve sağlık durumu')}`,
  );
  if (
    opts.statusline &&
    (await ask('Statusline kurulsun mu? (mevcut ayar korunur)', true, opts.yes))
  ) {
    const r = installStatusline();
    statusline = r.ok || statusline;
    (r.ok ? p.log.success : p.log.warn)(r.reason);
  }

  // 5. Proje
  if (opts.project !== false) {
    p.log.step(c('bold', '5 · Proje'));
    const inRepo =
      spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
        windowsHide: true,
      }).stdout.trim() === 'true';
    if (root) {
      p.log.success(`Bu dizin zaten Anafor projesi: ${c('gray', root)}`);
    } else if (
      inRepo &&
      (await ask(
        `Bu git deposu Anafor’a bağlansın mı?\n${c('gray', process.cwd())}`,
        false,
        opts.yes,
      ))
    ) {
      opts.init(process.cwd());
      p.log.success('Proje bağlandı.');
    } else {
      p.log.info(`Bir projede bağlamak için: ${c('cyan', 'anafor init')}`);
    }
  }

  writeSetupState({
    version: ANAFOR_VERSION,
    plugin_dir: pluginDir,
    marketplace_dir: marketplaceDir,
    plugin_installed: pluginInstalled,
    statusline_installed: statusline,
    updated_at: new Date().toISOString(),
  });

  p.note(
    [
      `${c('cyan', 'claude')}            Claude Code içinde: /anafor:plan <hedef>`,
      `${c('cyan', 'anafor chat')}       beyin ajanla terminalden konuş`,
      `${c('cyan', 'anafor capacity')}   limitler, kalan iş ve rol önerisi`,
      `${c('cyan', 'anafor doctor')}     sorun olursa kontrol`,
      c('gray', 'Kılavuz: https://github.com/frudotz/anafor-mcp/blob/main/docs/kurulum.md'),
    ].join('\n'),
    'Sonraki adımlar',
  );
  p.outro(
    pluginInstalled
      ? `${c('green', 'Hazır.')} Değişikliklerin geçerli olması için Claude Code’u yeniden başlatın.`
      : c('green', 'Hazır.'),
  );
  return 0;
}

export function setupStateSummary(): string {
  const s = readSetupState();
  if (!s) return 'kurulum sihirbazı çalıştırılmamış (anafor setup)';
  return `plugin ${s.plugin_installed ? `kalıcı kurulu (v${s.version})` : 'kurulu değil'} · statusline ${s.statusline_installed ? 'kurulu' : 'yok'} · ${existsSync(s.plugin_dir) ? 'plugin dizini var' : 'plugin dizini yok'}`;
}
