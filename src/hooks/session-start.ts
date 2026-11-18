import { loadConfig, resolveProjectRoot } from '../core/config.js';
import { ACTIVE_JOB_STATES } from '../core/states.js';
import { Store } from '../store/store.js';
import { checkExtensions } from '../extensions/registry.js';
import { activeGrants } from './grants.js';
import { m } from '../i18n/index.js';

/** SessionStart: yöneticiye kısa rol hatırlatması + proje panosu (token dostu). */
export function runSessionStart(
  input: { cwd?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.ANAFOR_WORKER === '1') return '';
  const resolved = resolveProjectRoot(env, input.cwd ?? process.cwd());
  if (!resolved.initialized) return '';
  const root = resolved.root;
  const config = loadConfig(root);
  const store = new Store(root);
  try {
    const tasks = store.listTasks();
    const active = store.listJobs({ states: ACTIVE_JOB_STATES });
    const review = store.listJobs({ states: ['needs_review'] });
    const grants = activeGrants(root);
    const t = m().sessionStart;
    const lines = [
      t.managed(config.director_mode),
      t.role,
      t.board(tasks.length, active.length, review.length, grants.length),
    ];
    for (const t of tasks.slice(0, 5)) lines.push(`- ${t.id} [${t.state}] ${t.title}`);
    for (const j of review.slice(0, 5)) lines.push(t.awaitingReview(j.id, j.worker, j.role));
    if (config.extensions.enforce !== 'off') {
      try {
        const bad = checkExtensions(root).filter((e) => e.status !== 'ok');
        if (bad.length) {
          const list = bad
            .slice(0, 5)
            .map((e) => `${e.name}:${e.status}`)
            .join(', ');
          lines.push(t.extBlocked(bad.length, list));
        }
      } catch {
        // kontrol oturumu durdurmaz
      }
    }
    return lines.join('\n');
  } finally {
    store.close();
  }
}
