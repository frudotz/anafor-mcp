#!/usr/bin/env node
/** Ayrık runner giriş noktası: `anafor-runner <projectRoot> <jobId>` */
import { defaultAdapters } from '../adapters/registry.js';
import { Store } from '../store/store.js';
import { runJob } from './run-job.js';

const [projectRoot, jobId] = process.argv.slice(2);
if (!projectRoot || !jobId) {
  process.stderr.write('kullanım: anafor-runner <projectRoot> <jobId>\n');
  process.exit(2);
}
const store = new Store(projectRoot);
try {
  const job = await runJob(store, jobId, defaultAdapters());
  process.stdout.write(`${job.id} ${job.state}\n`);
} finally {
  store.close();
}
