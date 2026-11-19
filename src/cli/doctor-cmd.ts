import { spawnSync } from 'node:child_process';
import { defaultAdapters } from '../adapters/registry.js';
import { findAnaforRoot, loadConfig } from '../core/config.js';
import { checkExtensions } from '../extensions/registry.js';
import { findSkillspector, skillspectorVersion } from '../extensions/skillspector.js';
import { readSetupState } from '../setup/setup.js';
import { Store } from '../store/store.js';
import { m } from '../i18n/index.js';
import { ANAFOR_VERSION } from '../version.js';
import { recentFailures, writeHealth } from './health.js';
import { c, mark, p, rows, withSpinner } from './ui.js';
import { availableUpdate, readUpdateCache, UPDATE_COMMAND } from './update.js';
import { collectPermissionReport } from './permissions-cmd.js';

/**
 * `anafor doctor` (F28 arayüz, F25 makine okunur çıktı). Her kontrolün kararlı bir kodu ve
 * varsa düzeltme komutu vardır; yapay zekâ ajanları `anafor doctor --json` ile okur
 * (docs/agent-install.md karar ağacı bu kodları kullanır).
 */
export type CheckStatus = 'ok' | 'warn' | 'fail' | 'off';
export interface Check {
  code: string;
  section: 'Anafor' | 'Ortam' | 'Proje' | 'İşçiler';
  status: CheckStatus;
  label: string;
  info: string;
  /** Kullanıcının veya ajanın çalıştırabileceği düzeltme (komut veya ayar). */
  fix?: string;
}

const chk = (
  code: string,
  section: Check['section'],
  status: CheckStatus,
  label: string,
  info: string,
  fix?: string,
): Check => ({ code, section, status, label, info, ...(fix ? { fix } : {}) });

export async function collectChecks(dir: string, spin = true): Promise<Check[]> {
  const out: Check[] = [];
  const t = m().doctor;

  // Anafor
  const upd = availableUpdate(readUpdateCache());
  out.push(
    upd
      ? chk(
          'UPDATE_AVAILABLE',
          'Anafor',
          'warn',
          t.version,
          t.updateAvail(ANAFOR_VERSION, upd),
          UPDATE_COMMAND,
        )
      : chk('VERSION', 'Anafor', 'ok', t.version, `v${ANAFOR_VERSION}`),
  );
  const setup = readSetupState();
  if (!setup)
    out.push(chk('SETUP_MISSING', 'Anafor', 'warn', t.setup, t.setupMissing, 'anafor setup'));
  else if (setup.plugin_installed && setup.version !== ANAFOR_VERSION)
    out.push(
      chk(
        'PLUGIN_OUTDATED',
        'Anafor',
        'warn',
        t.plugin,
        `v${setup.version} (CLI v${ANAFOR_VERSION})`,
        'anafor setup --yes --no-statusline --no-project',
      ),
    );
  else if (setup.plugin_installed)
    out.push(chk('PLUGIN_OK', 'Anafor', 'ok', t.plugin, t.pluginPersistent(setup.version)));
  else
    out.push(
      chk('PLUGIN_SESSION', 'Anafor', 'off', t.plugin, t.pluginNotPersistent, 'anafor setup'),
    );

  // Ortam
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 24;
  out.push(
    nodeOk
      ? chk('NODE_OK', 'Ortam', 'ok', 'Node', process.versions.node)
      : chk('NODE_OLD', 'Ortam', 'fail', 'Node', process.versions.node, t.nodeFix),
  );
  const claude = spawnSync('claude', ['--version'], { encoding: 'utf8', windowsHide: true });
  out.push(
    claude.status === 0
      ? chk(
          'CLAUDE_OK',
          'Ortam',
          'ok',
          'Claude Code',
          claude.stdout.trim().replace(/\s*\(Claude Code\)$/, ''),
        )
      : chk(
          'CLAUDE_MISSING',
          'Ortam',
          'fail',
          'Claude Code',
          t.notFound,
          'https://claude.com/claude-code → claude auth login',
        ),
  );
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  });
  out.push(
    git.status === 0
      ? chk('GIT_REPO', 'Ortam', 'ok', t.gitRepo, t.yes)
      : chk(
          'NOT_GIT_REPO',
          'Ortam',
          'off',
          t.gitRepo,
          t.notGitRepo,
          'git init && git commit --allow-empty -m init',
        ),
  );

  // Proje
  const proj = findAnaforRoot(dir);
  const cfg = proj ? loadConfig(proj) : undefined;
  if (!proj || !cfg) {
    out.push(chk('PROJECT_NOT_INIT', 'Proje', 'off', t.project, t.notInit, 'anafor init'));
  } else {
    out.push(
      chk(
        'PERMISSION_DENIALS',
        'Proje',
        'ok',
        t.permissionDenials(collectPermissionReport(proj, 7).total),
        '',
      ),
    );
    try {
      new Store(proj).close();
      out.push(chk('STORE_OK', 'Proje', 'ok', t.store, proj));
    } catch (e) {
      out.push(chk('STORE_ERROR', 'Proje', 'fail', t.store, (e as Error).message, t.storeFix));
    }
    const n = recentFailures(proj, 24);
    out.push(
      n >= 3
        ? chk('JOBS_FAILING', 'Proje', 'warn', t.last24, t.failedJobs(n), t.jobsFix)
        : chk('JOBS_OK', 'Proje', 'ok', t.last24, t.failedJobs(n)),
    );
    if (cfg.extensions.enforce !== 'off') {
      const bad = checkExtensions(proj).filter((e) => e.status !== 'ok');
      out.push(
        bad.length
          ? chk(
              'EXTENSIONS_BLOCKED',
              'Proje',
              'warn',
              t.extensions,
              t.extBlocked(bad.length, bad.map((e) => `${e.name} (${e.status})`).join(', ')),
              'anafor ext check → anafor ext adopt <ad> [--user]',
            )
          : chk('EXTENSIONS_OK', 'Proje', 'ok', t.extensions, t.extOk),
      );
    }
  }
  const ss = findSkillspector(cfg?.extensions.skillspector_bin ?? null);
  const ssv = ss ? skillspectorVersion(ss) : null;
  out.push(
    ssv
      ? chk('SKILLSPECTOR_OK', 'Proje', 'ok', 'SkillSpector', ssv)
      : chk('SKILLSPECTOR_MISSING', 'Proje', 'off', 'SkillSpector', t.ssMissing, t.ssFix),
  );

  // İşçiler
  const adapters = [...defaultAdapters(cfg).values()];
  const detect = () => Promise.all(adapters.map(async (w) => ({ id: w.id, d: await w.detect() })));
  const ws = spin ? await withSpinner(t.workersCheck, detect) : await detect();
  for (const { id, d } of ws) {
    const ready = d.available && d.authOk !== false;
    const code = !d.available
      ? 'WORKER_UNAVAILABLE'
      : d.authOk === false
        ? 'WORKER_AUTH'
        : d.reason?.includes('windows_sandbox')
          ? 'CODEX_SANDBOX_UNELEVATED'
          : d.reason
            ? 'WORKER_WARNING'
            : 'WORKER_OK';
    out.push(
      chk(
        code,
        'İşçiler',
        !ready ? 'off' : d.reason ? 'warn' : 'ok',
        id,
        ready ? (d.version ?? '') : t.unavailable,
        d.reason,
      ),
    );
  }
  if (!ws.some((w) => w.d.available && w.d.authOk !== false))
    out.push(
      chk(
        'NO_WORKERS',
        'İşçiler',
        'fail',
        t.worker,
        t.noWorkers,
        'npm install -g @openai/codex && codex login',
      ),
    );
  return out;
}

