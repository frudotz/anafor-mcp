import * as p from '@clack/prompts';
import { styleText } from 'node:util';
import { m } from '../i18n/index.js';

/**
 * Terminal arayüzü (F28): @clack/prompts (adım çizgisi, kutu, spinner, onay) + Node'un yerleşik
 * `util.styleText` renkleri. Etkileşimsiz ortamda (CI, boru, --yes) sorular varsayılanı kullanır.
 */
type Style = Parameters<typeof styleText>[0];
export const c = (style: Style, text: string, force = false) =>
  styleText(style, text, force ? { validateStream: false } : undefined);

export const mark = {
  ok: () => c('green', '✔'),
  fail: () => c('red', '✘'),
  warn: () => c('yellow', '▲'),
  off: () => c('gray', '○'),
};

export const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY && !p.isCI();

/** Evet/hayır sorusu; etkileşimsizse varsayılan. İptal (Ctrl+C) → çıkış 130. */
export async function ask(message: string, def = true, yes = false): Promise<boolean> {
  if (yes || !interactive()) return def;
  const a = await p.confirm({
    message,
    initialValue: def,
    active: m().ui.yes,
    inactive: m().ui.no,
  });
  if (p.isCancel(a)) {
    p.cancel(m().ui.cancelled);
    process.exit(130);
  }
  return a;
}

/** Kelime sınırından sarar; devam satırları `indent` kadar girintili. */
export function wrap(text: string, width: number, indent: string): string {
  const out: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if (line && line.length + 1 + w.length > width) {
      out.push(line);
      line = w;
    } else line = line ? `${line} ${w}` : w;
  }
  if (line) out.push(line);
  return out.join(`\n${indent}`);
}

const boxWidth = () => Math.max(40, Math.min(process.stdout.columns || 80, 100) - 12);

/** Hizalı satırlar: [işaret, ad, açıklama, ipucu?]. İpucu girintili ve sarılmış. */
export function rows(items: [string, string, string, string?][], pad = 12): string {
  return items
    .map(
      ([m, name, info, hint]) =>
        `${m} ${name.padEnd(pad)} ${info}${hint ? `\n    ${c('gray', `↳ ${wrap(hint, boxWidth() - 6, '      ')}`)}` : ''}`,
    )
    .join('\n');
}

export async function withSpinner<T>(message: string, fn: () => Promise<T> | T): Promise<T> {
  if (!interactive()) return fn();
  const s = p.spinner();
  s.start(message);
  try {
    const r = await fn();
    s.stop(message);
    return r;
  } catch (e) {
    s.error(`${message}: ${(e as Error).message}`);
    throw e;
  }
}

export { p };
