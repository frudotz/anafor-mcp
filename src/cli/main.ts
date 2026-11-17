#!/usr/bin/env node
/** anafor CLI: init | doctor | mcp | version */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultAdapters } from '../adapters/registry.js';
import { migrateFromOrchestrator } from '../governance/migrate.js';
import { ensurePolicy } from '../governance/policy.js';
import { runPreToolUse } from '../hooks/director.js';
import { runSessionStart } from '../hooks/session-start.js';
import { startServer } from '../server/main.js';
import { Store } from '../store/store.js';
import { ANAFOR_VERSION } from '../version.js';
import { findAnaforRoot, loadConfig } from '../core/config.js';
import { jobsTable, runChat } from './chat.js';
import { buildGoalPrompt, type RunGoalOptions } from './run.js';
import { runSetup, setupStateSummary } from './setup-cmd.js';
import { readSetupState } from '../setup/setup.js';
import {
  formatWindows,
  parseClaudeStatusline,
  readCodexLimits,
  readStoredLimits,
  recordLimits,
  statusFrom,
  type WorkerLimits,
} from '../limits/limits.js';

const [cmd = 'help', ...rest] = process.argv.slice(2);
const root = resolve(rest.find((a) => !a.startsWith('-')) ?? process.cwd());

/** `--ad değer` biçimindeki seçeneği okur. */
function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
}

/** Anafor projesinin kökü (cwd'den yukarı); yoksa açıklayıcı hata. */
function projectRoot(): string {
  const r = findAnaforRoot(process.cwd());
  if (!r) {
    console.error('Bu dizin bir Anafor projesi değil. Önce `anafor init` (veya `anafor setup`).');
    process.exit(1);
  }
  return r;
}

const ROLES = ['implementation', 'review', 'analysis', 'test'] as const;

function serverEntry(): string {
  return fileURLToPath(new URL('../server/main.js', import.meta.url));
}

function init(root: string): void {
  const store = new Store(root);
  ensurePolicy(store.paths.anaforDir, store.paths.projectId);
  store.close();
  const gi = join(root, '.gitignore');
  const content = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!/^\.anafor\/?$/m.test(content)) {
    appendFileSync(gi, `${content.endsWith('\n') || content === '' ? '' : '\n'}.anafor/\n`);
  }
  const mcp = join(root, '.mcp.json');
  if (readSetupState()?.plugin_installed) {
    console.log(
      'Anafor plugin’i kalıcı kurulu: MCP sunucusu plugin’den gelir, .mcp.json yazılmadı.',
    );
  } else if (!existsSync(mcp)) {
    const cfg = {
      mcpServers: {
        anafor: {
          command: process.execPath,
          args: [serverEntry()],
          env: { ANAFOR_PROJECT_ROOT: root },
        },
      },
    };
    writeFileSync(mcp, JSON.stringify(cfg, null, 2) + '\n');
    console.log(`.mcp.json oluşturuldu (anafor sunucusu).`);
  } else {
    console.log('.mcp.json zaten var; anafor girdisini elle ekleyin:');
    console.log(
      JSON.stringify({ anafor: { command: process.execPath, args: [serverEntry()] } }, null, 2),
    );
  }
  console.log(`Anafor hazır: ${join(root, '.anafor')}`);
}

async function doctor(): Promise<void> {
  const rows: [string, boolean, string][] = [];
  rows.push([
    'node >= 24',
    Number(process.versions.node.split('.')[0]) >= 24,
    process.versions.node,
  ]);
  const git = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd: root,
    encoding: 'utf8',
  });
  rows.push(['git deposu', git.status === 0, git.status === 0 ? 'evet' : 'değil (`git init`)']);
  const proj = findAnaforRoot(root);
  if (proj) {
    try {
      const s = new Store(proj);
      s.close();
      rows.push(['sqlite (.anafor/state.db)', true, proj]);
    } catch (e) {
      rows.push(['sqlite', false, (e as Error).message]);
    }
  } else {
    rows.push(['anafor projesi', true, 'bu dizin bağlı değil (anafor init)']);
  }
  rows.push(['kurulum', readSetupState() !== null, setupStateSummary()]);
  for (const a of defaultAdapters(proj ? loadConfig(proj) : undefined).values()) {
    const d = await a.detect();
    rows.push([
      `işçi: ${a.id}`,
      d.available && d.authOk !== false,
      d.available ? `${d.version ?? ''}${d.reason ? ` · ${d.reason}` : ''}` : (d.reason ?? 'yok'),
    ]);
  }
  for (const [name, okv, info] of rows)
    console.log(`${okv ? '✔' : '✘'} ${name.padEnd(28)} ${info}`);
  if (rows.some(([n, okv]) => !okv && !n.startsWith('işçi:'))) process.exitCode = 1;
}

