import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, findAnaforRoot, resolveProjectRoot } from '../../src/core/config.js';
import {
  classifyShell,
  decide,
  runPreToolUse,
  stripQuotedAndHeredoc,
} from '../../src/hooks/director.js';
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
    "echo 'a > b'",
    'git commit -m "x -> y"',
    `gh pr create --body "$(cat <<'EOF'\n<id…> [--mode any]\nEOF\n)"`,
    'grep "=>" f',
  ];
  it.each(mutating)('değiştirici: %s', (c) => expect(classifyShell(c)).not.toBeNull());
  it.each(safe)('güvenli: %s', (c) => expect(classifyShell(c)).toBeNull());
  it.each([
    'echo x > f',
    'cat <<EOF > out.txt',
    'echo "$(cat a > b)"',
    'echo `cat a > b`',
    "printf '%s' x >> log",
    "bash -c 'echo a > f'",
    'sh -c "x > f"',
    'pwsh -Command "Get-Date > f"',
    "powershell -c 'Get-Date > f'",
    'cmd /c "echo a > f"',
    'eval "echo a > f"',
    'node -e "console.log(1); process.stdout.write(\"x > f\")"',
    'python -c \'print(1); open("f", "w")\'',
  ])('gerçek yönlendirmeyi yakalar: %s', (c) => expect(classifyShell(c)).not.toBeNull());
  it('tırnak ve heredoc içeriğini safça ayıklar, açılış satırını korur', () => {
    expect(stripQuotedAndHeredoc(`cat <<'EOF' > out\ntext > ignored\nEOF\necho 'x > y'`)).toContain(
      '> out',
    );
    expect(stripQuotedAndHeredoc('echo "$(cat a > b)"')).toContain('> b');
  });
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
  const shell = (command: string, cwd = root) => ({
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  });
  it('dış cd ardından proje mutlak yolu atlatmasını reddeder', () => {
    const outside = process.platform === 'win32' ? 'C:\\Users\\x\\kasa' : '/tmp';
    expect(
      decide(shell(`cd "${outside}" && sed -i s/a/b/ "${join(root, 'src', 'a.ts')}"`), ctx).action,
    ).toBe('deny');
  });
  it('proje cwd içinde cd olmadan değişikliği reddeder', () => {
    expect(decide(shell('sed -i s/a/b/ src/a.ts'), ctx).action).toBe('deny');
  });
  it('proje içine çözülen göreli yolu reddeder', () => {
    const outside = process.platform === 'win32' ? 'C:\\tmp' : '/tmp';
    const relativeProject =
      process.platform === 'win32' ? '..\\proj\\src\\a.ts' : '../proj/src/a.ts';
    expect(decide(shell(`cd "${outside}" && sed -i s/a/b/ ${relativeProject}`), ctx).action).toBe(
      'deny',
    );
  });
  it('cd - hedefini reddeder', () => {
    expect(decide(shell('cd /tmp && cd - && sed -i s/a/b/ src/a.ts'), ctx).action).toBe('deny');
  });
  it('değişkenli cd hedefini reddeder', () => {
    expect(decide(shell('cd $DIR && sed -i s/a/b/ file.ts'), ctx).action).toBe('deny');
  });
  it('pushd hedefini reddeder', () => {
    expect(decide(shell('pushd /tmp && sed -i s/a/b/ file.ts'), ctx).action).toBe('deny');
  });
  it('git -C mutasyonu eski deny davranışında kalır', () => {
    expect(decide(shell('git -C /tmp apply patch.diff'), ctx).action).toBe('deny');
  });
  it('cd || zincirini reddeder', () => {
    expect(decide(shell('cd /tmp || cd src && sed -i s/a/b/ file.ts'), ctx).action).toBe('deny');
  });
  it('cd ; zincirini reddeder', () => {
    expect(decide(shell('cd /tmp; sed -i s/a/b/ file.ts'), ctx).action).toBe('deny');
  });
  it('diğer araçlar serbest', () => {
    expect(
      decide({ cwd: root, tool_name: 'Read', tool_input: { file_path: 'src/a.ts' } }, ctx).action,
    ).toBe('allow');
  });
});

