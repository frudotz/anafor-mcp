import { describe, expect, it } from 'vitest';
import { brainLimitDecision } from '../../src/loop/decision.js';

const cfg = { warn_at: 75, pause_at: 90, pause_at_weekly: 95 };
const limits = (
  windows: {
    name: string;
    used_percent: number;
    resets_at: number | null;
    window_minutes: number | null;
  }[],
) => ({ worker: 'claude', source: 'test', observed_at: '', status: 'ok' as const, windows });

describe('brainLimitDecision', () => {
  it('warns at the configured threshold and pauses at 5h threshold', () => {
    expect(
      brainLimitDecision(
        limits([{ name: 'five_hour', used_percent: 75, resets_at: 200, window_minutes: 300 }]),
        cfg,
        100_000,
      ).action,
    ).toBe('warn');
    expect(
      brainLimitDecision(
        limits([{ name: 'five_hour', used_percent: 90, resets_at: 200, window_minutes: 300 }]),
        cfg,
        100_000,
      ),
    ).toMatchObject({ action: 'pause', resume_at: new Date(260_000).toISOString() });
  });
  it('uses weekly threshold and ignores expired windows', () => {
    expect(
      brainLimitDecision(
        limits([{ name: 'seven_day', used_percent: 95, resets_at: 200, window_minutes: 10080 }]),
        cfg,
        100_000,
      ).action,
    ).toBe('pause');
    expect(
      brainLimitDecision(
        limits([{ name: 'five_hour', used_percent: 100, resets_at: 99, window_minutes: 300 }]),
        cfg,
        100_000,
      ).action,
    ).toBe('continue');
  });
  it('ignores null-reset windows from observations older than six hours', () => {
    const stale = {
      ...limits([{ name: 'five_hour', used_percent: 100, resets_at: null, window_minutes: 300 }]),
      observed_at: new Date(0).toISOString(),
    };
    expect(brainLimitDecision(stale, cfg, 7 * 60 * 60_000).action).toBe('continue');
  });
});
