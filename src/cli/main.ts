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

const [cmd = 'help', ...rest] = process.argv.slice(2);
const root = resolve(rest.find((a) => !a.startsWith('-')) ?? process.cwd());

function serverEntry(): string {
  return fileURLToPath(new URL('../server/main.js', import.meta.url));
}

function init(): void {
  const store = new Store(root);
  ensurePolicy(store.paths.anaforDir, store.paths.projectId);
  store.close();
  const gi = join(root, '.gitignore');
  const content = existsSync(gi) ? readFileSync(gi, 'utf8') : '';
  if (!/^\.anafor\/?$/m.test(content)) {
    appendFileSync(gi, `${content.endsWith('\n') || content === '' ? '' : '\n'}.anafor/\n`);
  }
  const mcp = join(root, '.mcp.json');
  if (!existsSync(mcp)) {
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
  try {
    const s = new Store(root);
    s.close();
    rows.push(['sqlite (.anafor/state.db)', true, 'tamam']);
  } catch (e) {
    rows.push(['sqlite', false, (e as Error).message]);
  }
  for (const a of defaultAdapters().values()) {
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
    init();
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
  anafor init [dizin]     .anafor/ ve .mcp.json oluşturur
  anafor doctor [dizin]   ortam ve işçi kontrolü
  anafor mcp [dizin]      MCP sunucusunu stdio üzerinde başlatır
  anafor migrate [dizin]  eski .orchestrator/ durumunu .anafor/'a kopyalar (kaynak değişmez)
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
