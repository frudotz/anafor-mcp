import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, findAnaforRoot } from '../../src/core/config.js';
import { classifyShell, decide, runPreToolUse } from '../../src/hooks/director.js';
import { activeGrants, createGrant, endGrant } from '../../src/hooks/grants.js';
import { tempDir } from '../helpers.js';

describe('classifyShell', () => {
  const mutating = [
    'echo hi > a.txt',
    'cat x >> log.md',
    'rm -rf src',
    'mv a b',
    'cp a b',
    'mkdir x',
    "sed -i 's/a/b/' f.ts",
    'git apply p.patch',
    'git checkout -- src/a.ts',
    'git restore src/a.ts',
    'Set-Content a.txt "x"',
    'New-Item -ItemType File x',
    "node -e \"require('fs').writeFileSync('a','b')\"",
    "python -c \"open('a','w').write('x')\"",
  ];
  const safe = [
    'git status',
    'git diff --stat',
    'git log --oneline -5',
    'npm test',
    'npm run build 2>&1',
    'npx vitest run > /dev/null',
    'ls -la',
    'cat src/a.ts',
    'grep -rn foo src',
    'node -e "[1,2].map(x=>x*2)"',
    'Get-ChildItem',
    'git commit -m "x"',
    'gh pr merge 3 --squash --auto',
    'echo $((2>1))',
  ];
  it.each(mutating)('değiştirici: %s', (c) => expect(classifyShell(c)).not.toBeNull());
  it.each(safe)('güvenli: %s', (c) => expect(classifyShell(c)).toBeNull());
});

describe('decide', () => {
  const root = process.platform === 'win32' ? 'C:\\proj' : '/proj';
  const ctx = { root, config: DEFAULT_CONFIG, grants: [] };
  const edit = (file_path: string) => ({ cwd: root, tool_name: 'Edit', tool_input: { file_path } });

  it('kod dosyası düzenleme engellenir', () => {
    const d = decide(edit(join(root, 'src', 'a.ts')), ctx);
    expect(d.action).toBe('deny');
    if (d.action === 'deny') expect(d.reason).toContain('job_dispatch');
  });
  it('göreli yol da yakalanır', () => {
    expect(decide(edit('src/a.ts'), ctx).action).toBe('deny');
  });
  it('dokümantasyon ve hafıza yolları serbest', () => {
    expect(decide(edit(join(root, 'lat.md', 'x.md')), ctx).action).toBe('allow');
    expect(decide(edit(join(root, 'README.md')), ctx).action).toBe('allow');
  });
  it('proje dışı serbest', () => {
    const outside = process.platform === 'win32' ? 'D:\\other\\a.ts' : '/other/a.ts';
    expect(decide(edit(outside), ctx).action).toBe('allow');
  });
  it('müdahale izni olan yol serbest, olmayan değil', () => {
    const grants = [
      {
        grant_id: 'G-1',
        reason: 'r',
        paths: ['src/fix/**'],
        task_id: null,
        created_at: '',
        expires_at: '',
      },
    ];
    expect(decide(edit('src/fix/a.ts'), { ...ctx, grants }).action).toBe('allow');
    expect(decide(edit('src/other.ts'), { ...ctx, grants }).action).toBe('deny');
  });
  it('warn ve off modları', () => {
    expect(
      decide(edit('src/a.ts'), { ...ctx, config: { ...DEFAULT_CONFIG, director_mode: 'warn' } })
        .action,
    ).toBe('warn');
    expect(
      decide(edit('src/a.ts'), { ...ctx, config: { ...DEFAULT_CONFIG, director_mode: 'off' } })
        .action,
    ).toBe('allow');
  });
  it('shell: değiştirici engellenir, doğrulama serbest', () => {
    const sh = (command: string) => ({ cwd: root, tool_name: 'Bash', tool_input: { command } });
    expect(decide(sh('echo x > src/a.ts'), ctx).action).toBe('deny');
    expect(decide(sh('npm test'), ctx).action).toBe('allow');
  });
  it('diğer araçlar serbest', () => {
    expect(
      decide({ cwd: root, tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }, ctx).action,
    ).toBe('allow');
  });
});

describe('runPreToolUse + izinler (dosya sistemi)', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
    mkdirSync(join(t.dir, '.anafor'), { recursive: true });
  });
  afterEach(() => t.cleanup());

  it('Anafor projesi değilse çıktı yok', () => {
    const plain = tempDir();
    try {
      expect(
        runPreToolUse({ cwd: plain.dir, tool_name: 'Write', tool_input: { file_path: 'a.ts' } }),
      ).toBe('');
    } finally {
      plain.cleanup();
    }
  });

  it('engelleme Claude Code biçiminde döner ve ihlal audit e yazılır', () => {
    const out = runPreToolUse({
      cwd: join(t.dir),
      tool_name: 'Write',
      tool_input: { file_path: 'src/a.ts' },
    });
    const j = JSON.parse(out);
    expect(j.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(j.hookSpecificOutput.permissionDecision).toBe('deny');
    const audit = readFileSync(join(t.dir, '.anafor', 'audit', 'interventions.jsonl'), 'utf8');
    expect(audit).toContain('director_violation');
  });

  it('alt dizinden çağrılınca kök bulunur', () => {
    mkdirSync(join(t.dir, 'src', 'deep'), { recursive: true });
    expect(findAnaforRoot(join(t.dir, 'src', 'deep'))).toBe(t.dir);
  });

  it('proje config ile warn modu', () => {
    writeFileSync(join(t.dir, 'anafor.config.json'), JSON.stringify({ director_mode: 'warn' }));
    expect(
      runPreToolUse({ cwd: t.dir, tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }),
    ).toBe('');
  });

  it('grant yaşam döngüsü: oluştur → izin → bitir → izin yok', () => {
    const g = createGrant(t.dir, { reason: 'küçük çakışma', paths: ['src/a.ts'], ttlMin: 5 });
    expect(
      runPreToolUse({ cwd: t.dir, tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }),
    ).toBe('');
    endGrant(t.dir, g.grant_id, 'çözüldü');
    expect(
      runPreToolUse({ cwd: t.dir, tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }),
    ).not.toBe('');
  });

  it('süresi dolan grant temizlenir', () => {
    createGrant(t.dir, { reason: 'deneme', paths: ['x'], ttlMin: 1 });
    expect(activeGrants(t.dir)).toHaveLength(1);
    expect(activeGrants(t.dir, Date.now() + 2 * 60_000)).toHaveLength(0);
    expect(activeGrants(t.dir)).toHaveLength(0);
  });

  it('süre üst sınırı 30 dk', () => {
    const g = createGrant(t.dir, { reason: 'deneme', paths: ['x'], ttlMin: 999 });
    expect(Date.parse(g.expires_at) - Date.parse(g.created_at)).toBe(30 * 60_000);
  });
});
