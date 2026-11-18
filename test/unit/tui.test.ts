import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripVTControlCharacters as strip } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  healthSignals,
  recentFailures,
  statusLine,
  statuslineWorkers,
  writeHealth,
} from '../../src/cli/health.js';
import { wrap } from '../../src/cli/ui.js';
import {
  availableUpdate,
  compareVersions,
  refreshInBackground,
  sumFor,
} from '../../src/cli/update.js';
import { writeSetupState } from '../../src/setup/setup.js';
import { Store } from '../../src/store/store.js';
import { ANAFOR_VERSION } from '../../src/version.js';
import { tempDir } from '../helpers.js';

describe('sürüm denetimi (F28)', () => {
  it('sürüm karşılaştırma ve mevcut güncelleme', () => {
    expect(compareVersions('0.4.1', '0.4.0')).toBeGreaterThan(0);
    expect(compareVersions('v0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.4.0', '0.4.0')).toBe(0);
    expect(availableUpdate({ checked_at: 'x', latest: '9.9.9' }, '0.4.0')).toBe('9.9.9');
    expect(availableUpdate({ checked_at: 'x', latest: '0.3.0' }, '0.4.0')).toBeNull();
    expect(availableUpdate(null)).toBeNull();
  });

  it('SHA256SUMS satırı ayrıştırılır', () => {
    const h = 'a'.repeat(64);
    const sums = `${'b'.repeat(64)}  anafor-mcp.tgz\n${h}  anafor-mcp-0.5.0.tgz\n`;
    expect(sumFor(sums, 'anafor-mcp-0.5.0.tgz')).toBe(h);
    expect(sumFor(sums, 'yok.tgz')).toBeNull();
    expect(sumFor('kısa  anafor-mcp-0.5.0.tgz', 'anafor-mcp-0.5.0.tgz')).toBeNull();
  });

  it('arka plan denetimi: kapalıysa veya önbellek tazeyse başlamaz', () => {
    const t = tempDir();
    try {
      expect(refreshInBackground({ ANAFOR_HOME: t.dir, ANAFOR_NO_UPDATE_CHECK: '1' })).toBe(false);
      writeFileSync(
        join(t.dir, 'update-check.json'),
        JSON.stringify({ checked_at: new Date().toISOString(), latest: '0.4.0' }),
      );
      expect(refreshInBackground({ ANAFOR_HOME: t.dir })).toBe(false);
    } finally {
      t.cleanup();
    }
  });
});

describe('statusline ve sağlık sinyalleri (F28)', () => {
  it('geçersiz proje configinde Codex varsayılanına düşer ve satır üretir', () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, '.anafor'));
      writeFileSync(
        join(t.dir, 'anafor.config.json'),
        JSON.stringify({ workers: { codex: { user_config: 'invalid' } } }),
      );
      const workers = statuslineWorkers(t.dir, {});
      expect(workers).toEqual(['codex']);
      expect(
        strip(statusLine({ version: '1', windows: [], update: null, signals: [], workers: [] })),
      ).toBe('anafor v1');
    } finally {
      t.cleanup();
    }
  });

  it('satır: sürüm, güncelleme, öneriler, model, limitler', () => {
    const s = strip(
      statusLine({
        version: '0.4.0',
        model: 'Opus 5.5',
        windows: [{ name: 'five_hour', used_percent: 24, resets_at: null, window_minutes: 300 }],
        update: '0.5.0',
        signals: [{ level: 'warn', text: 'plugin v0.3.0', command: 'anafor setup' }],
      }),
    );
    expect(s).toBe(
      'anafor v0.4.0 · ⬆ v0.5.0: anafor update · ⚠ plugin v0.3.0: anafor setup · Opus 5.5 · 5s %24',
    );
    expect(strip(statusLine({ version: '0.4.0', windows: [], update: null, signals: [] }))).toBe(
      'anafor v0.4.0',
    );
  });

  it('önbellekteki işçi limitlerini yaş ve durum renkleriyle gösterir', () => {
    const now = Date.parse('2026-11-19T12:00:00Z');
    const limit = (minutes: number, status: 'ok' | 'warning' | 'limited' = 'ok') => ({
      worker: 'codex',
      source: 'cache',
      observed_at: new Date(now - minutes * 60_000).toISOString(),
      status,
      windows: [{ name: 'five_hour', used_percent: 3, resets_at: null, window_minutes: 300 }],
    });
    const base = { version: '1', windows: [], update: null, signals: [], now };
    expect(strip(statusLine({ ...base, workers: [limit(5)] }))).toContain('codex 5s %3');
    expect(statusLine({ ...base, workers: [limit(31)] })).toContain('90'); // gray ANSI sequence
    expect(strip(statusLine({ ...base, workers: [limit(31)] }))).toContain('(31dk önce)');
    expect(strip(statusLine({ ...base, workers: [limit(24 * 60)] }))).not.toContain('codex');
    expect(statusLine({ ...base, workers: [limit(1, 'limited')] })).toContain('31m'); // red ANSI sequence
    expect(statusLine({ ...base, workers: [limit(1, 'warning')] })).toContain('33m'); // yellow ANSI sequence
    expect(strip(statusLine({ ...base, workers: [] }))).toBe('anafor v1');
  });

  it('eski plugin, başarısız doctor ve art arda başarısız işler önerilir', () => {
    const t = tempDir();
    try {
      const env = { ANAFOR_HOME: join(t.dir, 'home') };
      expect(healthSignals(undefined, env)).toEqual([]);
      writeSetupState(
        {
          version: '0.0.1',
          plugin_dir: 'p',
          marketplace_dir: 'm',
          plugin_installed: true,
          statusline_installed: true,
          updated_at: 'x',
        },
        env,
      );
      expect(healthSignals(undefined, env)[0]).toMatchObject({ command: 'anafor setup' });
      writeSetupState(
        {
          version: ANAFOR_VERSION,
          plugin_dir: 'p',
          marketplace_dir: 'm',
          plugin_installed: true,
          statusline_installed: true,
          updated_at: 'x',
        },
        env,
      );
      // proje: son 2 saatte 2 başarısız iş
      const root = join(t.dir, 'proje');
      mkdirSync(root);
      const store = new Store(root);
      const task = store.createTask({ title: 't', objective: 'o' });
      for (let i = 0; i < 2; i++) {
        const j = store.createJob({
          taskId: task.id,
          role: 'implementation',
          worker: 'fake',
          workspaceMode: 'shared',
          workdir: root,
          instructions: 'x',
          timeoutS: 30,
        });
        store.transitionJob(j.id, 'starting');
        store.transitionJob(j.id, 'failed', { error: 'x', endedAt: new Date().toISOString() });
      }
      store.close();
      expect(recentFailures(root)).toBe(2);
      expect(healthSignals(root, env)).toEqual([
        { level: 'warn', text: '2 iş başarısız', command: 'anafor doctor' },
      ]);
      writeHealth({ ok: false, problems: ['x'] }, env);
      expect(healthSignals(root, env)).toEqual([
        { level: 'error', text: 'sorun var', command: 'anafor doctor' },
      ]);
    } finally {
      t.cleanup();
    }
  });

  it('ipucu sarma: kelime sınırı ve girinti', () => {
    expect(wrap('bir iki üç dört beş', 9, '  ')).toBe('bir iki\n  üç dört\n  beş');
  });
});
