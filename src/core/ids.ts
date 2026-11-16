import { randomBytes } from 'node:crypto';

/** Kısa, sıralanabilir, dosya adı ve git dalı için güvenli kimlik: `T-mi3k2a-7f3c`. */
export function newId(prefix: 'T' | 'J' | 'G' | 'E'): string {
  const time = Date.now().toString(36);
  const rand = randomBytes(2).toString('hex');
  return `${prefix}-${time}-${rand}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
