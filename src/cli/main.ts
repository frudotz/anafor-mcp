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
import { ANAFOR_VERSION, SOURCE_NOTICE } from '../version.js';
import { findAnaforRoot, loadConfig } from '../core/config.js';
import { jobsTable, runChat } from './chat.js';
import { buildGoalPrompt, type RunGoalOptions } from './run.js';
import { runSetup } from './setup-cmd.js';
import { runExt } from './ext-cmd.js';
import { m, parseLang } from '../i18n/index.js';
import { runDoctor } from './doctor-cmd.js';
import { healthSignals, statusLine } from './health.js';
import {
  availableUpdate,
  readUpdateCache,
  refreshInBackground,
  refreshUpdateCache,
  runUpdate,
} from './update.js';
import { formatCapacity, runRecommend } from './capacity-cmd.js';
import { AnaforService } from '../server/service.js';
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
    console.error(m().cli.notProject);
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
    console.log(m().cli.pluginMcp);
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
    console.log(m().cli.mcpCreated);
  } else {
    console.log(m().cli.mcpExists);
    console.log(
      JSON.stringify({ anafor: { command: process.execPath, args: [serverEntry()] } }, null, 2),
    );
  }
  console.log(m().cli.ready(join(root, '.anafor')));
}

switch (cmd) {
  case 'init':
    init(root);
    break;
  case 'setup':
    process.exitCode = await runSetup({
      yes: rest.includes('--yes'),
      lang: rest.includes('--lang')
        ? (parseLang(rest[rest.indexOf('--lang') + 1]) ?? undefined)
        : undefined,
      subscriptions: rest.includes('--subscriptions')
        ? (rest[rest.indexOf('--subscriptions') + 1] ?? '').split(',').filter(Boolean)
        : undefined,
      plugin: !rest.includes('--no-plugin'),
      statusline: !rest.includes('--no-statusline'),
      project: !rest.includes('--no-project'),
      init,
    });
    break;
  case 'doctor':
    process.exitCode = await runDoctor(root, rest.includes('--json'));
    break;
  case 'update':
    try {
      process.exitCode = await runUpdate((l) => console.log(l), rest.includes('--check'));
    } catch (e) {
      console.error(m().update.failed((e as Error).message));
      process.exitCode = 1;
    }
    break;
  case 'update-check':
    // statusline'ın arka planda başlattığı denetim (çıktı yok)
    await refreshUpdateCache();
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
      console.error(m().cli.migrateFailed((e as Error).message));
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
      console.error(m().cli.runUsage);
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
    console.log(m().cli.watching);
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
        console.error(m().cli.rolesUsage(ROLES.join('|')));
        process.exit(2);
      }
      const known = [...defaultAdapters(loadConfig(r)).keys()];
      const unknown = workers.filter((w) => !known.includes(w));
      if (unknown.length)
        console.warn(m().cli.unknownWorkers(unknown.join(', '), known.join(', ')));
      const cfg = existsSync(file)
        ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
        : {};
      cfg.routing = { ...((cfg.routing as object | undefined) ?? {}), [role]: workers };
      writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
      console.log(`${role} → ${workers.join(' → ')} (anafor.config.json)`);
      break;
    }
    const cfg = loadConfig(r);
    console.log(m().cli.brainRow);
    for (const role of ROLES)
      console.log(`${role.padEnd(11)} ${(cfg.routing[role] ?? [cfg.default_worker]).join(' → ')}`);
    console.log(m().cli.balancer(cfg.balancer.strategy));
    console.log(m().cli.workers([...defaultAdapters(cfg).keys()].join(', ')));
    console.log(m().cli.rolesHint);
    break;
  }
  case 'limits': {
    const stored = readStoredLimits();
    const rows: WorkerLimits[] = [];
    const codex = readCodexLimits();
    if (codex) rows.push(codex);
    for (const [k, v] of Object.entries(stored)) if (k !== 'codex' || !codex) rows.push(v);
    if (!rows.length) console.log(m().cli.noLimits);
    for (const r of rows) {
      const age = Math.round((Date.now() - Date.parse(r.observed_at)) / 60_000);
      console.log(
        `${r.worker.padEnd(12)} ${r.status.padEnd(8)} ${formatWindows(r.windows)}  ${m().cli.ago(age, r.source)}`,
      );
    }
    break;
  }
  case 'capacity': {
    const r = projectRoot();
    if (rest[0] === 'recommend') {
      const ids = (rest[1] && !rest[1].startsWith('-') ? rest[1] : '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      runRecommend(r, ids, rest.includes('--apply')).forEach((l) => console.log(l));
      break;
    }
    const cfg = loadConfig(r);
    const store = new Store(r);
    try {
      const svc = new AnaforService(
        store,
        defaultAdapters(cfg),
        undefined,
        cfg.default_worker,
        cfg.routing,
        cfg.routing_mode,
        cfg.max_parallel_jobs,
      );
      const rep = svc.capacityStatus();
      if (rest.includes('--json')) console.log(JSON.stringify(rep, null, 2));
      else formatCapacity(rep).forEach((l) => console.log(l));
    } finally {
      store.close();
    }
    break;
  }
  case 'ext': {
    const res = runExt(projectRoot(), rest);
    res.lines.forEach((l) => console.log(l));
    process.exitCode = res.code;
    break;
  }
  case 'statusline': {
    // Claude Code statusLine komutu: limitleri kaydeder; sürüm, güncelleme ve sağlık önerisi yazar.
    const chunks: Buffer[] = [];
    for await (const ch of process.stdin) chunks.push(ch as Buffer);
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      // geçersiz girdi: yalnızca sürüm yazılır
    }
    let windows: ReturnType<typeof parseClaudeStatusline> = [];
    try {
      windows = parseClaudeStatusline(input);
      if (windows.length)
        recordLimits({
          worker: 'claude',
          source: 'claude statusline',
          observed_at: new Date().toISOString(),
          status: statusFrom(windows),
          windows,
        });
    } catch {
      // limit kaydı statusline'ı durdurmaz
    }
    let signals: ReturnType<typeof healthSignals> = [];
    try {
      refreshInBackground();
      const ws = input.workspace as { current_dir?: string } | undefined;
      signals = healthSignals(ws?.current_dir ?? (input.cwd as string | undefined));
    } catch {
      // sağlık sinyali statusline'ı durdurmaz
    }
    process.stdout.write(
      statusLine({
        version: ANAFOR_VERSION,
        model: (input.model as { display_name?: string } | undefined)?.display_name,
        windows,
        update: availableUpdate(readUpdateCache()),
        signals,
      }),
    );
    break;
  }
  case 'hook':
    await hook(rest[0] ?? '');
    break;
  case '--version':
    console.log(ANAFOR_VERSION);
    break;
  case 'version':
    // AGPL-3.0 §7(b) atıf (NOTICE): kaynak ve lisans her sürümde görünür kalmalı.
    console.log(`${ANAFOR_VERSION}
${SOURCE_NOTICE}`);
    break;
  default:
    console.log(m().help(ANAFOR_VERSION));
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