export function summarize(checks: Check[]) {
  const problems = checks.filter((x) => x.status === 'fail');
  const warnings = checks.filter((x) => x.status === 'warn');
  return { ok: problems.length === 0, problems, warnings };
}

export async function runDoctor(dir: string, json = false): Promise<number> {
  const checks = json
    ? await collectChecks(dir, false)
    : await (async () => {
        p.intro(c(['bgCyan', 'black'], m().doctor.title(ANAFOR_VERSION)));
        return collectChecks(dir);
      })();
  const s = summarize(checks);
  writeHealth({ ok: s.ok, problems: s.problems.map((x) => `${x.code}: ${x.info}`) });
  if (json) {
    process.stdout.write(
      JSON.stringify(
        {
          version: ANAFOR_VERSION,
          ok: s.ok,
          problems: s.problems.map((x) => x.code),
          warnings: s.warnings.map((x) => x.code),
          checks,
        },
        null,
        2,
      ) + '\n',
    );
    return s.ok ? 0 : 1;
  }
  const icon = { ok: mark.ok, warn: mark.warn, fail: mark.fail, off: mark.off };
  for (const section of ['Anafor', 'Ortam', 'Proje', 'İşçiler'] as const) {
    const list = checks.filter((x) => x.section === section);
    const workers = list.filter((x) => x.code !== 'NO_WORKERS');
    const title =
      section === 'İşçiler'
        ? m().doctor.workersReady(workers.filter((x) => x.status !== 'off').length, workers.length)
        : m().doctor.sections[section];
    p.note(
      rows(
        list.map((x) => [
          icon[x.status](),
          x.label,
          section === 'İşçiler' || x.code === 'STORE_OK' ? c('gray', x.info) : x.info,
          x.status === 'ok' ? undefined : x.fix,
        ]),
        14,
      ),
      title,
    );
  }
  if (!s.ok || s.warnings.length) p.log.info(c('gray', m().doctor.shareFix));
  if (!s.ok) {
    p.outro(
      c('red', m().doctor.problems(s.problems.length, s.problems.map((x) => x.label).join(', '))),
    );
    return 1;
  }
  p.outro(
    s.warnings.length
      ? c(
          'yellow',
          m().doctor.warnings(s.warnings.length, s.warnings.map((x) => x.label).join(', ')),
        )
      : c('green', m().doctor.allGood),
  );
  return 0;
}
