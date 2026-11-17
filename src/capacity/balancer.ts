import type { AccountCapacity } from './capacity.js';
import { m } from '../i18n/index.js';

/**
 * Yük dengeleyici (F21): rolün tercih zincirini abonelik kapasitesine göre yeniden sıralar.
 * Zincirdeki sıra kalite tercihidir; dengeleyici yalnızca kısıtlı hesapları geri iter.
 *  - balanced:      rezerve ulaşmış / maliyeti sığmayan hesaplar sona, hızlı tükenenler ortaya
 *  - protect-brain: balanced + eşit grupta beynin (Claude) hesabını kullanan işçiler geriye
 *  - cheap-first:   balanced + grup içinde ucuz kademe önce
 *  - off:           zincir olduğu gibi (yalnızca tamamen dolu limitler atlanır)
 */
export type BalancerStrategy = 'off' | 'balanced' | 'protect-brain' | 'cheap-first';

export interface BalancerConfig {
  strategy: BalancerStrategy;
}

export const DEFAULT_BALANCER: BalancerConfig = { strategy: 'balanced' };

export interface Candidate {
  worker: string;
  account: string;
  costTier: 'low' | 'medium' | 'high';
}

const TIER_RANK = { low: 0, medium: 1, high: 2 } as const;

/** Hesabın grup puanı: 0 sağlıklı veya bilinmiyor, 1 hızlı tükeniyor, 2 kısıtlı. */
function group(a: AccountCapacity | undefined, role: string, paceThreshold: number) {
  if (!a || !a.observed) return { g: 0, why: '' };
  const full = a.windows.find((w) => w.free <= 0);
  if (full) return { g: 2, why: m().balancer.reserve(full.name, full.used) };
  const r = a.roles[role];
  if (r && r.jobs_left !== null && r.jobs_left < 1)
    return { g: 2, why: m().balancer.noFit(r.kp_p80) };
  const fast = a.windows.find((w) => w.pace !== null && w.pace > paceThreshold);
  if (fast) return { g: 1, why: m().balancer.fast(fast.name, fast.pace!) };
  return { g: 0, why: '' };
}

export function balance(
  role: string,
  chain: Candidate[],
  accounts: AccountCapacity[],
  strategy: BalancerStrategy,
  paceThreshold: number,
): { order: string[]; notes: string[] } {
  if (strategy === 'off' || chain.length < 2)
    return { order: chain.map((c) => c.worker), notes: [] };
  const byAcc = new Map(accounts.map((a) => [a.account, a]));
  const scored = chain.map((c, index) => {
    const { g, why } = group(byAcc.get(c.account), role, paceThreshold);
    const brain = strategy === 'protect-brain' && c.account === 'claude' ? 1 : 0;
    const cost = strategy === 'cheap-first' ? TIER_RANK[c.costTier] : 0;
    return { c, index, g, why, brain, cost };
  });
  const sorted = [...scored].sort(
    (a, b) => a.g - b.g || a.brain - b.brain || a.cost - b.cost || a.index - b.index,
  );
  const notes: string[] = [];
  const firstBefore = chain[0]!.worker;
  const firstAfter = sorted[0]!.c.worker;
  if (firstAfter !== firstBefore) {
    const was = scored[0]!;
    const why = was.why
      ? `${was.c.account}: ${was.why}`
      : was.brain
        ? m().balancer.protectBrain
        : was.cost > sorted[0]!.cost
          ? m().balancer.cheaper
          : '';
    notes.push(m().balancer.note(strategy, firstBefore, firstAfter) + (why ? ` — ${why}` : ''));
  }
  return { order: sorted.map((s) => s.c.worker), notes };
}
