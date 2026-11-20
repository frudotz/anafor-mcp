import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseClaudeLine } from '../../src/adapters/cirak.js';
import {
  formatWindows,
  parseClaudeRateLimitInfo,
  parseClaudeStatusline,
  readCodexLimits,
  readCodexLimitsLive,
  refreshCodexLimits,
  readStoredLimits,
  recordLimits,
  statusFrom,
  rateLimitedUntil,
  recordRateLimitedUntil,
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
  it('rate limit cache is separate and expires at its deadline', () => {
    const t = tempDir();
    try {
      const env = { ...process.env, ANAFOR_HOME: t.dir };
      recordRateLimitedUntil('codex', 200, env);
      recordRateLimitedUntil('codex', 300, env);
      recordRateLimitedUntil('claude', 250, env);
      expect(rateLimitedUntil('codex', env, 100_000)).toBe(300);
      expect(rateLimitedUntil('claude', env, 100_000)).toBe(250);
      expect(rateLimitedUntil('codex', env, 100_000)).toBe(300);
      expect(rateLimitedUntil('codex', env, 301_000)).toBeNull();
      expect(readStoredLimits(env)).toEqual({});
    } finally {
      t.cleanup();
    }
  });
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

  it('Codex app-server JSON-RPC dönüşümü kimliksiz önbellek kaydı', async () => {
    const t = tempDir();
    try {
      const script = join(t.dir, 'server.cjs');
      writeFileSync(
        script,
        [
          "const rl = require('node:readline').createInterface({ input: process.stdin });",
          'const limits = {',
          "  rateLimitReachedType: 'hard_limit',",
          '  primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: 1795048405 },',
          '  secondary: { usedPercent: 38, windowDurationMins: 10080, resetsAt: 1795279781 },',
          '};',
          "const result = { ordinaryUsageAllowed: false, accountId: 'secret', rateLimits: limits };",
          "rl.on('line', (l) => {",
          '  const m = JSON.parse(l);',
          '  if (m.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));',
          '  if (m.id === 2) console.log(JSON.stringify({ id: 2, result }));',
          '});',
        ].join('\n'),
      );
      const value = await readCodexLimitsLive({}, process.execPath, 2000, [script]);
      expect(value?.source).toBe('codex app-server');
      expect(value?.status).toBe('limited');
      expect(value?.windows.map((w) => [w.name, w.window_minutes, w.resets_at])).toEqual([
        ['five_hour', 300, 1795048405],
        ['seven_day', 10080, 1795279781],
      ]);
      recordLimits(value!, { ANAFOR_HOME: t.dir });
      expect(JSON.stringify(readStoredLimits({ ANAFOR_HOME: t.dir }))).not.toContain('secret');
    } finally {
      t.cleanup();
    }
  });

  it('app-server timeout, hata yanıtı ve erken çıkışta null döner', async () => {
    const t = tempDir();
    try {
      const make = (body: string) => {
        const script = join(t.dir, `server-${Math.random()}.cjs`);
        writeFileSync(script, body);
        return script;
      };
      const timeoutServer = make(`process.stdin.resume();`);
      expect(await readCodexLimitsLive({}, process.execPath, 30, [timeoutServer])).toBeNull();
      const errorServer = make(
        [
          "const r = require('node:readline').createInterface({ input: process.stdin });",
          "r.on('line', (l) => {",
          '  const m = JSON.parse(l);',
          '  if (m.id === 1) console.log(JSON.stringify({ id: 1, result: {} }));',
          "  if (m.id === 2) console.log(JSON.stringify({ id: 2, error: { code: -1, message: 'failure' } }));",
          '});',
        ].join('\n'),
      );
      expect(await readCodexLimitsLive({}, process.execPath, 1000, [errorServer])).toBeNull();
      const exitServer = make(`process.exit(0);`);
      expect(await readCodexLimitsLive({}, process.execPath, 1000, [exitServer])).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('eski rollout yedeği daha yeni önbelleği ezmez', async () => {
    const t = tempDir();
    try {
      const env = { ANAFOR_HOME: join(t.dir, 'anafor'), CODEX_HOME: join(t.dir, 'codex') };
      const day = join(env.CODEX_HOME, 'sessions', '2026', '11', '17');
      mkdirSync(day, { recursive: true });
      writeFileSync(
        join(day, 'rollout-old.jsonl'),
        JSON.stringify({
          timestamp: '2026-11-17T10:00:00Z',
          payload: { rate_limits: { primary: { used_percent: 40, window_minutes: 300 } } },
        }),
      );
      const fresh = {
        worker: 'codex',
        source: 'existing',
        observed_at: '2026-11-18T10:00:00Z',
        status: 'ok' as const,
        windows: [{ name: 'five_hour', used_percent: 10, resets_at: null, window_minutes: 300 }],
      };
      recordLimits(fresh, env);
      const result = await refreshCodexLimits(env, '__missing_codex_binary__', 50);
      expect(result?.source).toBe('existing');
      expect(readStoredLimits(env).codex?.source).toBe('existing');
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
