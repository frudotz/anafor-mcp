import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  addCost,
  capacityReport,
  DEFAULT_CAPACITY,
  jobDeltas,
  p80,
  readCosts,
  recordJobCost,
  windowState,
  type CostBook,
} from '../../src/capacity/capacity.js';
import { recommend } from '../../src/capacity/meta.js';
import { formatCapacity, runRecommend } from '../../src/cli/capacity-cmd.js';
import { loadConfig } from '../../src/core/config.js';
import type { WorkerLimits } from '../../src/limits/limits.js';
import { tempDir } from '../helpers.js';

const NOW = Date.UTC(2026, 10, 17, 12, 0, 0);
const S = NOW / 1000;
const lim = (worker: string, windows: WorkerLimits['windows'], at = NOW): WorkerLimits => ({
  worker,
  source: 'test',
  observed_at: new Date(at).toISOString(),
  status: 'ok',
  windows,
});

describe('kapasite: pencere durumu', () => {
  it('boş alan rezervi düşer; tempo ve dolma süresi hesaplanır', () => {
    // 5 saatlik pencerenin yarısı geçti, %60 kullanıldı → tempo 1.2
    const w = windowState(
      { name: 'five_hour', used_percent: 60, resets_at: S + 9000, window_minutes: 300 },
      DEFAULT_CAPACITY,
      NOW,
    );
    expect(w).toMatchObject({ used: 60, reserve: 10, free: 30, pace: 1.2 });
    expect(w.eta_full_s).toBe(6000); // 40 KP / (60 KP / 9000 s)
  });

  it('sıfırlanma anı geçmişse pencere boştur', () => {
    const w = windowState(
      { name: 'seven_day', used_percent: 90, resets_at: S - 10, window_minutes: 10080 },
      DEFAULT_CAPACITY,
      NOW,
    );
    expect(w).toMatchObject({ used: 0, free: 85, resets_at: null, pace: null });
  });
});

describe('kapasite: maliyet öğrenme', () => {
  it('jobDeltas: aynı pencerede fark; sıfırlanmış/bayat gözlem yok sayılır', () => {
    const before = lim('codex', [
      { name: 'five_hour', used_percent: 10, resets_at: S + 3600, window_minutes: 300 },
      { name: 'seven_day', used_percent: 40, resets_at: S + 86400, window_minutes: 10080 },
    ]);
    const after = lim(
      'codex',
      [
        { name: 'five_hour', used_percent: 14.5, resets_at: S + 3600, window_minutes: 300 },
        { name: 'seven_day', used_percent: 41, resets_at: S + 86400, window_minutes: 10080 },
      ],
      NOW + 60_000,
    );
    expect(jobDeltas(before, after, NOW, NOW + 60_000)).toEqual({ five_hour: 4.5, seven_day: 1 });
    // gözlem iş başlamadan önce → ölçüm yok
    expect(jobDeltas(before, before, NOW + 1000, NOW + 60_000)).toEqual({});
    // iş sırasında pencere değişti (farklı resets_at) → o pencere yok sayılır
    const shifted = lim(
      'codex',
      [{ name: 'five_hour', used_percent: 2, resets_at: S + 18000, window_minutes: 300 }],
      NOW + 60_000,
    );
    expect(jobDeltas(before, shifted, NOW, NOW + 60_000)).toEqual({});
  });

  it('EMA ve p80; kalıcı defter', () => {
    const book: CostBook = {};
    for (const kp of [2, 4, 3, 10, 3]) addCost(book, 'codex', 'implementation', 'five_hour', kp);
    const e = book.codex!.implementation!.five_hour!;
    expect(e.n).toBe(5);
    expect(p80(e.samples)).toBe(4);
    expect(p80([])).toBe(0);
    const t = tempDir();
    try {
      const env = { ANAFOR_HOME: t.dir };
      recordJobCost('codex', 'review', { five_hour: 2 }, env);
      recordJobCost('codex', 'review', {}, env); // boş: yazılmaz
      expect(readCosts(env).codex!.review!.five_hour!.samples).toEqual([2]);
    } finally {
      t.cleanup();
    }
  });
});