switch (cmd) {
  case 'init':
    init(root);
    break;
  case 'setup':
    process.exitCode = await runSetup({
      yes: rest.includes('--yes'),
      plugin: !rest.includes('--no-plugin'),
      statusline: !rest.includes('--no-statusline'),
      init,
    });
    break;
  case 'doctor':
    await doctor();
    break;
  case 'mcp':
    await startServer(process.env.ANAFOR_PROJECT_ROOT ?? (rest[0] ? root : undefined));
    break;
  case 'migrate': {
    const store = new Store(root);
    try {
      ensurePolicy(store.paths.anaforDir, store.paths.projectId);
      console.log(JSON.stringify(migrateFromOrchestrator(store), null, 2));
    } catch (e) {
      console.error(`göç başarısız: ${(e as Error).message}`);
      process.exitCode = 1;
    } finally {
      store.close();
    }
    break;
  }
  case 'chat': {
    const once = flag('once');
    const model = flag('model');
    const permissionMode = flag('permission-mode');
    process.exitCode = await runChat({
      ...(permissionMode ? { permissionMode } : {}),
      root: projectRoot(),
      ...(rest.includes('--new') ? { newSession: true } : {}),
      ...(once ? { once } : {}),
      ...(model ? { model } : {}),
    });
    break;
  }
  case 'run': {
    const goal = rest.find(
      (a) => !a.startsWith('-') && a !== flag('worker') && a !== flag('review'),
    );
    if (!goal) {
      console.error(
        'kullanım: anafor run "<hedef>" [--accept] [--merge] [--worker w] [--review lightweight|standard|deep] [--model m]',
      );
      process.exit(2);
    }
    const model = flag('model');
    process.exitCode = await runChat({
      root: projectRoot(),
      newSession: true,
      once: buildGoalPrompt({
        goal,
        accept: rest.includes('--accept'),
        merge: rest.includes('--merge'),
        worker: flag('worker'),
        reviewLevel: flag('review') as RunGoalOptions['reviewLevel'],
      }),
      ...(model ? { model } : {}),
    });
    break;
  }
  case 'jobs': {
    const store = new Store(projectRoot());
    try {
      jobsTable(store, rest.includes('--all')).forEach((l) => console.log(l));
    } finally {
      store.close();
    }
    break;
  }
  case 'watch': {
    // Canlı iş akışı: Ctrl+C ile çıkılır.
    const store = new Store(projectRoot());
    const seen = new Map<string, number>();
    console.log('İşler izleniyor (Ctrl+C ile çık)…');
    for (;;) {
      for (const j of store.listJobs()) {
        const evs = store.listEvents(j.id, seen.get(j.id) ?? 0, 50);
        for (const e of evs) {
          console.log(
            `${e.ts.slice(11, 19)} ${j.id} ${j.worker.padEnd(11)} ${e.type.padEnd(11)} ${e.summary.replace(/\s+/g, ' ').slice(0, 120)}`,
          );
          seen.set(j.id, e.seq);
        }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  case 'roles': {
    const r = projectRoot();
    const file = join(r, 'anafor.config.json');
    if (rest[0] === 'set') {
      const role = rest[1] as (typeof ROLES)[number];
      const workers = (rest[2] ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!ROLES.includes(role) || !workers.length) {
        console.error(`kullanım: anafor roles set <${ROLES.join('|')}> <işçi1,işçi2,…>`);
        process.exit(2);
      }
      const known = [...defaultAdapters(loadConfig(r)).keys()];
      const unknown = workers.filter((w) => !known.includes(w));
      if (unknown.length)
        console.warn(
          `uyarı: kayıtlı olmayan işçi: ${unknown.join(', ')} (kayıtlı: ${known.join(', ')})`,
        );
      const cfg = existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
        : {};
      cfg.routing = { ...((cfg.routing as object | undefined) ?? {}), [role]: workers };
      writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
      console.log(`${role} → ${workers.join(' → ')} (anafor.config.json)`);
      break;
    }
    const cfg = loadConfig(r);
    console.log(`beyin       claude (Claude Code + Anafor plugin)`);
    for (const role of ROLES)
      console.log(`${role.padEnd(11)} ${(cfg.routing[role] ?? [cfg.default_worker]).join(' → ')}`);
    console.log(`\nişçiler: ${[...defaultAdapters(cfg).keys()].join(', ')}`);
    console.log('değiştirmek için: anafor roles set <rol> <işçi1,işçi2>');
    break;
  }
  case 'limits': {
    const stored = readStoredLimits();
    const rows: WorkerLimits[] = [];
    const codex = readCodexLimits();
    if (codex) rows.push(codex);
    for (const [k, v] of Object.entries(stored)) if (k !== 'codex' || !codex) rows.push(v);
    if (!rows.length)
      console.log('Henüz limit bilgisi yok (işçi çalıştıkça veya statusline ile dolar).');
    for (const r of rows) {
      const age = Math.round((Date.now() - Date.parse(r.observed_at)) / 60_000);
      console.log(
        `${r.worker.padEnd(12)} ${r.status.padEnd(8)} ${formatWindows(r.windows)}  (${age} dk önce, ${r.source})`,
      );
    }
    break;
  }
  case 'statusline': {
    // Claude Code statusLine komutu: stdin JSON'daki rate_limits kaydedilir, kısa satır yazılır.
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
        string,
        unknown
      >;
      const windows = parseClaudeStatusline(input);
      if (windows.length) {
        recordLimits({
          worker: 'claude',
          source: 'claude statusline',
          observed_at: new Date().toISOString(),
          status: statusFrom(windows),
          windows,
        });
      }
      const model = (input.model as { display_name?: string } | undefined)?.display_name ?? '';
      process.stdout.write(
        `anafor ${model ? `· ${model} ` : ''}${windows.length ? `· ${formatWindows(windows)}` : ''}`,
      );
    } catch {
      process.stdout.write('anafor');
    }
    break;
  }
  case 'hook':
    await hook(rest[0] ?? '');
    break;
  case 'version':
  case '--version':
    console.log(ANAFOR_VERSION);
    break;
  default:
    console.log(`anafor ${ANAFOR_VERSION}
kullanım:
  anafor setup [--yes] [--no-plugin] [--no-statusline]
                          ilk kurulum sihirbazı (işçiler, kalıcı plugin, statusline, proje)
  anafor init [dizin]     projeyi bağlar: .anafor/, politika (.mcp.json plugin yoksa)
  anafor doctor [dizin]   ortam ve işçi kontrolü
  anafor mcp [dizin]      MCP sunucusunu stdio üzerinde başlatır
  anafor migrate [dizin]  eski .orchestrator/ durumunu .anafor/'a kopyalar (kaynak değişmez)
  anafor chat [--new] [--once "mesaj"] [--model m]
                          beyin ajanla terminalden konuşma; işler canlı izlenir
  anafor run "<hedef>" [--accept] [--merge] [--worker w] [--review seviye]
                          headless: beyin hedefi kullanıcısız yürütür (izin istekleri reddedilir)
  anafor jobs [--all]     görev ve iş panosu
  anafor watch            canlı iş olayları
  anafor roles [set <rol> <işçi1,işçi2>]
                          beyin ve işçi rolleri
  anafor limits           bağlı yapay zekâların oturum/kullanım limitleri
  anafor statusline       Claude Code statusLine komutu (limitleri kaydeder)
  anafor hook <olay>      Claude Code hook'u (pre-tool-use | session-start), girdi stdin'den
  anafor version`);
}

/** Claude Code hook'ları. Hata durumunda iş akışını kilitlememek için sessizce izin verir. */
async function hook(event: string): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  try {
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<
      string,
      unknown
    >;
    let out = '';
    if (event === 'pre-tool-use') out = runPreToolUse(input);
    else if (event === 'session-start') out = runSessionStart(input as { cwd?: string });
    if (out) process.stdout.write(out);
  } catch (e) {
    process.stderr.write(`[anafor hook] ${(e as Error).message}\n`);
  }
}
