import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';
import { anaforHome } from '../limits/limits.js';

/**
 * Eklenti kaydı (F23). Taramadan geçen her skill/MCP içerik özetiyle kaydedilir; özet
 * değişirse eklenti yeniden taranmadan çalışmaz. Proje kapsamı: `.anafor/extensions.json`,
 * kullanıcı kapsamı: `~/.anafor/extensions.json`.
 */
export type ExtensionKind = 'skill' | 'mcp';
export type ExtensionScope = 'project' | 'user';

export interface ExtensionEntry {
  name: string;
  kind: ExtensionKind;
  scope: ExtensionScope;
  source: string;
  /** Kurulu içerik özeti (skill: dizin; mcp: kaynak dizin + komut). */
  sha256: string;
  scanner: string;
  score: number;
  severity: string;
  recommendation: string;
  decision: 'allow' | 'accepted-risk';
  scanned_at: string;
  /** MCP: .mcp.json'a yazılan komut (değişirse yeniden tarama gerekir). */
  command?: string[];
}

const SKIP = new Set(['.git', 'node_modules', '__pycache__', '.venv']);

/** Dizin içeriğinin deterministik özeti (yol + içerik; .git vb. hariç). Sembolik bağ reddedilir. */
export function hashTree(dir: string): string {
  const h = createHash('sha256');
  const walk = (d: string) => {
    for (const name of readdirSync(d).sort()) {
      if (SKIP.has(name)) continue;
      const p = join(d, name);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      const rel = relative(dir, p).replace(/\\/g, '/');
      if (st.isSymbolicLink()) throw new Error(`sembolik bağ desteklenmiyor: ${rel}`);
      if (st.isDirectory()) walk(p);
      else {
        h.update(`${rel}\0`);
        h.update(readFileSync(p));
        h.update('\0');
      }
    }
  };
  walk(dir);
  return h.digest('hex');
}

export const commandHash = (cmd: string[]) =>
  createHash('sha256').update(JSON.stringify(cmd)).digest('hex');

const regFile = (scope: ExtensionScope, root: string, env?: NodeJS.ProcessEnv) =>
  scope === 'project'
    ? join(root, '.anafor', 'extensions.json')
    : join(anaforHome(env), 'extensions.json');

export function readRegistry(
  scope: ExtensionScope,
  root: string,
  env?: NodeJS.ProcessEnv,
): ExtensionEntry[] {
  try {
    const d = JSON.parse(readFileSync(regFile(scope, root, env), 'utf8')) as {
      extensions?: ExtensionEntry[];
    };
    return d.extensions ?? [];
  } catch {
    return [];
  }
}

export function upsertEntry(root: string, e: ExtensionEntry, env?: NodeJS.ProcessEnv): void {
  const list = readRegistry(e.scope, root, env).filter(
    (x) => !(x.name === e.name && x.kind === e.kind),
  );
  list.push(e);
  const f = regFile(e.scope, root, env);
  mkdirSync(join(f, '..'), { recursive: true });
  writeFileSync(f, JSON.stringify({ extensions: list }, null, 2) + '\n');
}

export function removeEntry(
  root: string,
  scope: ExtensionScope,
  kind: ExtensionKind,
  name: string,
  env?: NodeJS.ProcessEnv,
): boolean {
  const list = readRegistry(scope, root, env);
  const next = list.filter((x) => !(x.name === name && x.kind === kind));
  if (next.length === list.length) return false;
  writeFileSync(regFile(scope, root, env), JSON.stringify({ extensions: next }, null, 2) + '\n');
  return true;
}

/** Skill dizinleri: proje `.claude/skills`, kullanıcı `~/.claude/skills`. */
export function skillDirs(root: string, home = homedir()): Record<ExtensionScope, string> {
  return { project: join(root, '.claude', 'skills'), user: join(home, '.claude', 'skills') };
}

/** Projenin `.mcp.json` sunucuları (Anafor'un kendisi hariç). */
export function projectMcpServers(root: string): Record<string, string[]> {
  try {
    const d = JSON.parse(readFileSync(join(root, '.mcp.json'), 'utf8')) as {
      mcpServers?: Record<string, { command?: string; args?: string[]; url?: string }>;
    };
    const out: Record<string, string[]> = {};
    for (const [name, s] of Object.entries(d.mcpServers ?? {})) {
      if (name === 'anafor') continue;
      out[name] = s.url ? [s.url] : [s.command ?? '', ...(s.args ?? [])];
    }
    return out;
  } catch {
    return {};
  }
}

export type ExtStatus = 'ok' | 'unregistered' | 'changed';

export interface ExtFinding {
  name: string;
  kind: ExtensionKind;
  scope: ExtensionScope;
  path: string;
  status: ExtStatus;
}

/** Bir skill'in kayıt durumu (hook ve check ortak). */
export function skillStatus(
  root: string,
  scope: ExtensionScope,
  name: string,
  dir: string,
  env?: NodeJS.ProcessEnv,
): ExtStatus {
  const e = readRegistry(scope, root, env).find((x) => x.kind === 'skill' && x.name === name);
  if (!e) return 'unregistered';
  try {
    return hashTree(dir) === e.sha256 ? 'ok' : 'changed';
  } catch {
    return 'changed';
  }
}

export function mcpStatus(
  root: string,
  name: string,
  command: string[],
  env?: NodeJS.ProcessEnv,
): ExtStatus {
  const e = readRegistry('project', root, env).find((x) => x.kind === 'mcp' && x.name === name);
  if (!e) return 'unregistered';
  return JSON.stringify(e.command ?? []) === JSON.stringify(command) ? 'ok' : 'changed';
}

/** Kurulu tüm skill ve proje MCP sunucularının kayıt durumu. */
export function checkExtensions(
  root: string,
  opts: { home?: string; env?: NodeJS.ProcessEnv } = {},
): ExtFinding[] {
  const out: ExtFinding[] = [];
  const dirs = skillDirs(root, opts.home);
  for (const scope of ['project', 'user'] as const) {
    const base = dirs[scope];
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base).sort()) {
      const p = join(base, name);
      if (!statSync(p).isDirectory() || !existsSync(join(p, 'SKILL.md'))) continue;
      out.push({
        name,
        kind: 'skill',
        scope,
        path: p,
        status: skillStatus(root, scope, name, p, opts.env),
      });
    }
  }
  for (const [name, cmd] of Object.entries(projectMcpServers(root))) {
    out.push({
      name,
      kind: 'mcp',
      scope: 'project',
      path: join(root, '.mcp.json'),
      status: mcpStatus(root, name, cmd, opts.env),
    });
  }
  return out;
}
