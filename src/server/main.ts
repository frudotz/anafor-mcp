#!/usr/bin/env node
/** Anafor MCP sunucusu (stdio). Proje kökü: ANAFOR_PROJECT_ROOT veya çalışma dizini. */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultAdapters } from '../adapters/registry.js';
import { Store } from '../store/store.js';
import { AnaforService } from './service.js';
import { createMcpServer } from './tools.js';

export async function startServer(projectRoot: string): Promise<void> {
  const store = new Store(projectRoot);
  const service = new AnaforService(store, defaultAdapters());
  const notes = service.reconcile();
  for (const n of notes) process.stderr.write(`[anafor] reconcile: ${n}\n`);
  const server = createMcpServer(service);
  await server.connect(new StdioServerTransport());
  const shutdown = () => {
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  await startServer(process.env.ANAFOR_PROJECT_ROOT ?? process.cwd());
}
