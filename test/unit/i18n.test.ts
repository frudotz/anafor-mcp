import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { en } from '../../src/i18n/en.js';
import { parseLang, resolveLang, setLang } from '../../src/i18n/index.js';
import { tr } from '../../src/i18n/tr.js';
import { formatWindows } from '../../src/limits/limits.js';
import { tempDir } from '../helpers.js';

/** Katalogların anahtar ağacı ve fonksiyon/metin türleri birebir aynı olmalı. */
function shape(o: unknown): unknown {
  if (typeof o === 'function') return `fn${o.length}`;
  if (o && typeof o === 'object')
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, shape(v)]));
  return typeof o;
}

describe('dil desteği (F24)', () => {
  it('tr ve en kataloglarının yapısı aynı', () => {
    expect(shape(en)).toEqual(shape(tr));
  });

  it('dil önceliği: ANAFOR_LANG → kurulum seçimi → sistem', () => {
    const t = tempDir();
    try {
      expect(resolveLang({ ANAFOR_LANG: 'en_US.UTF-8', ANAFOR_HOME: t.dir })).toBe('en');
      expect(resolveLang({ ANAFOR_LANG: 'tr', ANAFOR_HOME: t.dir })).toBe('tr');
      mkdirSync(t.dir, { recursive: true });
      writeFileSync(join(t.dir, 'setup.json'), JSON.stringify({ language: 'en' }));
      expect(resolveLang({ ANAFOR_HOME: t.dir })).toBe('en');
      expect(resolveLang({ ANAFOR_HOME: t.dir, ANAFOR_LANG: 'tr' })).toBe('tr');
      expect(parseLang('de')).toBeNull();
    } finally {
      t.cleanup();
    }
  });

  it('limit penceresi etiketleri dile göre', () => {
    const w = [{ name: 'five_hour', used_percent: 24, resets_at: 1, window_minutes: 300 }];
    try {
      setLang('en');
      expect(formatWindows(w, 10_000)).toBe('5h reset');
      setLang('tr');
      expect(formatWindows(w, 10_000)).toBe('5s sıfırlandı');
    } finally {
      setLang('tr');
    }
  });
});
