import { describe, expect, it } from 'vitest';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { JobSpec } from '../../src/adapters/types.js';
import { validateWorkerResult, SUMMARY_MAX } from '../../src/contracts/worker-result.js';
import { compilePrompt } from '../../src/core/prompt.js';
import { resolveEffort } from '../../src/core/token-profile.js';
import { Store } from '../../src/store/store.js';
import { sampleResult, tempDir } from '../helpers.js';

describe('token profili (F22)', () => {
  it('rol başına effort; işçi ayarı profili ezer; off işçi varsayılanı', () => {
    expect(resolveEffort('balanced', 'review')).toBe('high');
    expect(resolveEffort('balanced', 'test')).toBe('low');
    expect(resolveEffort('saver', 'analysis')).toBe('low');
    expect(resolveEffort('quality', 'implementation')).toBe('high');
    expect(resolveEffort('off', 'review')).toBeUndefined();
    expect(resolveEffort('saver', 'review', 'high')).toBe('high');
    expect(resolveEffort('saver', 'test', { review: 'high' })).toBe('low');
    expect(resolveEffort('off', 'review', { review: 'medium' })).toBe('medium');
  });

  it('Codex: effort ve telemetri kapatma config ile geçer', () => {
    const c = new CodexAdapter({ platform: 'linux' });
    const job = { effort: 'low' } as JobSpec;
    expect(c.tuningArgs(job)).toEqual([
      '-c',
      'analytics.enabled=false',
      '-c',
      'model_reasoning_effort="low"',
    ]);
    expect(c.tuningArgs({} as JobSpec)).toEqual(['-c', 'analytics.enabled=false']);
  });

  it('uzun summary kırpılır ve uyarı verilir', () => {
    const r = validateWorkerResult(sampleResult({ summary: 'x'.repeat(5000) }), {
      taskId: 'T-1',
      jobId: 'J-1',
      role: 'implementation',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.summary.length).toBe(SUMMARY_MAX);
      expect(r.warnings.join()).toMatch(/kırpıldı/);
    }
  });
});

