import { describe, expect, it } from 'vitest';
import { balance, type Candidate } from '../../src/capacity/balancer.js';
import type { AccountCapacity } from '../../src/capacity/capacity.js';

const acc = (
  account: string,
  windows: { name: string; used: number; free: number; pace: number | null }[],
  roles: AccountCapacity['roles'] = {},
): AccountCapacity => ({
  account,
  workers: [],
  observed: true,
  observed_at: 'x',
  windows: windows.map((w) => ({ ...w, reserve: 10, resets_at: null, eta_full_s: null })),
  roles,
  healthy: true,
});
const chain: Candidate[] = [
  { worker: 'cirak', account: 'claude', costTier: 'medium' },
  { worker: 'codex', account: 'codex', costTier: 'high' },
  { worker: 'opencode', account: 'opencode', costTier: 'low' },
];

describe('yük dengeleyici', () => {
  it('off ve tek aday: zincir aynen', () => {
    expect(balance('implementation', chain, [], 'off', 1.2).order).toEqual([
      'cirak',
      'codex',
      'opencode',
    ]);
    expect(balance('implementation', chain.slice(0, 1), [], 'balanced', 1.2).notes).toEqual([]);
  });

  it('balanced: kısıtlı sona, hızlı tükenen ortaya, bilinmeyen nötr', () => {
    const r = balance(
      'implementation',
      chain,
      [
        acc('claude', [{ name: 'five_hour', used: 92, free: 0, pace: 2 }]),
        acc('codex', [{ name: 'seven_day', used: 50, free: 35, pace: 1.5 }]),
      ],
      'balanced',
      1.2,
    );
    expect(r.order).toEqual(['opencode', 'codex', 'cirak']);
    expect(r.notes[0]).toMatch(/cirak yerine opencode — claude: five_hour rezerve ulaştı/);
  });

  it('maliyeti sığmayan rol kısıtlı sayılır', () => {
    const r = balance(
      'review',
      chain.slice(0, 2),
      [
        acc('claude', [{ name: 'five_hour', used: 85, free: 5, pace: 1 }], {
          review: { kp_p80: 8, samples: 4, jobs_left: 0 },
        }),
      ],
      'balanced',
      1.2,
    );
    expect(r.order[0]).toBe('codex');
    expect(r.notes[0]).toMatch(/sığmıyor/);
  });

  it('protect-brain ve cheap-first eşit grupta sıralar', () => {
    expect(balance('implementation', chain, [], 'protect-brain', 1.2)).toMatchObject({
      order: ['codex', 'opencode', 'cirak'],
      notes: [expect.stringMatching(/beynin hesabı korunuyor/)],
    });
    expect(balance('implementation', chain, [], 'cheap-first', 1.2)).toMatchObject({
      order: ['opencode', 'cirak', 'codex'],
      notes: [expect.stringMatching(/daha ucuz kademe/)],
    });
  });
});
