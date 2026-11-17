import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  builtinSearch,
  cleanLatOutput,
  memoryContext,
  sanitizeQuery,
  splitSections,
} from '../../src/core/memory-context.js';
import { tempDir } from '../helpers.js';

// lat 0.13.8 `lat search` gerçek çıktı biçimi (NetCheck hafızası, 2026-11-17).
const LAT_OUT = `
## Search results for "ping zaman aşımı":

* Section: [[lat.md/networking#Networking#Ping backends]] (hybrid match)
  Defined in lat.md\networking.md:33-45
  Matched lines: 39-44

  > | Windows | \`icmp-api\` | iphlpapi \`IcmpSendEcho\`; no administrator rights |

* Section: [[lat.md/tests#Tests#ICMP]] (hybrid match)
  Defined in lat.md\tests.md:49-52

  > Tests for the ping backends.

## To navigate further:

* \`lat section "section#id"\` — show full content with outgoing/incoming refs
`;

describe('Lat.md hafıza bağlamı (F17)', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
    mkdirSync(join(t.dir, 'lat.md'));
    writeFileSync(
      join(t.dir, 'lat.md', 'networking.md'),
      '# Networking\n\nGenel.\n\n## Ping backends\n\nWindows icmp-api kullanır; zaman aşımı 2 sn.\n\n## DNS\n\nÇözümleyici.\n',
    );
    writeFileSync(join(t.dir, 'lat.md', 'tests.md'), '# Tests\n\n## ICMP\n\nPing testleri.\n');
  });
  afterEach(() => t.cleanup());

  it('lat çıktısı: başlık ve gezinme ipuçları atılır, bölüm sayılır', () => {
    const c = cleanLatOutput(LAT_OUT)!;
    expect(c.sections).toBe(2);
    expect(c.text.startsWith('* Section: [[lat.md/networking#Networking#Ping backends]]')).toBe(
      true,
    );
    expect(c.text).not.toMatch(/To navigate further|Search results/);
    expect(cleanLatOutput('## Search results for "x":\n\nNo results.\n')).toBeNull();
  });

  it('bölümlere ayırma satır numarasıyla', () => {
    const s = splitSections('lat.md/n.md', '# A\n\nx\n## B\ny\n');
    expect(s.map((x) => [x.heading, x.start])).toEqual([
      ['A', 1],
      ['B', 4],
    ]);
  });

  it('yerleşik arama: başlık eşleşmesi öne çıkar', () => {
    const r = builtinSearch(t.dir, 'ping zaman aşımı', 3)!;
    expect(r.text.split('\n')[0]).toBe('* Section: lat.md/networking.md#Ping backends (satır 5)');
    expect(r.text).toMatch(/zaman aşımı 2 sn/);
  });

  it('sorgu kabuk karakterlerinden arındırılır', () => {
    expect(sanitizeQuery('a & b | c; "d" %PATH% `e` $(f) -x\nyeni')).toBe(
      'a b c d PATH e f -x yeni',
    );
  });

  it('lat yoksa yerleşik aramaya düşer; lat.md yoksa null', () => {
    const r = memoryContext(t.dir, 'ICMP ping', { latBin: 'lat-olmayan-ikili-xyz' })!;
    expect(r.method).toBe('builtin');
    expect(r.sections).toBeGreaterThan(0);
    const t2 = tempDir();
    expect(memoryContext(t2.dir, 'ping')).toBeNull();
    t2.cleanup();
  });

  it('boyut sınırı uygulanır', () => {
    const r = memoryContext(t.dir, 'ping icmp windows', { useLat: false, maxChars: 40 })!;
    expect(r.text.length).toBeLessThanOrEqual(40 + 20);
    expect(r.text).toMatch(/kısaltıldı/);
  });
});

describe('Windows shim algılama', () => {
  it('uzantısız npm betiği atlanır, .cmd seçilir; .exe shim değildir', async () => {
    const { shimFromWhere } = await import('../../src/adapters/process.js');
    const where = (...files: string[]) => files.join('\r\n') + '\r\n';
    expect(
      shimFromWhere(where('C:/Users/u/AppData/Roaming/npm/lat', 'C:/Users/u/npm/lat.cmd')),
    ).toBe(true);
    expect(shimFromWhere(where('C:/bin/codex.exe', 'C:/npm/codex.cmd'))).toBe(false);
    expect(shimFromWhere('')).toBe(false);
  });
});
