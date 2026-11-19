import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { killPidTree } from '../core/process-util.js';
import { git } from '../git/git.js';

/** Yaygın gizli bilgi desenleri (eklenen satırlarda aranır). */
export const SECRET_PATTERNS: { id: string; re: RegExp }[] = [
  { id: 'private-key', re: /-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/ },
  { id: 'aws-access-key', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  {
    id: 'github-token',
    re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{60,}\b/,
  },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'openai-key', re: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/ },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'stripe-key', re: /\b(sk|rk)_live_[0-9A-Za-z]{20,}\b/ },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    id: 'generic-secret',
    re: /\b(password|passwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]\s*['"][^'"\s]{8,}['"]/i,
  },
];

export interface SecretFinding {
  rule: string;
  file: string;
  line: number;
}

/** Birleşik diff metninde yalnızca eklenen satırları tarar. Gizli değerin kendisi döndürülmez. */
export function scanDiffForSecrets(patch: string): SecretFinding[] {
  const out: SecretFinding[] = [];
  let file = '';
  let line = 0;
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++ ')) {
      file = raw.slice(4).replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]) - 1;
      continue;
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      line++;
      for (const p of SECRET_PATTERNS) {
        if (p.re.test(raw)) out.push({ rule: p.id, file, line });
      }
    } else if (!raw.startsWith('-')) {
      line++;
    }
  }
  return out;
}

export interface EvidenceResult {
  path: string;
  passed: boolean;
  summary: string;
}

export function canReuseAutoCheck(
  check: { command: string; head_sha?: string; workdir: string } | null | undefined,
  command: string,
  head: string | null,
  workdir: string,
  status: string[],
): boolean {
  return (
    !!check &&
    check.command === command &&
    !!head &&
    check.head_sha === head &&
    check.workdir === workdir &&
    status.length === 0
  );
}

export async function generateTestEvidenceAsync(
  root: string,
  cwd: string,
  evidenceDir: string,
  taskId: string,
  command: string,
  timeoutMs = 20 * 60_000,
): Promise<EvidenceResult> {
  mkdirSync(evidenceDir, { recursive: true });
  const started = Date.now();
  const result = await new Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
    timedOut: boolean;
  }>((resolve) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    let timedOut = false;
    let settled = false;
    const finish = (value: {
      status: number | null;
      stdout: string;
      stderr: string;
      timedOut: boolean;
    }) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid) killPidTree(child.pid);
      child.kill('SIGKILL');
      finish({ status: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      finish({ status, stdout, stderr, timedOut });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      stderr += error.message;
      finish({ status: null, stdout, stderr, timedOut });
    });
  });
  const tail = (s: string) => s.split('\n').slice(-60).join('\n');
  const file = join(evidenceDir, `${taskId}-tests.txt`);
  const passed = result.status === 0 && !result.timedOut;
  writeFileSync(
    file,
    [
      `zaman: ${stamp()}`,
      `komut: ${command}`,
      `dizin: ${relative(root, cwd) || '.'}`,
      `çıkış kodu: ${result.status ?? 'yok'}`,
      ...(result.timedOut ? ['sonuç: zaman aşımı'] : []),
      `süre: ${Date.now() - started} ms`,
      '--- stdout (son 60 satır) ---',
      tail(result.stdout),
      '--- stderr (son 60 satır) ---',
      tail(result.stderr),
    ].join('\n'),
  );
  return {
    path: relative(root, file).replace(/\\/g, '/'),
    passed,
    summary: result.timedOut
      ? `${command} → zaman aşımı`
      : `${command} → ${result.status ?? 'hata'}`,
  };
}

const stamp = () => new Date().toISOString();

