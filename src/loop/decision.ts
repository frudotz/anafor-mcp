import type { WorkerLimits } from '../limits/limits.js';

export interface BrainLimitConfig {
  warn_at: number;
  pause_at: number;
  pause_at_weekly: number;
}
export interface BrainLimitDecision {
  action: 'continue' | 'warn' | 'pause';
  window: string | null;
  resume_at: string | null;
}

/** Deterministic limit policy. A known reset is used as a safe resume time. */
export function brainLimitDecision(
  limits: WorkerLimits | null,
  cfg: BrainLimitConfig,
  now = Date.now(),
): BrainLimitDecision {
  if (!limits) return { action: 'continue', window: null, resume_at: null };
  const observed = Date.parse(limits.observed_at);
  const staleNullReset = !Number.isFinite(observed) || now - observed > 6 * 60 * 60_000;
  const windows = limits.windows.filter(
    (w) =>
      !(w.resets_at === null && staleNullReset) &&
      (w.resets_at === null || w.resets_at * 1000 > now),
  );
  const ordered = windows.map((w) => ({ w, weekly: w.name.startsWith('seven_day') }));
  const pause = ordered.find(
    ({ w, weekly }) => w.used_percent >= (weekly ? cfg.pause_at_weekly : cfg.pause_at),
  );
  if (pause)
    return {
      action: 'pause',
      window: pause.w.name,
      resume_at:
        pause.w.resets_at === null
          ? null
          : new Date(pause.w.resets_at * 1000 + 60_000).toISOString(),
    };
  const warn = ordered.find(({ w }) => w.used_percent >= cfg.warn_at);
  if (warn) return { action: 'warn', window: warn.w.name, resume_at: null };
  return { action: 'continue', window: null, resume_at: null };
}
