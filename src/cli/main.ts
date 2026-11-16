#!/usr/bin/env node
/** anafor CLI: init | doctor | mcp | version */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultAdapters } from '../adapters/registry.js';
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
    await startServer(process.env.ANAFOR_PROJECT_ROOT ?? root);
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
  anafor version`);
}
