import { findAnaforRoot, loadConfig } from '../core/config.js';
import { ACTIVE_JOB_STATES } from '../core/states.js';
import { Store } from '../store/store.js';
import { checkExtensions } from '../extensions/registry.js';
import { activeGrants } from './grants.js';

/** SessionStart: yöneticiye kısa rol hatırlatması + proje panosu (token dostu). */
export function runSessionStart(
  input: { cwd?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.ANAFOR_WORKER === '1') return '';
  const root = findAnaforRoot(input.cwd ?? process.cwd());
  if (!root) return '';
  const config = loadConfig(root);
  const store = new Store(root);
  try {
    const tasks = store.listTasks();
    const active = store.listJobs({ states: ACTIVE_JOB_STATES });
    const review = store.listJobs({ states: ['needs_review'] });
    const grants = activeGrants(root);
    const lines = [
      `[Anafor] Bu proje Anafor yönetiminde (director_mode: ${config.director_mode}).`,
      'Sen YÖNETİCİSİN: planla, anafor MCP aracı job_dispatch ile işçiye dağıt, incele, kabul et. Kod dosyalarını kendin düzenleme; pürüzde intervene.',
      `Açık görev: ${tasks.length} · çalışan iş: ${active.length} · inceleme bekleyen: ${review.length} · aktif müdahale: ${grants.length}`,
    ];
    for (const t of tasks.slice(0, 5)) lines.push(`- ${t.id} [${t.state}] ${t.title}`);
    for (const j of review.slice(0, 5))
      lines.push(`- inceleme bekliyor: ${j.id} (${j.worker}, ${j.role})`);
    if (config.extensions.enforce !== 'off') {
      try {
        const bad = checkExtensions(root).filter((e) => e.status !== 'ok');
        if (bad.length) {
          const list = bad
            .slice(0, 5)
            .map((e) => `${e.name}:${e.status}`)
            .join(', ');
          lines.push(
            `⚠ Eklenti kapısı: ${bad.length} skill/MCP taranmamış veya değişmiş (${list}); çağrıları engellenir. Kullanıcı: anafor ext check`,
          );
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
