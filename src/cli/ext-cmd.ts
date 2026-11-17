import { loadConfig } from '../core/config.js';
import { addMcp, addSkill, adoptSkill, type GateOutcome } from '../extensions/gate.js';
import { checkExtensions, readRegistry, removeEntry } from '../extensions/registry.js';
import { findSkillspector, type ScanResult } from '../extensions/skillspector.js';
import { m } from '../i18n/index.js';

/** SkillSpector kurulum yönergesi (geçerli dilde). */
const kurulum = () => m().ext.install;

export function formatScan(scan?: ScanResult): string[] {
  if (!scan) return [];
  if (!scan.ok) return [`  ${m().ext.scan}: ${scan.error}`];
  const counts = Object.entries(scan.counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  return [
    `  SkillSpector (${scan.scanner}): ${m().ext.score} ${scan.score} · ${scan.severity} · ${scan.recommendation}${counts ? ` · ${counts}` : ''}`,
    ...scan.top.map(
      (i) => `   - [${i.severity}] ${i.rule} ${i.title}${i.file ? ` (${i.file})` : ''}`,
    ),
  ];
}

export function formatOutcome(o: GateOutcome): string[] {
  const icon = { installed: '✔', blocked: '✘', 'needs-ack': '⚠', error: '✘' }[o.status];
  const t = m().ext;
  const head = {
    installed: t.installed(o.dest ?? ''),
    blocked: t.blocked,
    'needs-ack': t.needsAck,
    error: t.error,
  }[o.status];
  return [`${icon} ${o.name}: ${head} (${o.reason})`, ...formatScan(o.scan)];
}

/** `anafor ext` yardımı (geçerli dilde). */
const help = () => m().ext.help;

/** `anafor ext …` (çıktı satırları + çıkış kodu). */
export function runExt(root: string, args: string[]): { lines: string[]; code: number } {
  const [sub, ...rest] = args;
  const flag = (n: string) => {
    const i = rest.indexOf(`--${n}`);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  const has = (n: string) => rest.includes(`--${n}`);
  const scope = has('user') ? ('user' as const) : ('project' as const);

  if (sub === 'check') {
    const all = checkExtensions(root);
    if (!all.length) return { lines: [m().ext.noneInstalled], code: 0 };
    const lines = all.map(
      (e) =>
        `${e.status === 'ok' ? '✔' : '⚠'} ${e.kind.padEnd(5)} ${e.scope.padEnd(7)} ${e.name.padEnd(24)} ${e.status}`,
    );
    const bad = all.filter((e) => e.status !== 'ok');
    if (bad.length) lines.push('', m().ext.blockedCount(bad.length));
    return { lines, code: bad.length ? 1 : 0 };
  }
  if (sub === 'list') {
    const all = [...readRegistry('project', root), ...readRegistry('user', root)];
    if (!all.length) return { lines: [m().ext.noneRegistered], code: 0 };
    return {
      lines: all.map(
        (e) =>
          `${e.kind.padEnd(5)} ${e.scope.padEnd(7)} ${e.name.padEnd(24)} ${m().ext.score} ${e.score} ${e.recommendation}${e.decision === 'accepted-risk' ? m().ext.riskAccepted : ''} · ${e.scanned_at.slice(0, 10)} · ${e.source}`,
      ),
      code: 0,
    };
  }
  if (sub === 'remove') {
    const name = rest.find((a) => !a.startsWith('--'));
    if (!name) return { lines: [help()], code: 2 };
    const ok = removeEntry(root, scope, has('mcp') ? 'mcp' : 'skill', name);
    return { lines: [ok ? m().ext.removed(name) : m().ext.notFound(name)], code: ok ? 0 : 1 };
  }
  if (sub === 'add' || sub === 'adopt' || sub === 'add-mcp') {
    const bin = findSkillspector(loadConfig(root).extensions.skillspector_bin);
    if (!bin) return { lines: [kurulum()], code: 2 };
    const acceptRisk = has('accept-risk');
    let out: GateOutcome;
    if (sub === 'add') {
      const src = rest.find(
        (a, i) => !a.startsWith('--') && !['--path', '--name'].includes(rest[i - 1] ?? ''),
      );
      if (!src) return { lines: [help()], code: 2 };
      const subpath = flag('path');
      const name = flag('name');
      out = addSkill(root, src, {
        bin,
        acceptRisk,
        scope,
        ...(subpath ? { subpath } : {}),
        ...(name ? { name } : {}),
      });
    } else if (sub === 'adopt') {
      const name = rest.find((a) => !a.startsWith('--'));
      if (!name) return { lines: [help()], code: 2 };
      out = adoptSkill(root, name, { bin, acceptRisk, scope });
    } else {
      const dd = rest.indexOf('--');
      const name = rest[0];
      const source = flag('source');
      if (!name || name.startsWith('--') || !source || dd < 0) return { lines: [help()], code: 2 };
      out = addMcp(root, name, rest.slice(dd + 1), source, { bin, acceptRisk });
    }
    return { lines: formatOutcome(out), code: out.status === 'installed' ? 0 : 1 };
  }
  return { lines: [help()], code: sub ? 2 : 0 };
}