describe('önbellek dostu iş emri (F22)', () => {
  it('implementation and test prompts include localized sandbox rules only for those roles', () => {
    const t = tempDir();
    const store = new Store(t.dir);
    try {
      const task = store.createTask({ title: 'T', objective: 'O' });
      for (const role of ['implementation', 'test', 'review'] as const) {
        const job = store.createJob({
          taskId: task.id,
          role,
          worker: 'codex',
          workspaceMode: 'shared',
          workdir: t.dir,
          instructions: 'I',
          timeoutS: 30,
        });
        for (const language of ['tr', 'en'] as const) {
          const prompt = compilePrompt(task, job, { lang: language });
          expect(prompt).toContain(
            language === 'tr'
              ? 'Raporu iş emrinin dilinde yaz'
              : 'Write the report in the job order language',
          );
          if (role === 'review') {
            expect(prompt).not.toContain('## Sandbox');
            expect(prompt).toContain(
              language === 'tr' ? 'status completed olsa bile' : 'even when status is completed',
            );
          } else {
            expect(prompt).toContain(
              language === 'tr' ? 'Yalnız gerçek engel varsa partial' : 'only for a real blocker',
            );
            expect(prompt).toContain(
              `## ${language === 'tr' ? 'Sandbox kuralları' : 'Sandbox rules'}`,
            );
            expect(prompt).toContain('.anafor-tmp/');
            expect(prompt).toContain('failed');
            expect(prompt).toContain(language === 'tr' ? 'sandbox dışında' : 'outside the sandbox');
          }
        }
      }
    } finally {
      store.close();
      t.cleanup();
    }
  });

  it('prompt environment and focused review context are included', () => {
    const t = tempDir();
    const store = new Store(t.dir);
    try {
      const task = store.createTask({ title: 'review', objective: 'check' });
      const job = store.createJob({
        taskId: task.id,
        role: 'review',
        worker: 'codex',
        workspaceMode: 'readonly',
        workdir: t.dir,
        instructions: 'review diff',
        timeoutS: 30,
      });
      const prompt = compilePrompt(task, job, {
        environment: {
          working: ['node', 'lat.cmd'],
          unavailable: ['bun'],
          note: 'Testleri Anafor iş sonrasında sandbox dışında çalıştıracak; çalışmayan araç için alternatif arama.',
        },
        reviewContext: {
          diffSummary: 'src/a.ts | 2 +-',
          autoCheck: { command: 'npm test', passed: true, summary: 'npm test → 0' },
        },
      });
      expect(prompt).toContain('## Çalışma ortamı');
      expect(prompt).toContain('node, lat.cmd');
      expect(prompt).toContain('bun');
      expect(prompt).toContain('src/a.ts | 2 +-');
      expect(prompt).toContain('npm test → geçti');
      expect(prompt).toContain('Testleri çalıştırma, sonuç yukarıda');
    } finally {
      store.close();
      t.cleanup();
    }
  });
  it('aynı roldeki işlerde önek birebir aynı; değişken kısım Kimlik ile başlar', () => {
    const t = tempDir();
    const store = new Store(t.dir);
    try {
      const mk = (title: string) => {
        const task = store.createTask({ title, objective: `${title} hedefi` });
        return {
          task,
          job: store.createJob({
            taskId: task.id,
            role: 'implementation',
            worker: 'codex',
            workspaceMode: 'shared',
            workdir: t.dir,
            instructions: `${title} talimatı`,
            timeoutS: 30,
          }),
        };
      };
      const a = mk('A');
      const b = mk('B');
      const pa = compilePrompt(a.task, a.job);
      const pb = compilePrompt(b.task, b.job);
      const prefix = (p: string) => p.slice(0, p.indexOf('## Kimlik'));
      expect(prefix(pa).length).toBeGreaterThan(500);
      expect(prefix(pa)).toBe(prefix(pb));
      expect(prefix(pa)).not.toContain(a.job.id);
      expect(pa).toContain(`job_id: ${a.job.id}`);

      // devam oturumu: kısa emir, yalnızca kimlik + talimat + bulgular
      const r = compilePrompt(a.task, a.job, {
        resumed: true,
        findings: [
          { severity: 'high', title: 'Eksik test', evidence: 'yok', file: 'a.ts', line: null },
        ],
      });
      expect(r).toMatch(/iş emri \(devam\)/);
      expect(r).toContain(`job_id: ${a.job.id}`);
      expect(r).toContain('[high] Eksik test (a.ts): yok');
      expect(r).not.toContain('A hedefi');
      expect(r.length).toBeLessThan(pa.length / 2);
    } finally {
      store.close();
      t.cleanup();
    }
  });
});

describe('iş emri dili (F24)', () => {
  it('İngilizce iş emri aynı yapıda ve kimlik satırları aynı', () => {
    const t = tempDir();
    const store = new Store(t.dir);
    try {
      const task = store.createTask({ title: 'T', objective: 'O' });
      const job = store.createJob({
        taskId: task.id,
        role: 'review',
        worker: 'codex',
        workspaceMode: 'shared',
        workdir: t.dir,
        instructions: 'I',
        timeoutS: 30,
      });
      const en = compilePrompt(task, job, { lang: 'en' });
      expect(en).toMatch(/^# Anafor job order/);
      expect(en).toContain('Do NOT modify code.');
      expect(en).toContain('## Identity');
      expect(en).toContain(`job_id: ${job.id}`);
      expect(en).toContain('- (not specified)');
      const tr = compilePrompt(task, job, { lang: 'tr' });
      expect(tr).toMatch(/^# Anafor iş emri/);
      expect(compilePrompt(task, job, { lang: 'en', resumed: true })).toMatch(/\(continued\)/);
    } finally {
      store.close();
      t.cleanup();
    }
  });
});
