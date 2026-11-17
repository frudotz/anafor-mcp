#!/usr/bin/env node
// Anafor katkı koruması (F29). Bir PR'ın diff'ini VERİ olarak inceler; PR kodunu asla çalıştırmaz.
// Kurallar: docs/contribution-guard.md. Bağımlılıksız; CI (pull_request_target, taban dal
// betiği) ve yerel `anafor contrib check` aynı mantığı kullanır.
//
// Kullanım: node scripts/contribution-guard.mjs --base <ref> --head <ref> [--trusted] [--approved] [--json]
import { execFileSync } from 'node:child_process';

/** Ağ uç noktaları için izinli alan adları (yeni bir alan adı "review" ister). */
export const ALLOWED_HOSTS = [
  'github.com',
  'api.github.com',
  'raw.githubusercontent.com',
  'registry.npmjs.org',
  'nodejs.org',
  'claude.com',
  'docs.anthropic.com',
  'docs.nvidia.com',
  'opencode.ai',
  'ollama.com',
  'json-schema.org',
  'keepachangelog.com',
  'semver.org',
  'localhost',
  '127.0.0.1',
  'example.com',
  'evil.example',
];

/** Değişikliği bakımcı incelemesi gerektiren hassas yollar. */
export const SENSITIVE_PATHS = [
  /^\.github\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^scripts\//,
  /^plugin\//,
  /^src\/cli\/update\.ts$/,
  /^src\/setup\//,
  /^src\/hooks\//,
  /^src\/extensions\//,
  /^src\/adapters\/process\.ts$/,
  /^src\/runner\/spawn\.ts$/,
  /^schemas\//,
  /^SECURITY\.md$/,
  /^docs\/contribution-guard\.md$/,
];

const BINARY_EXT =
  /\.(exe|dll|so|dylib|node|wasm|bin|jar|class|pyc|tgz|tar|gz|zip|7z|rar|msi|dmg|apk|scr|com|bat|cmd|ps1|vbs)$/i;
const DOC_FILE = /\.(md|txt)$/i;
const TEST_FIXTURE = /^test\/fixtures\//;

/**
 * Satır kuralları: [kod, önem, açıklama, desen, uygula(yol)].
 * önem: block = birleştirme engellenir; review = güvenilmeyen katkıda bakımcı onayı gerekir.
 */
