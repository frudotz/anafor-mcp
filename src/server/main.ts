#!/usr/bin/env node
/**
 * Anafor MCP sunucusu (stdio).
 * Proje kökü: ANAFOR_PROJECT_ROOT → CLAUDE_PROJECT_DIR → cwd'den yukarı ilk `.anafor/`.
 * Kök bulunamazsa `.anafor/` kendiliğinden oluşturulmaz; araçlar `anafor init` önerir.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultAdapters } from '../adapters/registry.js';
import { findAnaforRoot, loadConfig, resolveProjectRoot } from '../core/config.js';
import { m } from '../i18n/index.js';
import { Store } from '../store/store.js';
import { AnaforService, ServiceError } from './service.js';
import { createMcpServer } from './tools.js';
import { configStamp as readConfigStamp, refreshConfigIfChanged } from './config-refresh.js';

export { resolveProjectRoot };

export async function startServer(projectRoot?: string): Promise<void> {
  const resolved = projectRoot ? { root: projectRoot, initialized: true } : resolveProjectRoot();
  let service: AnaforService | null = null;
  let configStamp = '';
  const getService = (): AnaforService => {
    if (service) {
      configStamp = refreshConfigIfChanged(resolved.root, configStamp, () =>
        service!.reloadConfig(),
      );
      return service;
    }
    if (!resolved.initialized && !findAnaforRoot(resolved.root)) {
      throw new ServiceError(
        'NOT_INITIALIZED',
        m().server.notInitialized(resolved.root),
        m().server.notInitializedHint,
      );
    }
    const store = new Store(resolved.root);
    const config = loadConfig(resolved.root);
    configStamp = readConfigStamp(resolved.root);
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
