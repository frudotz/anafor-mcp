import { spawnSync } from 'node:child_process';
import { defaultAdapters } from '../adapters/registry.js';
import { findAnaforRoot, loadConfig } from '../core/config.js';
import { checkExtensions } from '../extensions/registry.js';
import { findSkillspector, skillspectorVersion } from '../extensions/skillspector.js';
import { readSetupState } from '../setup/setup.js';
import { Store } from '../store/store.js';
import { ANAFOR_VERSION } from '../version.js';
import { recentFailures, writeHealth } from './health.js';
import { c, mark, p, rows, withSpinner } from './ui.js';
import { availableUpdate, readUpdateCache, UPDATE_COMMAND } from './update.js';

type Row = [string, string, string, string?];

/**
 * `anafor doctor`: bölümlere ayrılmış kontrol. Sonuç ~/.anafor/health.json'a yazılır;
 * statusline sorun varsa `anafor doctor` önerir.
 */
export async function runDoctor(dir: string): Promise<number> {
  p.intro(c(['bgCyan', 'black'], ` anafor doctor · v${ANAFOR_VERSION} `));
  const problems: string[] = [];
  const warnings: string[] = [];
  const fail = (msg: string) => (problems.push(msg), mark.fail());
  const warn = (msg: string) => (warnings.push(msg), mark.warn());

  // Anafor
  const a: Row[] = [];
  const upd = availableUpdate(readUpdateCache());
  a.push(
    upd
      ? [warn(`yeni sürüm v${upd}`), 'sürüm', `v${ANAFOR_VERSION} → v${upd} mevcut`, UPDATE_COMMAND]
      : [mark.ok(), 'sürüm', `v${ANAFOR_VERSION}`],
  );
  const setup = readSetupState();
  if (!setup) a.push([warn('kurulum yapılmamış'), 'kurulum', 'yapılmamış', 'anafor setup']);
  else if (setup.plugin_installed && setup.version !== ANAFOR_VERSION)
    a.push([
      warn('plugin eski'),
      'plugin',
      `v${setup.version} (CLI v${ANAFOR_VERSION})`,
      'anafor setup',
    ]);
  else
    a.push([
      mark.ok(),
      'plugin',
      setup.plugin_installed ? `kalıcı kurulu (v${setup.version})` : 'oturumluk',
    ]);
  p.note(rows(a, 14), 'Anafor');

  // Ortam
  const nodeOk = Number(process.versions.node.split('.')[0]) >= 24;
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: dir,
    encoding: 'utf8',
    windowsHide: true,
  });
  p.note(
    rows(
      [
        [nodeOk ? mark.ok() : fail('Node 24+ gerekli'), 'Node', process.versions.node],
        [
          git.status === 0 ? mark.ok() : mark.off(),
          'git deposu',
          git.status === 0 ? 'evet' : 'değil',
          git.status === 0 ? undefined : 'git init',
        ],
      ],
      14,
    ),
    'Ortam',
  );

  // Proje
  const proj = findAnaforRoot(dir);
  const pr: Row[] = [];
  if (!proj) pr.push([mark.off(), 'proje', 'bu dizin bağlı değil', 'anafor init']);
  else {
    try {
      new Store(proj).close();
      pr.push([mark.ok(), 'durum deposu', c('gray', proj)]);
    } catch (e) {
      pr.push([fail('durum deposu açılamadı'), 'durum deposu', (e as Error).message]);
    }
    const n = recentFailures(proj, 24);
    pr.push(
      n >= 3
        ? [warn(`${n} başarısız iş`), 'son 24 sa', `${n} iş başarısız`, 'anafor jobs --all']
        : [mark.ok(), 'son 24 sa', `${n} başarısız iş`],
    );
    const cfg = loadConfig(proj);
    if (cfg.extensions.enforce !== 'off') {
      const bad = checkExtensions(proj).filter((e) => e.status !== 'ok');
      pr.push(
        bad.length
          ? [
              warn('taranmamış eklenti'),
              'eklentiler',
              `${bad.length} engelli: ${bad.map((e) => e.name).join(', ')}`,
              'anafor ext check',
            ]
          : [mark.ok(), 'eklentiler', 'tümü taranmış'],
      );
    }
  }
  const ss = findSkillspector(proj ? loadConfig(proj).extensions.skillspector_bin : null);
  const ssv = ss ? skillspectorVersion(ss) : null;
  pr.push(
    ssv
      ? [mark.ok(), 'SkillSpector', ssv]
      : [
          mark.off(),
          'SkillSpector',
          'yok: harici eklenti eklenemez',
          'anafor ext (kurulum yardımı)',
        ],
  );
  p.note(rows(pr, 14), 'Proje');

  // İşçiler
  const adapters = [...defaultAdapters(proj ? loadConfig(proj) : undefined).values()];
  const ws = await withSpinner('İşçiler denetleniyor', () =>
    Promise.all(adapters.map(async (w) => ({ id: w.id, d: await w.detect() }))),
  );
  const ready = ws.filter((w) => w.d.available && w.d.authOk !== false).length;
  if (!ready) problems.push('hiç kullanılabilir işçi yok');
  p.note(
    rows(
      ws.map(({ id, d }): Row => {
        const ok = d.available && d.authOk !== false;
        if (!ok) return [mark.off(), id, c('gray', 'kullanılamıyor'), d.reason ?? undefined];
        if (d.reason)
          return [
            warn(`${id}: ${d.reason.split(':')[0]}`),
            id,
            c('gray', d.version ?? ''),
            d.reason,
          ];
        return [mark.ok(), id, c('gray', d.version ?? '')];
      }),
      14,
    ),
    `İşçiler (${ready}/${ws.length} hazır)`,
  );

  writeHealth({ ok: problems.length === 0, problems });
  if (problems.length) {
    p.outro(c('red', `${problems.length} sorun: ${problems.join('; ')}`));
    return 1;
  }
  p.outro(
    warnings.length
      ? c('yellow', `Çalışır durumda; ${warnings.length} öneri: ${warnings.join('; ')}`)
      : c('green', 'Her şey yolunda.'),
  );
  return 0;
}
