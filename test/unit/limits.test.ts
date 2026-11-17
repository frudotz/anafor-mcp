import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeLine } from '../../src/adapters/claude-lite.js';
import {
  formatWindows,
  parseClaudeRateLimitInfo,
  parseClaudeStatusline,
  readCodexLimits,
  readStoredLimits,
  recordLimits,
  statusFrom,
} from '../../src/limits/limits.js';
import { tempDir } from '../helpers.js';

// claude 2.1.325'te kaydedilen gerçek olay.
const CLAUDE_EVENT = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'allowed_warning',
    resetsAt: 1795399200,
    rateLimitType: 'seven_day',
    utilization: 0.26,
    unifiedWindows: {
      five_hour: { utilization: 0.44, resetsAt: 1794869400, status: 'allowed' },
      seven_day: { utilization: 0.26, resetsAt: 1795399200, status: 'allowed' },
    },
  },
};

describe('limitler', () => {
  it('Claude rate_limit_event → iki pencere', () => {
    const w = parseClaudeRateLimitInfo(CLAUDE_EVENT.rate_limit_info);
    expect(w).toEqual([
      { name: 'five_hour', used_percent: 44, resets_at: 1794869400, window_minutes: 300 },
      { name: 'seven_day', used_percent: 26, resets_at: 1795399200, window_minutes: 10080 },
    ]);
    expect(parseClaudeLine(JSON.stringify(CLAUDE_EVENT))[0]?.type).toBe('limits');
  });

  it('Claude statusline girdisi', () => {
    const w = parseClaudeStatusline({
      rate_limits: {
        five_hour: { used_percentage: 12.5, resets_at: 1 },
        seven_day: { used_percentage: 3 },
      },
    });
    expect(w.map((x) => x.used_percent)).toEqual([12.5, 3]);
    expect(parseClaudeStatusline({})).toEqual([]);
  });

  it('Codex rollout dosyasından son token_count limitleri', () => {
    const t = tempDir();
    try {
      const day = join(t.dir, 'sessions', '2026', '11', '17');
      mkdirSync(day, { recursive: true });
      const ev = (p: number, s: number) =>
        JSON.stringify({
          timestamp: '2026-11-17T10:00:00Z',
          type: 'event_msg',
          payload: {
            type: 'token_count',
            rate_limits: {
              primary: { used_percent: p, window_minutes: 300, resets_at: 1 },
              secondary: { used_percent: s, window_minutes: 10080, resets_at: 2 },
            },
          },
        });
      writeFileSync(
        join(day, 'rollout-a.jsonl'),
        [ev(5, 30), '{"type":"x"}', ev(10, 38)].join('\n'),
      );
      const l = readCodexLimits({ CODEX_HOME: t.dir });
      expect(l?.windows.map((w) => [w.name, w.used_percent])).toEqual([
        ['five_hour', 10],
        ['seven_day', 38],
      ]);
      expect(readCodexLimits({ CODEX_HOME: join(t.dir, 'yok') })).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('kayıt, durum ve biçim', () => {
    const t = tempDir();
    try {
      const env = { ANAFOR_HOME: t.dir };
      const windows = [
        { name: 'five_hour', used_percent: 85, resets_at: null, window_minutes: 300 },
      ];
      recordLimits(
        { worker: 'claude', source: 't', observed_at: 'x', status: statusFrom(windows), windows },
        env,
      );
      expect(readStoredLimits(env).claude?.status).toBe('warning');
      expect(statusFrom([{ ...windows[0]!, used_percent: 100 }])).toBe('limited');
      expect(formatWindows(windows)).toBe('5s %85');
    } finally {
      t.cleanup();
    }
  });
});

describe('bayat limit gözlemi', () => {
  it('sıfırlanma zamanı geçmiş pencere "sıfırlandı" gösterilir', () => {
    const now = Date.UTC(2026, 10, 17, 12);
    const past = now / 1000 - 60;
    const future = now / 1000 + 3600;
    expect(
      formatWindows(
        [
          { name: 'five_hour', used_percent: 90, resets_at: past, window_minutes: 300 },
          { name: 'seven_day', used_percent: 38, resets_at: future, window_minutes: 10080 },
        ],
        now,
      ),
    ).toMatch(/^5s sıfırlandı · 7g %38 \(/);
  });
});