describe('shell dış dizin beyaz listesi', () => {
  let rootDir: ReturnType<typeof tempDir>;
  let outsideDir: ReturnType<typeof tempDir>;
  beforeEach(() => {
    rootDir = tempDir();
    outsideDir = tempDir();
  });
  afterEach(() => {
    rootDir.cleanup();
    outsideDir.cleanup();
  });
  const shellCtx = (root: string) => ({ root, config: DEFAULT_CONFIG, grants: [] });
  const input = (command: string, cwd: string) => ({
    cwd,
    tool_name: 'Bash',
    tool_input: { command },
  });
  it('gerçek POSIX/Windows dış dizinine cd ile ve cd olmadan izin verir', () => {
    const root = rootDir.dir;
    const outside = outsideDir.dir;
    const cd = `cd /d "${outside}"`;
    expect(decide(input(`${cd} && sed -i s/a/b/ Durum.md`, root), shellCtx(root)).action).toBe(
      'allow',
    );
    expect(decide(input('sed -i s/a/b/ Durum.md', outside), shellCtx(root)).action).toBe('allow');
  });
  it('dosya yönlendirmesini parantezden sonra sınıflandırır', () => {
    expect(classifyShell('(>src/a.ts)')).not.toBeNull();
  });
  it('dosya yönlendirmesini noktalı virgül ve parantezden sonra sınıflandırır', () => {
    expect(classifyShell(';(>x)')).not.toBeNull();
  });
  it('mevcut sembolik bağ üzerinden proje içine cd etmeyi reddeder', () => {
    const link = join(outsideDir.dir, 'linked-project');
    symlinkSync(rootDir.dir, link, process.platform === 'win32' ? 'junction' : 'dir');
    expect(
      decide(input(`cd "${link}" && sed -i s/a/b/ Durum.md`, rootDir.dir), shellCtx(rootDir.dir))
        .action,
    ).toBe('deny');
  });
  it('olmayan cd hedefini reddeder', () => {
    const missing = join(outsideDir.dir, 'missing');
    expect(
      decide(input(`cd "${missing}" && sed -i s/a/b/ Durum.md`, rootDir.dir), shellCtx(rootDir.dir))
        .action,
    ).toBe('deny');
  });
  it('cd hedefindeki iç tırnağı reddeder', () => {
    expect(
      decide(
        input(`cd "${outsideDir.dir}\\"x" && sed -i s/a/b/ file`, rootDir.dir),
        shellCtx(rootDir.dir),
      ).action,
    ).toBe('deny');
  });
  it('cd hedefindeki köşeli parantezi reddeder', () => {
    expect(
      decide(
        input(`cd "${outsideDir.dir}[x]" && sed -i s/a/b/ file`, rootDir.dir),
        shellCtx(rootDir.dir),
      ).action,
    ).toBe('deny');
  });
  it('POSIX cd hedefindeki ters eğik çizgiyi reddeder', () => {
    expect(
      decide(
        input(`cd "${outsideDir.dir}\\x" && sed -i s/a/b/ file`, rootDir.dir),
        shellCtx(rootDir.dir),
      ).action,
    ).toBe('deny');
  });
  it('POSIX kalan metindeki ters eğik çizgiyi reddeder', () => {
    const result = decide(input('sed -i s/a/b/ foo\\bar', outsideDir.dir), shellCtx(rootDir.dir));
    expect(result.action).toBe(process.platform === 'win32' ? 'allow' : 'deny');
  });
  it('kalan metindeki köşeli parantezi reddeder', () => {
    expect(
      decide(input('sed -i s/a/b/ file[1].txt', outsideDir.dir), shellCtx(rootDir.dir)).action,
    ).toBe('deny');
  });
  it('mutlak ata dizin argümanını reddeder', () => {
    expect(
      decide(
        input(`dd if=input of=${outsideDir.dir}`, outsideDir.dir),
        shellCtx(join(outsideDir.dir, 'proje')),
      ).action,
    ).toBe('deny');
  });
  it('kısa proje basenameini absolute ata kontrolüyle reddeder', () => {
    const root = join(outsideDir.dir, 'abc');
    expect(
      decide(input(`sed -i s/a/b/ ${outsideDir.dir}`, rootDir.dir), shellCtx(root)).action,
    ).toBe('deny');
  });
  it('boşluklu mutlak proje yolunu tırnaklar soyulduktan sonra reddeder', () => {
    const root = join(rootDir.dir, 'abc dir');
    mkdirSync(root);
    expect(
      decide(input(`sed -i s/a/b/ "${root}/src/a.ts"`, outsideDir.dir), shellCtx(root)).action,
    ).toBe('deny');
  });
  it('POSIX redirect mutlak proje yolunu reddeder', () => {
    expect(decide(input('echo x >/proje/x', outsideDir.dir), shellCtx('/proje')).action).toBe(
      'deny',
    );
  });
  it('parenthesized redirect proje yolunu reddeder', () => {
    expect(
      decide(input(`echo x 2>${join(rootDir.dir, 'x')}`, outsideDir.dir), shellCtx(rootDir.dir))
        .action,
    ).toBe('deny');
  });
  it('dd of parametresindeki proje yolunu reddeder', () => {
    expect(
      decide(
        input(`dd if=input of=${join(rootDir.dir, 'out')}`, outsideDir.dir),
        shellCtx(rootDir.dir),
      ).action,
    ).toBe('deny');
  });
  it('PowerShell Path belirtecindeki proje yolunu reddeder', () => {
    expect(
      decide(
        input(
          `Set-Content -Path:${relative(outsideDir.dir, rootDir.dir).replace(/\\/g, '/')}/x value`,
          outsideDir.dir,
        ),
        shellCtx(rootDir.dir),
      ).action,
    ).toBe('deny');
  });
  it('tırnakla bölünmüş proje basename yolunu reddeder', () => {
    expect(
      decide(
        input(
          `sed -i s/a/b/ ${relative(outsideDir.dir, rootDir.dir)
            .replace(/\\/g, '/')
            .split('/')
            .map((part, index, parts) => (index === parts.length - 1 ? `"${part}"` : part))
            .join('/')}/src/a.ts`,
          outsideDir.dir,
        ),
        shellCtx(rootDir.dir),
      ).action,
    ).toBe('deny');
  });
  it('tırnakla bölünmüş ata yolunu reddeder', () => {
    expect(
      decide(input('sed -i s/a/b/ ../pro"j"/src/a.ts', outsideDir.dir), shellCtx(rootDir.dir))
        .action,
    ).toBe('deny');
  });
  it('rm -rf komutunu dış dizinde de reddeder', () => {
    expect(decide(input('rm -rf ata', outsideDir.dir), shellCtx(rootDir.dir)).action).toBe('deny');
  });
  it('find ata dizin aramasını reddeder', () => {
    expect(decide(input('find ..', outsideDir.dir), shellCtx(rootDir.dir)).action).toBe('deny');
  });
  it('glob içeren değiştirici komutu reddeder', () => {
    expect(decide(input('sed -i s/a/b/ *.txt', outsideDir.dir), shellCtx(rootDir.dir)).action).toBe(
      'deny',
    );
  });
  it('tilde içeren değiştirici komutu reddeder', () => {
    expect(
      decide(input('sed -i s/a/b/ ~/file', outsideDir.dir), shellCtx(rootDir.dir)).action,
    ).toBe('deny');
  });
  it('yüzde değişkeni içeren değiştirici komutu reddeder', () => {
    expect(decide(input('sed -i s/a/b/ %VAR%', outsideDir.dir), shellCtx(rootDir.dir)).action).toBe(
      'deny',
    );
  });
  it('bash -c yorumlayıcısını reddeder', () => {
    expect(
      decide(input('bash -c "sed -i s/a/b/ file"', outsideDir.dir), shellCtx(rootDir.dir)).action,
    ).toBe('deny');
  });
  it('Git Bash /c biçimindeki proje yolunu reddeder', () => {
    const root = rootDir.dir;
    const gitBashRoot =
      process.platform === 'win32'
        ? '/' + (root[0] ?? '').toLowerCase() + root.slice(2).replace(/\\/g, '/')
        : root;
    expect(
      decide(input(`sed -i s/a/b/ ${gitBashRoot}/src/a.ts`, outsideDir.dir), shellCtx(root)).action,
    ).toBe('deny');
  });
});

