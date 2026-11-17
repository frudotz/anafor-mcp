import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { isWindowsShim, quoteCmdArg } from '../adapters/process.js';

/**
 * Lat.md proje hafızasından işe ilgili bölümleri seçer (F17).
 * Önce resmi `lat search` (çevrimdışı hibrit arama); yoksa veya başarısızsa yerleşik
 * anahtar kelime araması. Sonuç boyutu sınırlıdır; hafıza yalnızca okunur.
 */
export interface MemoryContext {
  method: 'lat-cli' | 'builtin';
  text: string;
  sections: number;
}

export interface MemoryContextOptions {
  limit?: number;
  maxChars?: number;
  latBin?: string;
  /** false: lat CLI denenmez (test). */
  useLat?: boolean;
  timeoutMs?: number;
}

const truncate = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, max).trimEnd()}\n… (kısaltıldı)`;

/** `lat search` çıktısından gezinme ipuçlarını atar; sonuç yoksa null. */
export function cleanLatOutput(out: string): { text: string; sections: number } | null {
  const body = out.split(/^## To navigate further/m)[0]!.trim();
  const sections = (body.match(/^\* Section:/gm) ?? []).length;
  if (!sections) return null;
  return { text: body.replace(/^## Search results for .*\n+/m, '').trim(), sections };
}

interface Section {
  file: string;
  heading: string;
  start: number;
  body: string;
}

function walkMd(dir: string, out: string[] = []): string[] {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walkMd(p, out);
    else if (n.endsWith('.md')) out.push(p);
  }
  return out;
}

export function splitSections(file: string, text: string): Section[] {
  const lines = text.split(/\r?\n/);
  const out: Section[] = [];
  let cur: Section | null = null;
  lines.forEach((line, i) => {
    const h = /^#{1,6}\s+(.*)$/.exec(line);
    if (h) {
      if (cur) out.push(cur);
      cur = { file, heading: h[1]!.trim(), start: i + 1, body: '' };
    } else if (cur) cur.body += `${line}\n`;
  });
  if (cur) out.push(cur);
  return out.filter((s) => s.body.trim());
}

const tokens = (s: string) => [
  ...new Set(s.toLocaleLowerCase('tr').match(/[\p{L}\p{N}_]{3,}/gu) ?? []),
];

/** Yerleşik yedek: başlık eşleşmesi 3, gövde eşleşmesi 1 puan. */
export function builtinSearch(
  root: string,
  query: string,
  limit: number,
): { text: string; sections: number } | null {
  const q = tokens(query);
  if (!q.length) return null;
  const scored = walkMd(join(root, 'lat.md'))
    .flatMap((f) => splitSections(relative(root, f).replace(/\\/g, '/'), readFileSync(f, 'utf8')))
    .map((s) => {
      const h = s.heading.toLocaleLowerCase('tr');
      const b = s.body.toLocaleLowerCase('tr');
      const score = q.reduce((n, t) => n + (h.includes(t) ? 3 : 0) + (b.includes(t) ? 1 : 0), 0);
      return { s, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (!scored.length) return null;
  return {
    sections: scored.length,
    text: scored
      .map(
        ({ s }) =>
          `* Section: ${s.file}#${s.heading} (satır ${s.start})\n\n${truncate(s.body.trim(), 600)
            .split('\n')
            .map((l) => `  > ${l}`)
            .join('\n')}`,
      )
      .join('\n\n'),
  };
}

export function sanitizeQuery(query: string): string {
  return query
    .replace(/[^\p{L}\p{N}\s._-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

export function memoryContext(
  root: string,
  query: string,
  opts: MemoryContextOptions = {},
): MemoryContext | null {
  if (!existsSync(join(root, 'lat.md'))) return null;
  const limit = opts.limit ?? 4;
  const maxChars = opts.maxChars ?? 4000;
  // Arama sorgusu: yalnızca harf, rakam, boşluk ve ._- (kabukta özel anlamı olan karakter kalmaz).
  const q = sanitizeQuery(query);
  if (!q) return null;
  if (opts.useLat !== false) {
    const bin = opts.latBin ?? 'lat';
    const shim = isWindowsShim(bin); // npm ile kurulan lat Windows'ta .cmd sarmalayıcısıdır
    const args = ['search', '--limit', String(limit), '--', q];
    const r = spawnSync(bin, shim ? args.map(quoteCmdArg) : args, {
      cwd: root,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 30_000,
      windowsHide: true,
      shell: shim,
    });
    if (!r.error && r.status === 0) {
      const c = cleanLatOutput(r.stdout ?? '');
      if (c) return { method: 'lat-cli', text: truncate(c.text, maxChars), sections: c.sections };
    }
  }
  const b = builtinSearch(root, q, limit);
  return b ? { method: 'builtin', text: truncate(b.text, maxChars), sections: b.sections } : null;
}