export const LINE_RULES = [
  [
    'G07',
    'block',
    'Dinamik kod çalıştırma (eval / new Function / vm)',
    /\beval\s*\(|\bnew\s+Function\s*\(|\bvm\.(runIn|compileFunction|Script)/,
    (f) => !DOC_FILE.test(f),
  ],
  [
    'G11',
    'block',
    'İndir-ve-çalıştır deseni (curl|sh, iex, powershell -enc)',
    /\b(curl|wget)\b[^\n|]*\|\s*(ba|z)?sh\b|\bInvoke-Expression\b|\biex\s*\(|powershell[^\n]*\s-e(nc|ncodedcommand)?\s/i,
    (f) => !DOC_FILE.test(f) && !TEST_FIXTURE.test(f),
  ],
  [
    'G12',
    'block',
    'Kimlik bilgisi / gizli dosya erişimi',
    /\.ssh[\\/]|id_rsa|\.aws[\\/]credentials|\.npmrc|\.git-credentials|\.netrc|JSON\.stringify\(\s*process\.env\s*\)|Object\.(entries|keys|values)\(\s*process\.env\s*\)[^\n]*(fetch|request|post)/i,
    (f) => !DOC_FILE.test(f) && !TEST_FIXTURE.test(f),
  ],
  [
    'G13',
    'block',
    'İzin/sandbox atlatma bayrağı',
    /--dangerously[-\w]*|bypassPermissions|--yolo\b|danger-full-access/,
    (f) => !DOC_FILE.test(f) && !/^test\//.test(f) && f !== 'scripts/contribution-guard.mjs',
  ],
  [
    'G14',
    'block',
    'Telemetri / analitik servisi',
    /\b(posthog|mixpanel|segment\.(io|com)|amplitude|sentry\.io|@sentry\/|statsig\.com|datadoghq|newrelic|hotjar|google-analytics|googletagmanager)\b/i,
    (f) => !DOC_FILE.test(f),
  ],
  [
    'G16',
    'block',
    'Gizli Unicode (Trojan Source: yön denetimi / sıfır genişlik)',
    /[‪-‮⁦-⁩​-‍⁠﻿]/,
    () => true,
  ],
  [
    'G18',
    'block',
    'Kod içinde sabit gizli bilgi',
    /\b(sk-ant-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)/,
    () => true,
  ],
  [
    'G19',
    'review',
    'Kabuk üzerinden süreç başlatma (shell: true / exec)',
    /shell:\s*true|\bexecSync\s*\(|child_process['"]\)\.exec\b|\bexec\s*\(\s*['"`]/,
    (f) => /^src\//.test(f),
  ],
];

/** Uzun/gizlenmiş içerik: tek satırda 400+ karakter veya 200+ karakterlik base64/hex bloğu. */
const BLOB = /[A-Za-z0-9+/=]{200,}|(?:[0-9a-fA-F]{2}){100,}|(?:\\x[0-9a-fA-F]{2}){40,}/;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

/** `git diff` çıktısını dosya başına eklenen satırlara ayırır. */
export function parseDiff(diff) {
  const files = [];
  let cur = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      cur = { path: '', added: [], binary: false, deleted: false, isNew: false };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4).trim();
      if (p !== '/dev/null') cur.path = p.replace(/^b\//, '');
      continue;
    }
    if (raw.startsWith('--- ')) {
      const p = raw.slice(4).trim();
      if (p === '/dev/null') cur.isNew = true;
      else if (!cur.path) cur.path = p.replace(/^a\//, '');
      continue;
    }
    if (raw.startsWith('deleted file mode')) cur.deleted = true;
    if (raw.startsWith('new file mode')) cur.isNew = true;
    if (raw.startsWith('Binary files ')) {
      cur.binary = true;
      const m = / and b\/(.+) differ$/.exec(raw);
      if (m && !cur.path) cur.path = m[1];
      continue;
    }
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    if (raw.startsWith('+')) cur.added.push({ n: line++, text: raw.slice(1) });
    else if (!raw.startsWith('-')) line++;
  }
  return files.filter((f) => f.path);
}

function hostsIn(text) {
  const out = [];
  for (const m of text.matchAll(/https?:\/\/([a-z0-9.-]+)(?::\d+)?/gi))
    out.push(m[1].toLowerCase().replace(/\.+$/, ''));
  return out;
}
const hostAllowed = (h) => ALLOWED_HOSTS.some((a) => h === a || h.endsWith(`.${a}`));

/** package.json bağımlılık ve betik değişiklikleri (eski ve yeni içerik karşılaştırılır). */
export function packageFindings(oldPkg, newPkg) {
  const out = [];
  const o = oldPkg ?? {};
  const n = newPkg ?? {};
  for (const sec of [
    'dependencies',
    'devDependencies',
    'optionalDependencies',
    'peerDependencies',
  ]) {
    for (const [name, ver] of Object.entries(n[sec] ?? {})) {
      const prev = o[sec]?.[name];
      if (prev === ver) continue;
      if (
        /^(git\+|git:|github:|https?:|file:|link:)/.test(String(ver)) ||
        /^[\w.-]+\/[\w.-]+/.test(String(ver))
      )
        out.push(['G03', 'block', `Kayıt dışı bağımlılık kaynağı: ${name}@${ver}`, 'package.json']);
      out.push([
        'G01',
        'review',
        prev
          ? `Bağımlılık sürümü değişti: ${name} ${prev} → ${ver}`
          : `Yeni bağımlılık: ${name}@${ver}`,
        'package.json',
      ]);
    }
  }
  for (const s of [
    'preinstall',
    'install',
    'postinstall',
    'prepare',
    'prepublish',
    'preprepare',
    'postprepare',
  ]) {
    if (n.scripts?.[s] && n.scripts[s] !== o.scripts?.[s])
      out.push(['G04', 'block', `Kurulum yaşam döngüsü betiği: scripts.${s}`, 'package.json']);
  }
  if (n.bin && JSON.stringify(n.bin) !== JSON.stringify(o.bin))
    out.push(['G06', 'review', 'Paket bin girdileri değişti', 'package.json']);
  return out;
}

/** package-lock.json: yeni kurulum betikli paketler ve kayıt dışı kaynaklar. */
export function lockFindings(oldLock, newLock) {
  const out = [];
  const oldPk = oldLock?.packages ?? {};
  for (const [path, meta] of Object.entries(newLock?.packages ?? {})) {
    if (!path) continue;
    const prev = oldPk[path];
    if (prev && prev.version === meta.version && prev.resolved === meta.resolved) continue;
    const name = path.replace(/^.*node_modules\//, '');
    if (meta.hasInstallScript)
      out.push([
        'G02',
        'block',
        `Kurulum betiği çalıştıran paket: ${name}@${meta.version}`,
        'package-lock.json',
      ]);
    if (meta.resolved && !meta.resolved.startsWith('https://registry.npmjs.org/'))
      out.push([
        'G03',
        'block',
        `Kayıt dışı kaynak: ${name} → ${meta.resolved}`,
        'package-lock.json',
      ]);
  }
  return out;
}

/**
 * Ana analiz (saf): dosya listesi + paket içerikleri → bulgular ve karar.
 * trusted: OWNER/MEMBER/COLLABORATOR; approved: bakımcının `guard-approved` etiketi.
 */
export function analyze(
  { files, pkg = null, lock = null },
  { trusted = false, approved = false } = {},
) {
  const findings = [];
  const add = (code, severity, message, file, line) =>
    findings.push({ code, severity, message, file, line });

  for (const f of files) {
    if (f.deleted) {
      if (SENSITIVE_PATHS.some((r) => r.test(f.path)))
        add('G06', 'review', 'Hassas dosya silindi', f.path);
      continue;
    }
    if (f.binary || BINARY_EXT.test(f.path)) {
      add('G10', 'block', 'İkili / çalıştırılabilir / arşiv dosyası', f.path);
      continue;
    }
    if (
      /\.min\.(js|mjs|cjs)$/.test(f.path) ||
      (/^(src|scripts|plugin)\//.test(f.path) &&
        /\.(js|cjs)$/.test(f.path) &&
        f.path !== 'scripts/contribution-guard.mjs')
    )
      add('G17', 'block', 'Derlenmiş/küçültülmüş JavaScript kaynak ağacında', f.path);
    if (/^\.github\/workflows\//.test(f.path))
      add('G05', 'review', 'CI/CD iş akışı değişti', f.path);
    else if (SENSITIVE_PATHS.some((r) => r.test(f.path)))
      add('G06', 'review', 'Hassas dosya değişti', f.path);

    // Koruyucunun kendisi kural desenlerini içerir: içerik kuralları uygulanmaz
    // (dosya hassas yol olarak G06 ile bakımcı incelemesine düşer).
    if (f.path === 'scripts/contribution-guard.mjs') continue;
    const doc = DOC_FILE.test(f.path);
    for (const { n, text } of f.added) {
      for (const [code, severity, message, re, applies] of LINE_RULES) {
        if (applies(f.path) && re.test(text)) add(code, severity, message, f.path, n);
      }
      if (!doc && !TEST_FIXTURE.test(f.path)) {
        if (text.length > 400 && !/^\s*(\/\/|\*|#)/.test(text))
          add('G09', 'block', `Aşırı uzun satır (${text.length} karakter)`, f.path, n);
        else if (BLOB.test(text))
          add('G09', 'block', 'Gizlenmiş içerik (base64/hex bloğu)', f.path, n);
        for (const h of hostsIn(text)) {
          if (!hostAllowed(h)) add('G08', 'review', `Yeni ağ uç noktası: ${h}`, f.path, n);
        }
      }
    }
  }
  if (pkg)
    findings.push(
      ...packageFindings(pkg.old, pkg.new).map(([code, severity, message, file]) => ({
        code,
        severity,
        message,
        file,
      })),
    );
  if (lock)
    findings.push(
      ...lockFindings(lock.old, lock.new).map(([code, severity, message, file]) => ({
        code,
        severity,
        message,
        file,
      })),
    );

  const blocks = findings.filter((x) => x.severity === 'block');
  const reviews = findings.filter((x) => x.severity === 'review');
  // block: herkes için engel (bakımcı onayı ile aşılabilir); review: yalnızca güvenilmeyen katkıda onay gerekir.
  const pass = approved || (blocks.length === 0 && (trusted || reviews.length === 0));
  return { pass, trusted, approved, blocks, reviews, findings };
}

function readJsonAt(ref, path) {
  try {
    return JSON.parse(git(['show', `${ref}:${path}`]));
  } catch {
    return null;
  }
}

export function report(r) {
  const lines = [];
  lines.push(`## Anafor katkı koruması: ${r.pass ? '✅ geçti' : '❌ engellendi'}`);
  lines.push('');
  lines.push(
    `Katkıcı: ${r.trusted ? 'güvenilir (sahip/üye/ortak çalışan)' : 'dış katkıcı'} · bakımcı onayı (\`guard-approved\`): ${r.approved ? 'var' : 'yok'}`,
  );
  lines.push('');
  if (!r.findings.length) lines.push('Bulgu yok.');
  for (const x of r.findings)
    lines.push(
      `- **${x.code}** [${x.severity}] ${x.message} — \`${x.file}${x.line ? `:${x.line}` : ''}\``,
    );
  if (!r.pass) {
    lines.push('');
    lines.push(
      r.blocks.length
        ? 'Engelleyici bulgular var. Kod bunları içermeden yeniden düzenlenmeli; gerçekten gerekliyse bakımcı inceleyip `guard-approved` etiketi ekler.'
        : 'Dış katkıda hassas değişiklik var: bakımcı incelemesi ve `guard-approved` etiketi gerekir.',
    );
  }
  lines.push('');
  lines.push('Kurallar: docs/contribution-guard.md');
  return lines.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const val = (k) => {
    const i = args.indexOf(`--${k}`);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const base = val('base') ?? 'origin/main';
  const head = val('head') ?? 'HEAD';
  const mergeBase = git(['merge-base', base, head]).trim();
  const diff = git(['diff', '--no-color', '--no-ext-diff', '-U0', `${mergeBase}..${head}`]);
  const files = parseDiff(diff);
  const touched = new Set(files.map((f) => f.path));
  const pkg = touched.has('package.json')
    ? { old: readJsonAt(mergeBase, 'package.json'), new: readJsonAt(head, 'package.json') }
    : null;
  const lock = touched.has('package-lock.json')
    ? {
        old: readJsonAt(mergeBase, 'package-lock.json'),
        new: readJsonAt(head, 'package-lock.json'),
      }
    : null;
  const r = analyze(
    { files, pkg, lock },
    { trusted: args.includes('--trusted'), approved: args.includes('--approved') },
  );
  process.stdout.write(
    args.includes('--json') ? JSON.stringify(r, null, 2) + '\n' : report(r) + '\n',
  );
  process.exitCode = r.pass ? 0 : 1;
}

// Yalnızca doğrudan çalıştırıldığında (testler içe aktarır).
if (process.argv[1] && /contribution-guard\.mjs$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(`contribution-guard: ${e.message}`);
    process.exitCode = 2;
  });
}
