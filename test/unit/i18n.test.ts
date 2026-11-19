import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../../src/i18n/en.js';
import { parseLang, resolveLang, setLang } from '../../src/i18n/index.js';
import { tr } from '../../src/i18n/tr.js';
import { formatWindows } from '../../src/limits/limits.js';
import { tempDir } from '../helpers.js';
import { balance } from '../../src/capacity/balancer.js';
import { recommend, SUBSCRIPTIONS } from '../../src/capacity/meta.js';
import { decideGate } from '../../src/extensions/gate.js';
import { classifyShell } from '../../src/hooks/director.js';
import { AnaforService, type ServiceError } from '../../src/server/service.js';
import { serverInstructions, toolDescriptions } from '../../src/server/tools.js';
import { Store } from '../../src/store/store.js';
import { writeLoopState, readLoopState } from '../../src/loop/state.js';
import { runSessionStart } from '../../src/hooks/session-start.js';

/** Katalogların anahtar ağacı ve fonksiyon/metin türleri birebir aynı olmalı. */
function shape(o: unknown): unknown {
  if (typeof o === 'function') return `fn${o.length}`;
  if (o && typeof o === 'object')
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)]));
  return typeof o;
}

describe('dil desteği (F24)', () => {
  it('tr ve en kataloglarının yapısı aynı', () => {
    expect(shape(en)).toEqual(shape(tr));
  });

  it('dil önceliği: ANAFOR_LANG → kurulum seçimi → sistem', () => {
    const t = tempDir();
    try {
      expect(resolveLang({ ANAFOR_LANG: 'en_US.UTF-8', ANAFOR_HOME: t.dir })).toBe('en');
      expect(resolveLang({ ANAFOR_LANG: 'tr', ANAFOR_HOME: t.dir })).toBe('tr');
      mkdirSync(t.dir, { recursive: true });
      writeFileSync(join(t.dir, 'setup.json'), JSON.stringify({ language: 'en' }));
      expect(resolveLang({ ANAFOR_HOME: t.dir })).toBe('en');
      expect(resolveLang({ ANAFOR_HOME: t.dir, ANAFOR_LANG: 'tr' })).toBe('tr');
      expect(parseLang('de')).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('limit penceresi etiketleri dile göre', () => {
    const w = [{ name: 'five_hour', used_percent: 24, resets_at: 1, window_minutes: 300 }];
    try {
      setLang('en');
      expect(formatWindows(w, 10_000)).toBe('5h reset');
      setLang('tr');
      expect(formatWindows(w, 10_000)).toBe('5s sıfırlandı');
    } finally {
      setLang('tr');
    }
  });

  it('CLI, kapı, kapasite ve hook metinleri dile göre (F24b)', () => {
    const scan = {
      ok: true as const,
      score: 30,
      severity: 'MEDIUM',
      recommendation: 'CAUTION',
      counts: {},
      top: [],
      scanner: 'x',
    };
    try {
      setLang('en');
      expect(decideGate(scan, false).reason).toBe(
        'score 30 MEDIUM CAUTION: review the findings and approve with --accept-risk',
      );
      expect(decideGate({ ok: false, error: 'e' }, false).reason).toMatch(/^scan failed/);
      const rec = recommend(['chatgpt-pro']);
      expect(rec.warnings.join()).toMatch(/The brain needs a Claude subscription/);
      expect(rec.rationale.join()).toMatch(/Brain on the frontier tier/);
      expect(SUBSCRIPTIONS.find((s) => s.id === 'chatgpt-pro')!.label).toBe(
        'ChatGPT Pro (Codex, weekly only)',
      );
      expect(classifyShell('rm -rf x')).toBe('file system command');
      const ar = balance(
        'review',
        [
          { worker: 'a', account: 'claude', costTier: 'high' },
          { worker: 'b', account: 'codex', costTier: 'low' },
        ],
        [],
        'protect-brain',
        1.3,
      );
      expect(ar.notes[0]).toMatch(/load balancer \(protect-brain\): b instead of a/);
      setLang('tr');
      expect(decideGate(scan, false).reason).toMatch(/bulguları inceleyip/);
      expect(classifyShell('rm -rf x')).toBe('dosya sistemi komutu');
    } finally {
      setLang('tr');
    }
  });

  it('MCP sunucusu: araç açıklamaları ve servis hataları dile göre (F24d)', () => {
    const t = tempDir();
    const store = new Store(t.dir);
    const svc = new AnaforService(store, new Map(), () => undefined);
    const err = () => {
      try {
        svc.taskStatus('T-yok');
      } catch (e) {
        return e as ServiceError;
      }
      throw new Error('hata bekleniyordu');
    };
    try {
      setLang('en');
      const e = err();
      expect(e.code).toBe('NOT_FOUND');
      expect(e.message).toBe('Task not found: T-yok');
      expect(e.hint).toBe('List tasks with project_status');
      expect(toolDescriptions().task_status).toBe('Task state, criteria and jobs.');
      expect(toolDescriptions().loop_start).toContain('detached');
      expect(en.service.loopAlreadyActive).toBe('A development loop is already active.');
      expect(en.service.loopStartFailed('spawn error')).toContain('Loop start failed');
      expect(serverInstructions()).toContain('use loop_start');
      expect(serverInstructions()).toMatch(/^Anafor: you are the DIRECTOR/);
      setLang('tr');
      expect(err().message).toBe('Görev bulunamadı: T-yok');
      expect(toolDescriptions().task_status).toBe('Görevin durumu, kriterleri ve işleri.');
      expect(toolDescriptions().loop_start).toContain('geliştirme döngüsü');
      expect(tr.service.loopAlreadyActive).toBe('Geliştirme döngüsü zaten çalışıyor.');
      expect(tr.service.loopStartFailed('hata')).toContain('Döngü başlatılamadı');
      expect(serverInstructions()).toContain('loop_start');
      expect(svc.loopStatus()).toMatchObject({ state: 'idle', cycle: 0 });
      writeLoopState(t.dir, {
        state: 'running',
        goal: 'work',
        cycle: 2,
        session_id: null,
        started_at: new Date().toISOString(),
        paused_reason: null,
        resume_at: null,
        auto_resume: false,
        max_cycles: null,
        until: null,
        last_task: null,
        completed_items: [],
      });
      expect(svc.loopStatus()).toMatchObject({ state: 'running', cycle: 2 });
      expect(() => svc.loopStart({ goal: 'another' })).toThrowError(/zaten çalışıyor/);
      expect(svc.loopStop('pause')).toMatchObject({ state: 'paused' });
      expect(readLoopState(t.dir)?.paused_reason).toBe('manual');
      expect(svc.loopStop('stop')).toMatchObject({ state: 'stopped' });
      writeLoopState(t.dir, {
        state: 'running',
        goal: 'x',
        cycle: 4,
        session_id: null,
        started_at: new Date().toISOString(),
        paused_reason: null,
        resume_at: null,
        auto_resume: false,
        max_cycles: null,
        until: null,
        last_task: null,
        completed_items: [],
      });
      expect(runSessionStart({ cwd: t.dir }, { ANAFOR_HOME: join(t.dir, 'home') })).toContain(
        'Geliştirme döngüsü running · tur 4',
      );
      const starter = (_root: string, args: string[]) => {
        expect(args).toContain('--detach');
        writeLoopState(t.dir, {
          state: 'running',
          goal: 'fake goal',
          cycle: 0,
          session_id: null,
          started_at: new Date().toISOString(),
          paused_reason: null,
          resume_at: null,
          auto_resume: false,
          max_cycles: null,
          until: null,
          last_task: null,
          completed_items: [],
          pid: 4321,
        });
        return { status: 0, stderr: '' };
      };
      writeLoopState(t.dir, {
        state: 'stopped',
        goal: 'old',
        cycle: 4,
        session_id: null,
        started_at: new Date().toISOString(),
        paused_reason: 'stopped',
        resume_at: null,
        auto_resume: false,
        max_cycles: null,
        until: null,
        last_task: null,
        completed_items: [],
      });
      const startSvc = new AnaforService(
        store,
        new Map(),
        () => undefined,
        'codex',
        {},
        'static',
        4,
        starter,
      );
      expect(startSvc.loopStart({ goal: 'fake goal' })).toMatchObject({
        state: 'running',
        pid: 4321,
      });
      expect(readLoopState(t.dir)).toMatchObject({ state: 'running', pid: 4321 });
    } finally {
      setLang('tr');
      store.close();
      t.cleanup();
    }
  });
});
