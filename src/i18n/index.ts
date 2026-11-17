import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { en } from './en.js';
import { tr, type Messages } from './tr.js';

/**
 * Dil desteği (F24). Öncelik: ANAFOR_LANG → kurulumda seçilen dil (~/.anafor/setup.json) →
 * sistem dili (tr* ise Türkçe, değilse İngilizce).
 */
export type Lang = 'tr' | 'en';
export const LANGS: Record<Lang, Messages> = { tr, en };

const norm = (v: string | undefined | null): Lang | null =>
  v
    ? v.toLowerCase().startsWith('tr')
      ? 'tr'
      : v.toLowerCase().startsWith('en')
        ? 'en'
        : null
    : null;

export function systemLang(): Lang {
  try {
    return norm(Intl.DateTimeFormat().resolvedOptions().locale) ?? 'en';
  } catch {
    return 'en';
  }
}

export function resolveLang(env: NodeJS.ProcessEnv = process.env): Lang {
  const fromEnv = norm(env.ANAFOR_LANG);
  if (fromEnv) return fromEnv;
  try {
    const home = env.ANAFOR_HOME ?? join(homedir(), '.anafor');
    const s = JSON.parse(readFileSync(join(home, 'setup.json'), 'utf8')) as { language?: string };
    const fromSetup = norm(s.language);
    if (fromSetup) return fromSetup;
  } catch {
    // kurulum yapılmamış
  }
  return systemLang();
}

let cached: Lang | null = null;
/** Geçerli dil (süreç başına bir kez çözülür). */
export function lang(): Lang {
  return (cached ??= resolveLang());
}
export function setLang(l: Lang): void {
  cached = l;
}
/** Geçerli dilin mesaj kataloğu. */
export const m = (): Messages => LANGS[lang()];
export const parseLang = norm;
