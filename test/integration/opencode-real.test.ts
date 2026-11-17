import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OpenCodeAdapter, parseOpenCodeLine } from '../../src/adapters/opencode.js';
import { git } from '../../src/git/git.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

// opencode 1.19.5 `run --format json` ile kaydedilen GERÇEK satırlar.
const REAL = [
  '{"type":"step_start","sessionID":"ses_e18c40e15ffeWPE1AWLMBx7zXu","part":{"type":"step-start"}}',
  '{"type":"text","sessionID":"ses_e18c40e15ffeWPE1AWLMBx7zXu","part":{"type":"text","text":"{\\"a\\":1}"}}',
  '{"type":"step_finish","sessionID":"ses_e18c40e15ffeWPE1AWLMBx7zXu","part":{"type":"step-finish","tokens":{"total":70,"input":50,"output":20,"reasoning":0,"cache":{"write":0,"read":0}}}}',
];

describe('opencode gerçek olay biçimi', () => {
  it('step_start → oturum, text → mesaj, step_finish → kullanım', () => {
    expect(REAL.flatMap(parseOpenCodeLine)).toEqual([
      { type: 'session', sessionRef: 'ses_e18c40e15ffeWPE1AWLMBx7zXu' },
      { type: 'message', text: '{"a":1}' },
      { type: 'usage', inputTokens: 50, cachedInputTokens: 0, outputTokens: 20 },
    ]);
  });
});

/**
 * Gerçek opencode ikilisi + sahte OpenAI uyumlu sağlayıcı (hesap ve anahtar gerekmez).
 * Çalıştırma: ANAFOR_E2E_OPENCODE_BIN=<opencode yolu> npx vitest run test/integration/opencode-real.test.ts
 */
describe.skipIf(!process.env.ANAFOR_E2E_OPENCODE_BIN)(
  'opencode gerçek ikili + sahte sağlayıcı',
  () => {
    it('analysis işi doğrulanmış sonuçla needs_review olur', async () => {
      const t = tempDir();
      const port = 18000 + Math.floor(Math.random() * 900);
      const mock: ChildProcess = spawn(
        process.execPath,
        [fileURLToPath(new URL('../fixtures/openai-mock.mjs', import.meta.url)), '', String(port)],
        { stdio: 'ignore' },
      );
      await new Promise((r) => setTimeout(r, 800));
      const xdg = join(t.dir, 'xdg');
      for (const d of ['data', 'config', 'cache', 'state'])
        mkdirSync(join(xdg, d), { recursive: true });
      const cfg = join(t.dir, 'opencode.json');
      writeFileSync(
        cfg,
        JSON.stringify({
          provider: {
            mock: {
              npm: '@ai-sdk/openai-compatible',
              name: 'Mock',
              options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: 'yok' },
              models: { m1: { name: 'm1' } },
            },
          },
        }),
      );
      Object.assign(process.env, {
        OPENCODE_CONFIG: cfg,
        XDG_DATA_HOME: join(xdg, 'data'),
        XDG_CONFIG_HOME: join(xdg, 'config'),
        XDG_CACHE_HOME: join(xdg, 'cache'),
        XDG_STATE_HOME: join(xdg, 'state'),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
      });
      const repo = join(t.dir, 'repo');
      mkdirSync(repo);
      git(repo, ['init', '-q', '-b', 'main']);
      writeFileSync(join(repo, '.gitignore'), '.anafor/\n');
      git(repo, ['add', '-A']);
      git(repo, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
      const adapter = new OpenCodeAdapter({
        bin: process.env.ANAFOR_E2E_OPENCODE_BIN!,
        model: 'mock/m1',
      });
      const adapters = new Map([['opencode', adapter]]);
      const store = new Store(repo);
      try {
        const svc = new AnaforService(store, adapters, inProcessLauncher(adapters), 'opencode');
        const task = svc.taskCreate({ title: 'uyum', objective: 'özetle' });
        const d = await svc.jobDispatch({
          taskId: task.task_id,
          role: 'analysis',
          instructions: 'özetle',
          timeoutS: 240,
        });
        let w = await svc.jobWait([d.job_id], 50);
        for (let i = 0; i < 5 && w.still_running.length; i++) w = await svc.jobWait([d.job_id], 50);
        const job = store.mustGetJob(d.job_id);
        expect(job.error).toBeNull();
        expect(job.state).toBe('needs_review');
        expect(job.sessionRef).toMatch(/^ses_/);
        expect(job.usage?.inputTokens).toBeGreaterThan(0);
      } finally {
        store.close();
        mock.kill();
        t.cleanup();
      }
    }, 300_000);
  },
);
