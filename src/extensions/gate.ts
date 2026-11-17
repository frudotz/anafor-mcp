import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import {
  commandHash,
  hashTree,
  readRegistry,
  skillDirs,
  upsertEntry,
  type ExtensionEntry,
  type ExtensionScope,
} from './registry.js';
import { scanPath, type ScanResult } from './skillspector.js';

/**
 * SkillSpector kapısı (F23). Politika (kullanıcı kararı 2026-11-17):
 *  - tarama hatası → engel (fail-closed)
 *  - DO_NOT_INSTALL / skor > 50 (HIGH, CRITICAL) → engel
 *  - CAUTION / skor 21–50 → yalnızca açık onayla (--accept-risk), onay kaydedilir
 *  - SAFE (0–20) → geçer
 */
export type GateDecision =
  | { action: 'allow'; decision: 'allow' | 'accepted-risk'; reason: string }
  | { action: 'needs-ack'; reason: string }
  | { action: 'block'; reason: string };

export function decideGate(scan: ScanResult, acceptRisk: boolean): GateDecision {
  if (!scan.ok) return { action: 'block', reason: `tarama başarısız (fail-closed): ${scan.error}` };
  const label = `skor ${scan.score} ${scan.severity} ${scan.recommendation}`;
  if (scan.recommendation === 'DO_NOT_INSTALL' || scan.score > 50)
    return { action: 'block', reason: `${label}: kurulamaz` };
  if (scan.recommendation !== 'SAFE' || scan.score > 20) {
    return acceptRisk
      ? { action: 'allow', decision: 'accepted-risk', reason: `${label}: risk açıkça onaylandı` }
      : {
          action: 'needs-ack',
          reason: `${label}: bulguları inceleyip --accept-risk ile onaylayın`,
        };
  }
  return { action: 'allow', decision: 'allow', reason: label };
}

export interface GateOutcome {
  status: 'installed' | 'blocked' | 'needs-ack' | 'error';
  name: string;
  reason: string;
  scan?: ScanResult;
  dest?: string;
}

export interface GateOptions {
  bin: string;
  acceptRisk?: boolean;
  scope?: ExtensionScope;
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Test için: tarayıcı yerine. */
  scanner?: (path: string) => ScanResult;
}

const isRemote = (s: string) => /^(https?:\/\/|git@)/.test(s);
const safeName = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|-+$/g, '')
    .slice(0, 64);

/** Kaynağı yerel bir dizine getirir (uzak: `git clone --depth 1` geçici dizine). */
function fetchSource(source: string): { dir: string; cleanup: () => void } {
  if (!isRemote(source)) {
    const dir = resolve(source);
    if (!existsSync(dir) || !statSync(dir).isDirectory())
      throw new Error(`kaynak dizin bulunamadı: ${source}`);
    return { dir, cleanup: () => {} };
  }
  const tmp = mkdtempSync(join(tmpdir(), 'anafor-ext-'));
  const r = spawnSync('git', ['clone', '--depth', '1', '--quiet', '--', source, tmp], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 5 * 60_000,
  });
  const cleanup = () => rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  if (r.status !== 0) {
    cleanup();
    throw new Error(`git clone başarısız: ${(r.stderr || '').trim().split('\n').pop()}`);
  }
  return { dir: tmp, cleanup };
}

/** SKILL.md içeren dizini bulur: kök, `subpath` ya da tek alt dizin. */
export function locateSkill(dir: string, subpath?: string): string {
  if (subpath) {
    const p = resolve(dir, subpath);
    if (!existsSync(join(p, 'SKILL.md'))) throw new Error(`${subpath} içinde SKILL.md yok`);
    return p;
  }
  if (existsSync(join(dir, 'SKILL.md'))) return dir;
  const found: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3) return;
    for (const n of readdirSync(d)) {
      if (n === '.git' || n === 'node_modules') continue;
      const p = join(d, n);
      if (!statSync(p).isDirectory()) continue;
      if (existsSync(join(p, 'SKILL.md'))) found.push(p);
      else walk(p, depth + 1);
    }
  };
  walk(dir, 0);
  if (found.length === 1) return found[0]!;
  if (!found.length) throw new Error('SKILL.md bulunamadı');
  throw new Error(
    `birden çok skill var; --path ile seçin: ${found.map((f) => f.slice(dir.length + 1)).join(', ')}`,
  );
}

