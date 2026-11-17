#!/usr/bin/env node
/** Ayrık runner giriş noktası: `anafor-runner <projectRoot> <jobId>` */
import { defaultAdapters } from '../adapters/registry.js';
import { loadConfig } from '../core/config.js';
import { acquireLease, releaseLease } from '../core/leases.js';
import { Store } from '../store/store.js';
import { runJob } from './run-job.js';

const [projectRoot, jobId] = process.argv.slice(2);
if (!projectRoot || !jobId) {
  process.stderr.write('kullanım: anafor-runner <projectRoot> <jobId>\n');
  process.exit(2);
}
const store = new Store(projectRoot);
acquireLease(jobId, projectRoot);
try {
  const job = await runJob(store, jobId, defaultAdapters(loadConfig(store.paths.root)));
  process.stdout.write(`${job.id} ${job.state}\n`);
} finally {
  releaseLease(jobId);
  store.close();
}
