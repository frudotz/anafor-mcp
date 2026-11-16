import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClaudeLiteAdapter } from '../../src/adapters/claude-lite.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { WorkerAdapter } from '../../src/adapters/types.js';
import { git } from '../../src/git/git.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

/**
 * Adaptör uyum testi: her işçi aynı senaryodan geçmeli.
 * Sahte işçi her zaman; gerçek işçiler ortam değişkeniyle (yerelde):
 *   ANAFOR_E2E_CODEX=1, ANAFOR_E2E_CLAUDE=1
 */
const cases: { adapter: () => WorkerAdapter; enabled: boolean; marker: string }[] = [
  { adapter: () => new FakeAdapter(), enabled: true, marker: '[fake-file:conformance.txt]' },
  { adapter: () => new CodexAdapter(), enabled: process.env.ANAFOR_E2E_CODEX === '1', marker: '' },
  {
    adapter: () => new ClaudeLiteAdapter(),
    enabled: process.env.ANAFOR_E2E_CLAUDE === '1',
    marker: '',
  },
];

describe.each(cases.filter((c) => c.enabled).map((c) => [c.adapter().id, c] as const))(
  'adaptör uyumu: %s',
  (_id, c) => {
    it('worktree işinde dosya oluşturur, doğrulanmış sonuç döner, kabul edilip birleşir', async () => {
      const t = tempDir();
      git(t.dir, ['init', '-q', '-b', 'main']);
      writeFileSync(join(t.dir, '.gitignore'), '.anafor/\n');
      git(t.dir, ['add', '-A']);
      git(t.dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
      const store = new Store(t.dir);
      const adapter = c.adapter();
      const adapters = new Map([[adapter.id, adapter]]);
      const svc = new AnaforService(store, adapters, inProcessLauncher(adapters), adapter.id);
      try {
        const task = svc.taskCreate({
          title: 'Uyum testi',
          objective: 'Proje kökünde conformance.txt dosyasını oluştur; içeriği tek satır: ok',
          acceptanceCriteria: ["conformance.txt içeriği 'ok'"],
        });
        const d = await svc.jobDispatch({
          taskId: task.task_id,
          role: 'implementation',
          instructions: `${c.marker} conformance.txt oluştur (içerik: ok). Başka dosya değiştirme.`,
          timeoutS: 600,
        });
        let w = await svc.jobWait([d.job_id], 50);
        for (let i = 0; i < 12 && w.still_running.length; i++)
          w = await svc.jobWait([d.job_id], 50);
        const job = store.mustGetJob(d.job_id);
        expect(job.error).toBeNull();
        expect(job.state).toBe('needs_review');
        expect(job.result?.status).toBe('completed');
        expect(svc.jobDiff(d.job_id).changed_files).toContain('conformance.txt');
        const acc = svc.taskAccept(task.task_id, d.job_id);
        expect(acc.failed_gates.map((g) => `${g.gate}: ${g.detail}`)).toEqual([]);
        expect(svc.taskMerge(task.task_id).merged).toBe(true);
        expect(readFileSync(join(t.dir, 'conformance.txt'), 'utf8').length).toBeGreaterThan(0);
      } finally {
        store.close();
        t.cleanup();
      }
    }, 700_000);
  },
);
