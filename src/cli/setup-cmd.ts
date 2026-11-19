import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { defaultAdapters } from '../adapters/registry.js';
import { AntigravityAdapter } from '../adapters/google.js';
import { findAnaforRoot, loadConfig } from '../core/config.js';
import { currentLimits, formatWindows, limitAccount } from '../limits/limits.js';
import {
  buildUserPlugin,
  enableAntigravity,
  installHints,
  installPluginToClaude,
  installStatusline,
  readSetupState,
  writeSetupState,
} from '../setup/setup.js';
import { lang, m, setLang, systemLang, type Lang } from '../i18n/index.js';
import { recommend, SUBSCRIPTIONS } from '../capacity/meta.js';
import { ANAFOR_VERSION } from '../version.js';
import { formatRecommendation, runRecommend } from './capacity-cmd.js';
import { ask, c, interactive, mark, p, rows, withSpinner } from './ui.js';

export interface SetupOptions {
  yes: boolean;
  /** Arayüz dili (--lang); verilmezse kurulumda sorulur (etkileşimliyse). */
  lang?: Lang | undefined;
  plugin: boolean;
  statusline: boolean;
  /** Proje bağlama adımı (ör. `anafor update` sonrası atlanır). */
  project?: boolean;
  /** Abonelikler (--subscriptions a,b); verilmezse etkileşimliyse sorulur. */
  subscriptions?: string[] | undefined;
  init: (dir: string) => void;
}

const WORKERS = ['codex', 'cirak', 'gemini', 'opencode', 'local', 'antigravity'];