describe('kapasite: rapor ve ipuçları', () => {
  const routing = {
    implementation: ['codex', 'cirak'],
    review: ['cirak', 'codex'],
    analysis: ['cirak'],
    test: ['cirak'],
  };
  const accountOf = (w: string) => (w === 'cirak' ? 'claude' : w);
  const accounts = { claude: ['beyin', 'cirak'], codex: ['codex'], local: ['local'] };

  it('kalan iş tahmini, rezerv uyarısı, tempo uyarısı ve yönlendirme önerisi', () => {
    const costs: CostBook = {};
    for (const kp of [5, 6, 5]) addCost(costs, 'codex', 'implementation', 'five_hour', kp);
    const rep = capacityReport({
      accounts,
      routing,
      accountOf,
      cfg: DEFAULT_CAPACITY,
      now: NOW,
      costs,
      limits: {
        codex: lim('codex', [
          // yarı geçmiş pencerede %75 → tempo 1.5, rezerv sonrası 15 KP boş → 2 iş
          { name: 'five_hour', used_percent: 75, resets_at: S + 9000, window_minutes: 300 },
        ]),
        claude: lim('claude', [
          { name: 'five_hour', used_percent: 95, resets_at: S + 600, window_minutes: 300 },
        ]),
        local: null,
      },
    });
    const codex = rep.accounts.find((a) => a.account === 'codex')!;
    expect(codex.roles.implementation).toEqual({ kp_p80: 6, samples: 3, jobs_left: 2 });
    expect(codex.healthy).toBe(true);
    expect(rep.accounts.find((a) => a.account === 'claude')!.healthy).toBe(false);
    const h = rep.hints.join('\n');
    expect(h).toMatch(/codex: 5s hızlı tükeniyor \(tempo ×1\.5\)/);
    expect(h).toMatch(/codex: 'implementation' için ~2 iş/);
    expect(h).toMatch(/claude: 5s penceresi rezerve ulaştı/);
    expect(h).toMatch(/'review' rolü: cirak kısıtlı → codex öne alınabilir/);
    // local hiçbir rolde kullanılmıyor → gözlem ipucu yok
    expect(h).not.toMatch(/local/);
    const text = formatCapacity({ ...rep, recommendation: null, subscriptions: [] }).join('\n');
    expect(text).toMatch(/codex .*5s %75 boş 15 tempo×1\.5/);
    expect(text).toMatch(/anafor capacity recommend/);
  });

  it('gözlenmemiş ama kullanılan hesap için bilgi ipucu', () => {
    const rep = capacityReport({
      accounts,
      routing,
      accountOf,
      cfg: DEFAULT_CAPACITY,
      now: NOW,
      costs: {},
      limits: {},
    });
    expect(rep.hints.some((x) => x.startsWith('codex: limit henüz gözlenmedi'))).toBe(true);
  });
});

describe('meta profili: önerilen rol dağılımı', () => {
  it('Claude Max + ChatGPT Plus: Codex uygular, Claude çapraz inceler', () => {
    const r = recommend(['claude-max', 'chatgpt-plus']);
    expect(r.brain).toMatch(/^Opus/);
    expect(r.routing.implementation[0]).toBe('codex');
    expect(r.routing.review[0]).toBe('cirak');
    expect(r.warnings).toEqual([]);
  });

  it('eşit kademede uzmanlık ipuçlarını uygular ve kaynak notlarını içerir', () => {
    const ids = ['claude-max', 'chatgpt-plus'];
    const normal = recommend(ids);
    const frontend = recommend(ids, ['Build UI']);
    expect(normal.routing.implementation[0]).toBe('codex');
    expect(normal.routing.analysis[0]).toBe('cirak');
    expect(frontend.routing.implementation[0]).toBe('cirak');
    expect(frontend.rationale.join('\n')).toMatch(/META_PERIOD 2026-Q4.*F33/);
    expect(recommend(ids, ['guide', 'quiet']).routing.implementation[0]).toBe('codex');
  });

  it('yalnızca Claude Pro: Sonnet beyin, tek aile uyarısı', () => {
    const r = recommend(['claude-pro']);
    expect(r.brain).toMatch(/^Sonnet/);
    expect(r.routing.implementation).toEqual(['cirak']);
    expect(r.warnings.join()).toMatch(/Tek model ailesi/);
  });

  it('yerel model uygulamaya konmaz; gri alan ve bilinmeyen abonelik uyarılır', () => {
    const r = recommend(['claude-max', 'local-gpu', 'antigravity', 'yok-boyle']);
    expect(r.routing.implementation).not.toContain('local');
    expect(r.routing.review).not.toContain('local');
    expect(r.routing.test).toContain('local');
    const w = r.warnings.join('\n');
    expect(w).toMatch(/Bilinmeyen abonelik: yok-boyle/);
    expect(w).toMatch(/Antigravity.*gri/);
  });

  it('Claude yoksa beyin uyarısı', () => {
    expect(recommend(['chatgpt-pro']).warnings.join()).toMatch(/Beyin için Claude/);
  });

  it('recommend --apply config yazar; capacity ayarları birleşir', () => {
    const t = tempDir();
    try {
      writeFileSync(
        join(t.dir, 'anafor.config.json'),
        JSON.stringify({ test_command: 'npm test', capacity: { reserve_weekly: 25 } }),
      );
      const out = runRecommend(t.dir, ['claude-max', 'chatgpt-plus', 'bilinmez'], true);
      expect(out.join('\n')).toMatch(/güncellendi/);
      const cfg = JSON.parse(readFileSync(join(t.dir, 'anafor.config.json'), 'utf8'));
      expect(cfg.test_command).toBe('npm test');
      expect(cfg.subscriptions).toEqual(['claude-max', 'chatgpt-plus']);
      expect(cfg.routing.implementation[0]).toBe('codex');
      const loaded = loadConfig(t.dir);
      expect(loaded.capacity).toEqual({ ...DEFAULT_CAPACITY, reserve_weekly: 25 });
      expect(runRecommend(t.dir, [], false)[0]).toMatch(/kullanım/);
    } finally {
      t.cleanup();
    }
  });
});