function skillName(dir: string): string {
  const m = /^name:\s*["']?([^"'\n]+)/m.exec(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
  return safeName(m?.[1] ?? basename(dir));
}

function scanWith(o: GateOptions, path: string): ScanResult {
  return o.scanner ? o.scanner(path) : scanPath(o.bin, path);
}

function entryFrom(
  name: string,
  kind: 'skill' | 'mcp',
  scope: ExtensionScope,
  source: string,
  sha256: string,
  scan: Extract<ScanResult, { ok: true }>,
  decision: 'allow' | 'accepted-risk',
  command?: string[],
): ExtensionEntry {
  return {
    name,
    kind,
    scope,
    source,
    sha256,
    scanner: scan.scanner,
    score: scan.score,
    severity: scan.severity,
    recommendation: scan.recommendation,
    decision,
    scanned_at: new Date().toISOString(),
    ...(command ? { command } : {}),
  };
}

/** Skill'i tarar; geçerse `.claude/skills/<ad>/` (proje) veya `~/.claude/skills/<ad>/` dizinine kurar. */
export function addSkill(
  root: string,
  source: string,
  o: GateOptions & { name?: string; subpath?: string },
): GateOutcome {
  const scope = o.scope ?? 'project';
  let fetched: { dir: string; cleanup: () => void };
  try {
    fetched = fetchSource(source);
  } catch (e) {
    return { status: 'error', name: o.name ?? source, reason: (e as Error).message };
  }
  try {
    const dir = locateSkill(fetched.dir, o.subpath);
    const name = safeName(o.name ?? skillName(dir));
    const dest = join(skillDirs(root, o.home)[scope], name);
    const registered = readRegistry(scope, root, o.env).some(
      (x) => x.kind === 'skill' && x.name === name,
    );
    if (existsSync(dest) && !registered) {
      return {
        status: 'error',
        name,
        reason: `${dest} zaten var ve kayıtlı değil: önce \`anafor ext adopt ${name}\` ile taratın`,
      };
    }
    const scan = scanWith(o, dir);
    const d = decideGate(scan, !!o.acceptRisk);
    if (d.action !== 'allow') {
      return {
        status: d.action === 'block' ? 'blocked' : 'needs-ack',
        name,
        reason: d.reason,
        scan,
      };
    }
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(dir, dest, { recursive: true, filter: (p) => basename(p) !== '.git' });
    upsertEntry(
      root,
      entryFrom(name, 'skill', scope, source, hashTree(dest), scan as never, d.decision),
      o.env,
    );
    return { status: 'installed', name, reason: d.reason, scan, dest };
  } catch (e) {
    return { status: 'error', name: o.name ?? source, reason: (e as Error).message };
  } finally {
    fetched.cleanup();
  }
}

/** Zaten kurulu bir skill'i yerinde tarar ve geçerse kaydeder. */
export function adoptSkill(root: string, name: string, o: GateOptions): GateOutcome {
  const scope = o.scope ?? 'project';
  const dir = join(skillDirs(root, o.home ?? homedir())[scope], name);
  if (!existsSync(join(dir, 'SKILL.md')))
    return { status: 'error', name, reason: `${dir} içinde SKILL.md yok` };
  const scan = scanWith(o, dir);
  const d = decideGate(scan, !!o.acceptRisk);
  if (d.action !== 'allow')
    return { status: d.action === 'block' ? 'blocked' : 'needs-ack', name, reason: d.reason, scan };
  upsertEntry(
    root,
    entryFrom(name, 'skill', scope, dir, hashTree(dir), scan as never, d.decision),
    o.env,
  );
  return { status: 'installed', name, reason: d.reason, scan, dest: dir };
}

/**
 * MCP sunucusunu tarar ve `.mcp.json`'a ekler. Kaynak (sunucunun kodu: dizin veya git URL)
 * zorunludur; kayıt kaynak özeti + komutla tutulur.
 */
export function addMcp(
  root: string,
  name: string,
  command: string[],
  source: string,
  o: GateOptions,
): GateOutcome {
  const n = safeName(name);
  if (!command.length || !command[0]) return { status: 'error', name: n, reason: 'komut boş' };
  if (n === 'anafor') return { status: 'error', name: n, reason: '"anafor" adı ayrılmış' };
  let fetched: { dir: string; cleanup: () => void };
  try {
    fetched = fetchSource(source);
  } catch (e) {
    return { status: 'error', name: n, reason: (e as Error).message };
  }
  try {
    const scan = scanWith(o, fetched.dir);
    const d = decideGate(scan, !!o.acceptRisk);
    if (d.action !== 'allow')
      return {
        status: d.action === 'block' ? 'blocked' : 'needs-ack',
        name: n,
        reason: d.reason,
        scan,
      };
    const file = join(root, '.mcp.json');
    const cfg = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as { mcpServers?: Record<string, unknown> })
      : {};
    cfg.mcpServers = {
      ...(cfg.mcpServers ?? {}),
      [n]: { command: command[0], args: command.slice(1) },
    };
    writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    const sha = commandHash([hashTree(fetched.dir), ...command]);
    upsertEntry(
      root,
      entryFrom(n, 'mcp', 'project', source, sha, scan as never, d.decision, command),
      o.env,
    );
    return { status: 'installed', name: n, reason: d.reason, scan, dest: file };
  } catch (e) {
    return { status: 'error', name: n, reason: (e as Error).message };
  } finally {
    fetched.cleanup();
  }
}
