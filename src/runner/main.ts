#!/usr/bin/env node
/** Ayrık runner giriş noktası: `anafor-runner <projectRoot> <jobId>` */
import { defaultAdapters } from '../adapters/registry.js';
import { loadConfig } from '../core/config.js';
import { acquireLease, releaseLease } from '../core/leases.js';
import { Store } from '../store/store.js';
import { runJob } from './run-job.js';
import { AnaforService } from '../server/service.js';

const [projectRoot, jobId] = process.argv.slice(2);
if (!projectRoot || !jobId) {
  process.stderr.write('kullanım: anafor-runner <projectRoot> <jobId>\n');
  process.exit(2);
}
const store = new Store(projectRoot);
try {
  acquireLease(jobId, projectRoot);
  const config = loadConfig(store.paths.root);
  const adapters = defaultAdapters(config);
  const service = new AnaforService(
    store,
    adapters,
    undefined,
    config.default_worker,
    config.routing,
    config.routing_mode,
    config.max_parallel_jobs,
  );
  const job = await runJob(store, jobId, adapters);
  process.stdout.write(`${job.id} ${job.state}\n`);
} finally {
  try {
    const config = loadConfig(store.paths.root);
    const service = new AnaforService(
      store,
      defaultAdapters(config),
      undefined,
      config.default_worker,
      config.routing,
      config.routing_mode,
      config.max_parallel_jobs,
    );
    service.drainQueue();
  } catch {
    // Queue draining must not mask the finished runner outcome.
  }
  releaseLease(jobId);
  store.close();
}