it('hook and MCP resolve CLAUDE_PROJECT_DIR even when hook cwd points elsewhere', () => {
  const root = tempDir().dir;
  mkdirSync(join(root, '.anafor'), { recursive: true });
  const other = tempDir().dir;
  const env = { CLAUDE_PROJECT_DIR: root } as NodeJS.ProcessEnv;
  expect(resolveProjectRoot(env, other).root).toBe(root);
  const result = runPreToolUse(
    { cwd: other, tool_name: 'Edit', tool_input: { file_path: join(root, 'src', 'unsafe.ts') } },
    env,
  );
  expect(result).toContain('deny');
});

describe('runPreToolUse + izinler (dosya sistemi)', () => {
  let t: ReturnType<typeof tempDir>;
  beforeEach(() => {
    t = tempDir();
    mkdirSync(join(t.dir, '.anafor'), { recursive: true });
  });
  afterEach(() => t.cleanup());
  const runLocal = (input: Parameters<typeof runPreToolUse>[0]) =>
    runPreToolUse(input, { ANAFOR_PROJECT_ROOT: t.dir });

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
    const out = runLocal({
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
      runLocal({ cwd: t.dir, tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }),
    ).toBe('');
  });

  it('grant yaşam döngüsü: oluştur → izin → bitir → izin yok', () => {
    const g = createGrant(t.dir, { reason: 'küçük çakışma', paths: ['src/a.ts'], ttlMin: 5 });
    expect(
      runLocal({ cwd: t.dir, tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }),
    ).toBe('');
    endGrant(t.dir, g.grant_id, 'çözüldü');
    expect(
      runLocal({ cwd: t.dir, tool_name: 'Write', tool_input: { file_path: 'src/a.ts' } }),
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

describe('resolveEvidence', () => {
  it('göreli yol iş dizinine göre, satır son eki atılır, proje dışı reddedilir', async () => {
    const { resolveEvidence } = await import('../../src/core/accept.js');
    const root = process.platform === 'win32' ? 'C:\\p' : '/p';
    const wt = join(root, '.anafor', 'worktrees', 'J-1');
    expect(resolveEvidence(root, wt, 'src/a.ts:12')).toBe(join(wt, 'src', 'a.ts'));
    expect(resolveEvidence(root, wt, 'a.ts:3:7')).toBe(join(wt, 'a.ts'));
    expect(resolveEvidence(root, wt, '../../../../outside.txt')).toBeNull();
  });
});

describe('findAnaforRoot ev dizini', () => {
  it('ev dizinindeki .anafor (kullanıcı verisi) proje sayılmaz', () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, '.anafor'));
      mkdirSync(join(t.dir, 'proj', 'src'), { recursive: true });
      expect(findAnaforRoot(join(t.dir, 'proj', 'src'), t.dir)).toBeNull();
      mkdirSync(join(t.dir, 'proj', '.anafor'));
      expect(findAnaforRoot(join(t.dir, 'proj', 'src'), t.dir)).toBe(join(t.dir, 'proj'));
    } finally {
      t.cleanup();
    }
  });
});
