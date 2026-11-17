import type { Effort } from '../adapters/types.js';
import type { Role } from '../contracts/worker-result.js';

/**
 * Token profili (F22): rol başına akıl yürütme düzeyi. Effort, düşünme dahil tüm çıktı
 * token'larını ve araç çağrısı sayısını etkiler; tasarruf mekanik rollerden yapılır,
 * inceleme kalitesinden ödün verilmez.
 */
export type TokenProfile = 'saver' | 'balanced' | 'quality' | 'off';

export const TOKEN_PROFILES: Record<Exclude<TokenProfile, 'off'>, Record<Role, Effort>> = {
  saver: { implementation: 'medium', review: 'medium', analysis: 'low', test: 'low' },
  balanced: { implementation: 'medium', review: 'high', analysis: 'medium', test: 'low' },
  quality: { implementation: 'high', review: 'high', analysis: 'high', test: 'medium' },
};

export type EffortSetting = Effort | Partial<Record<Role, Effort>>;

/** İşçi ayarı (workers.<id>.effort) profili ezer; `off` ise işçinin kendi varsayılanı kullanılır. */
export function resolveEffort(
  profile: TokenProfile,
  role: Role,
  workerSetting?: EffortSetting,
): Effort | undefined {
  if (typeof workerSetting === 'string') return workerSetting;
  if (workerSetting?.[role]) return workerSetting[role];
  return profile === 'off' ? undefined : TOKEN_PROFILES[profile][role];
}