/** Test komutunu çalıştırır ve sonucu kanıt dosyasına yazar. */
export function generateTestEvidence(
  root: string,
  cwd: string,
  evidenceDir: string,
  taskId: string,
  command: string,
  timeoutMs = 20 * 60_000,
): EvidenceResult {
  mkdirSync(evidenceDir, { recursive: true });
  const started = Date.now();
  const r = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (r.error?.name === 'TimeoutError' && r.pid) killPidTree(r.pid);
  const tail = (s: string) => s.split('\n').slice(-60).join('\n');
  const file = join(evidenceDir, `${taskId}-tests.txt`);
  const timedOut =
    r.error?.name === 'TimeoutError' ||
    (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  const passed = r.status === 0 && !timedOut;
  writeFileSync(
    file,
    [
      `zaman: ${stamp()}`,
      `komut: ${command}`,
      `dizin: ${relative(root, cwd) || '.'}`,
      `çıkış kodu: ${r.status ?? 'yok'}${r.error ? ` (${r.error.message})` : ''}`,
      ...(timedOut ? ['sonuç: zaman aşımı'] : []),
      `süre: ${Date.now() - started} ms`,
      '--- stdout (son 60 satır) ---',
      tail(r.stdout ?? ''),
      '--- stderr (son 60 satır) ---',
      tail(r.stderr ?? ''),
    ].join('\n'),
  );
  return {
    path: relative(root, file).replace(/\\/g, '/'),
    passed,
    summary: timedOut ? `${command} → zaman aşımı` : `${command} → ${r.status ?? 'hata'}`,
  };
}

/**
 * Taban..hedef arasındaki değişikliklerde gizli bilgi taraması.
 * gitleaks kuruluysa o da çalıştırılır; değilse yerleşik desenler kullanılır.
 */
export function generateScanEvidence(
  root: string,
  evidenceDir: string,
  taskId: string,
  base: string,
  target: string | null,
  cwd = root,
): EvidenceResult & { findings: SecretFinding[]; scanner: string } {
  mkdirSync(evidenceDir, { recursive: true });
  const range = target ? `${base}..${target}` : base; // hedef yoksa çalışma ağacı
  const patch = git(cwd, [
    'diff',
    '--unified=0',
    target ? range : base,
    '--',
    '.',
    ':(exclude).anafor',
  ]).stdout;
  const findings = scanDiffForSecrets(patch);
  let scanner = 'anafor-builtin';
  const gl = spawnSync('gitleaks', ['version'], { encoding: 'utf8', windowsHide: true });
  let gitleaksNote = '';
  if (!gl.error && gl.status === 0) {
    scanner = 'anafor-builtin + gitleaks';
    // Hedef dal yoksa (çalışma ağacı) taban..HEAD aralığındaki commit'ler taranır.
    const logRange = target ? range : `${base}..HEAD`;
    const report = join(evidenceDir, `${taskId}-gitleaks.json`);
    const g = spawnSync(
      'gitleaks',
      [
        'git',
        '--no-banner',
        '--redact',
        '--report-format',
        'json',
        '--report-path',
        report,
        `--log-opts=${logRange}`,
        '.',
      ],
      { cwd, encoding: 'utf8', windowsHide: true },
    );
    gitleaksNote = `gitleaks çıkış kodu: ${g.status}`;
    if (g.status === 1) {
      const parsed = existsSync(report) ? parseGitleaksReport(readFileSync(report, 'utf8')) : [];
      findings.push(
        ...(parsed.length ? parsed : [{ rule: 'gitleaks', file: '(rapor okunamadı)', line: 0 }]),
      );
    }
  }
  const file = join(evidenceDir, `${taskId}-scan.txt`);
  const passed = findings.length === 0;
  writeFileSync(
    file,
    [
      `zaman: ${stamp()}`,
      `tarayıcı: ${scanner}`,
      `aralık: ${range}${target ? '' : ' (çalışma ağacı)'}`,
      gitleaksNote,
      `bulgu: ${findings.length}`,
      ...findings.map((f) => `- ${f.rule} @ ${f.file}:${f.line}`),
      passed ? 'sonuç: temiz' : 'sonuç: GİZLİ BİLGİ ŞÜPHESİ',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  return {
    path: relative(root, file).replace(/\\/g, '/'),
    passed,
    summary: passed ? 'temiz' : `${findings.length} şüpheli bulgu`,
    findings,
    scanner,
  };
}

/** Projede bir test komutu tahmin eder (package.json test betiği). */
export function detectTestCommand(cwd: string): string | null {
  const pkg = join(cwd, 'package.json');
  if (!existsSync(pkg)) return null;
  try {
    const j = JSON.parse(readFileSync(pkg, 'utf8')) as { scripts?: Record<string, string> };
    return j.scripts?.test ? 'npm test' : null;
  } catch {
    return null;
  }
}

/**
 * gitleaks JSON raporu → bulgular (kural, dosya, satır). Gizli değer (Secret/Match)
 * kanıta ALINMAZ; rapor zaten --redact ile üretilir.
 */
export function parseGitleaksReport(json: string): SecretFinding[] {
  try {
    const arr = JSON.parse(json) as { RuleID?: string; File?: string; StartLine?: number }[];
    if (!Array.isArray(arr)) return [];
    return arr.map((f) => ({
      rule: `gitleaks:${f.RuleID ?? '?'}`,
      file: String(f.File ?? '?').replace(/\\/g, '/'),
      line: typeof f.StartLine === 'number' ? f.StartLine : 0,
    }));
  } catch {
    return [];
  }
}
