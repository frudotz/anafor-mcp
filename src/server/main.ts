#!/usr/bin/env node
/**
 * Anafor MCP sunucusu (stdio).
 * Proje kökü: ANAFOR_PROJECT_ROOT → CLAUDE_PROJECT_DIR → cwd'den yukarı ilk `.anafor/`.
 * Kök bulunamazsa `.anafor/` kendiliğinden oluşturulmaz; araçlar `anafor init` önerir.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultAdapters } from '../adapters/registry.js';
import { findAnaforRoot, loadConfig } from '../core/config.js';
import { Store } from '../store/store.js';
import { AnaforService, ServiceError } from './service.js';
import { createMcpServer } from './tools.js';

export function resolveProjectRoot(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()) {
  if (env.ANAFOR_PROJECT_ROOT) return { root: env.ANAFOR_PROJECT_ROOT, initialized: true };
  const start = env.CLAUDE_PROJECT_DIR ?? cwd;
  const found = findAnaforRoot(start);
  return found ? { root: found, initialized: true } : { root: start, initialized: false };
}

export async function startServer(projectRoot?: string): Promise<void> {
  const resolved = projectRoot ? { root: projectRoot, initialized: true } : resolveProjectRoot();
  let service: AnaforService | null = null;
  const getService = (): AnaforService => {
    if (service) return service;
    if (!resolved.initialized && !findAnaforRoot(resolved.root)) {
      throw new ServiceError(
        'NOT_INITIALIZED',
        `Bu proje Anafor için başlatılmamış: ${resolved.root}`,
        'Proje kökünde `anafor init` çalıştırın (veya kullanıcıdan isteyin)',
      );
    }
    const store = new Store(resolved.root);
    const config = loadConfig(resolved.root);
    service = new AnaforService(
      store,
      defaultAdapters(config),
      undefined,
      config.default_worker,
      config.routing,
      config.routing_mode,
      config.max_parallel_jobs,
    );
    for (const n of service.reconcile()) process.stderr.write(`[anafor] reconcile: ${n}\n`);
    return service;
  };
  if (resolved.initialized) getService();

  const server = createMcpServer(getService);
  await server.connect(new StdioServerTransport());
  const shutdown = () => {
    service?.store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isMain) {
  await startServer();
}