/** İlk kurulum sihirbazı: ortam, işçiler, kalıcı plugin, statusline, proje. */
export async function runSetup(opts: SetupOptions): Promise<number> {
  // 0. Dil: --lang > (etkileşimliyse) soru > önceki seçim / sistem dili
  let language: Lang = opts.lang ?? readSetupState()?.language ?? lang();
  if (!opts.lang && !opts.yes && interactive()) {
    p.intro(c(['bgCyan', 'black'], ` Anafor · v${ANAFOR_VERSION} `));
    const sel = await p.select({
      message: m().setup.language,
      initialValue: language,
      options: [
        {
          value: 'tr' as const,
          label: 'Türkçe',
          hint: systemLang() === 'tr' ? 'sistem' : undefined,
        },
        {
          value: 'en' as const,
          label: 'English',
          hint: systemLang() === 'en' ? 'system' : undefined,
        },
      ],
    });
    if (p.isCancel(sel)) {
      p.cancel(m().ui.cancelled);
      return 130;
    }
    language = sel;
  }
  setLang(language);
  const t = m().setup;
  p.intro(c(['bgCyan', 'black'], t.title(ANAFOR_VERSION)));

  // 1. Ortam
  const env = await withSpinner(t.envCheck, () => {
    const nodeOk = Number(process.versions.node.split('.')[0]) >= 24;
    const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
    const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true });
    return { nodeOk, git, claude };
  });
  const envOk = env.nodeOk && env.claude.status === 0;
  p.note(
    rows([
      [mark[env.nodeOk ? 'ok' : 'fail'](), 'Node', `${process.versions.node} ${t.nodeNeed}`],
      [
        mark[env.git.status === 0 ? 'ok' : 'fail'](),
        'git',
        env.git.status === 0 ? env.git.stdout.trim().replace(/^git version /, '') : t.notFound,
      ],
      [
        mark[env.claude.status === 0 ? 'ok' : 'fail'](),
        'Claude Code',
        env.claude.status === 0
          ? env.claude.stdout.trim().replace(/\s*\(Claude Code\)$/, '')
          : t.notFound,
        env.claude.status === 0 ? undefined : 'https://claude.com/claude-code',
      ],
    ]),
    t.envTitle,
  );

  if (!envOk) {
    p.cancel(t.envMissing);
    return 1;
  }

  // 2. İşçiler
  const root = findAnaforRoot(process.cwd());
  const adapters = defaultAdapters(root ? loadConfig(root) : undefined);
  const found = await withSpinner(t.workersDetect, () =>
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
          : c('gray', !d?.reason || d.reason.length > 40 ? t.unavailable : d.reason);
        // Uzun neden ipucu satırına; kısa nedende kurulum ipucu gösterilir.
        const hint = avail
          ? undefined
          : d?.reason && d.reason.length > 40
            ? d.reason
            : installHints()[id];
        return [avail ? mark.ok() : mark.off(), id, info, hint];
      }),
    ),
    t.workersTitle(ready.length, WORKERS.length),
  );

  // 3. Abonelikler → önerilen rol dağılımı (F26)
  p.log.step(`${c('bold', t.subsStep)}  ${c('gray', t.subsStepHint)}`);
  const known = new Set(SUBSCRIPTIONS.map((x) => x.id));
  let subs = (opts.subscriptions ?? []).filter((id) => known.has(id));
  if (!opts.subscriptions && !opts.yes && interactive()) {
    const prev = root ? loadConfig(root).subscriptions : (readSetupState()?.subscriptions ?? []);
    const sel = await p.multiselect({
      message: t.subsAsk,
      required: false,
      initialValues: prev.filter((id) => known.has(id)),
      options: SUBSCRIPTIONS.map((x) => ({
        value: x.id,
        label: x.label,
        ...(x.headless !== 'ok' ? { hint: x.headless } : {}),
      })),
    });
    if (p.isCancel(sel)) {
      p.cancel(m().ui.cancelled);
      return 130;
    }
    subs = sel;
  }
  if (!subs.length) p.log.info(t.subsSkipped);
  else {
    p.note(formatRecommendation(recommend(subs)).join('\n'), subs.join(' + '));
    if (root && (await ask(t.subsApplyAsk, true, opts.yes))) {
      runRecommend(root, subs, true);
      p.log.success(t.subsApplied);
    } else if (!root) {
      p.log.info(t.subsLater(subs.join(',')));
    }
  }

  const antigravitySelected = subs.includes('antigravity');
  const agyInstalled = (await new AntigravityAdapter({ acknowledged: true }).detect()).available;
  if (antigravitySelected || agyInstalled) {
    p.note(`${m().adapters.agyTerms}\n\n${m().adapters.agyDisclaimer}`, 'Antigravity');
    if (await ask(t.antigravityAsk, false, opts.yes)) {
      if (enableAntigravity(root ?? undefined)) p.log.success(t.antigravityEnabled);
      else p.log.info(t.antigravityProjectRequired);
    }
  }

  // 4. Plugin
  const { pluginDir, marketplaceDir } = buildUserPlugin();
  let pluginInstalled = readSetupState()?.plugin_installed ?? false;
  p.log.step(`${c('bold', t.pluginStep)}  ${c('gray', t.pluginStepHint)}`);
  if (opts.plugin && (await ask(t.pluginAsk, true, opts.yes))) {
    const r = await withSpinner('claude plugin install', () =>
      installPluginToClaude(marketplaceDir),
    );
    pluginInstalled = r.ok;
    if (r.ok) p.log.success(`${t.pluginOk} ${c('gray', `(v${ANAFOR_VERSION})`)}`);
    else p.log.error(`${t.pluginFail}\n${c('gray', r.log)}`);
  } else {
    p.log.info(`${t.pluginSession} ${c('cyan', `claude --plugin-dir "${pluginDir}"`)}`);
  }

  // 4. Statusline
  let statusline = readSetupState()?.statusline_installed ?? false;
  p.log.step(`${c('bold', t.statusStep)}  ${c('gray', t.statusStepHint)}`);
  if (opts.statusline && (await ask(t.statusAsk, true, opts.yes))) {
    const r = installStatusline();
    statusline = r.ok || statusline;
    (r.ok ? p.log.success : p.log.warn)(r.reason);
  }

  // 5. Proje
  if (opts.project !== false) {
    p.log.step(c('bold', t.projectStep));
    const inRepo =
      spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
        encoding: 'utf8',
        windowsHide: true,
      }).stdout.trim() === 'true';
    if (root) {
      p.log.success(`${t.projectAlready} ${c('gray', root)}`);
    } else if (
      inRepo &&
      (await ask(`${t.projectAsk}\n${c('gray', process.cwd())}`, false, opts.yes))
    ) {
      opts.init(process.cwd());
      p.log.success(t.projectDone);
    } else {
      p.log.info(`${t.projectHint} ${c('cyan', 'anafor init')}`);
    }
  }

  writeSetupState({
    version: ANAFOR_VERSION,
    plugin_dir: pluginDir,
    marketplace_dir: marketplaceDir,
    plugin_installed: pluginInstalled,
    statusline_installed: statusline,
    updated_at: new Date().toISOString(),
    language,
    subscriptions: subs,
  });

  p.note(
    [
      `${c('cyan', 'claude')}            ${t.nextClaude}`,
      `${c('cyan', 'anafor chat')}       ${t.nextChat}`,
      `${c('cyan', 'anafor capacity')}   ${t.nextCapacity}`,
      `${c('cyan', 'anafor doctor')}     ${t.nextDoctor}`,
      c(
        'gray',
        `${t.guide} https://github.com/frudotz/anafor-mcp/blob/main/docs/${language === 'en' ? 'agent-install.md' : 'kurulum.md'}`,
      ),
    ].join('\n'),
    t.nextTitle,
  );
  p.outro(pluginInstalled ? `${c('green', t.ready)} ${t.restart}` : c('green', t.ready));
  return 0;
}

export function setupStateSummary(): string {
  const s = readSetupState();
  if (!s) return 'kurulum sihirbazı çalıştırılmamış (anafor setup)';
  return `plugin ${s.plugin_installed ? `kalıcı kurulu (v${s.version})` : 'kurulu değil'} · statusline ${s.statusline_installed ? 'kurulu' : 'yok'} · ${existsSync(s.plugin_dir) ? 'plugin dizini var' : 'plugin dizini yok'}`;
}
