import { loadConfig } from '../core/config.js';
import { addMcp, addSkill, adoptSkill, type GateOutcome } from '../extensions/gate.js';
import { checkExtensions, readRegistry, removeEntry } from '../extensions/registry.js';
import { findSkillspector, type ScanResult } from '../extensions/skillspector.js';

const KURULUM =
  'SkillSpector bulunamadı. Kurulum (Python 3.12/3.13): `py -3.13 -m venv ~/.anafor/tools/skillspector` ve `~/.anafor/tools/skillspector/Scripts/python -m pip install git+https://github.com/NVIDIA/skillspector.git` (Linux/macOS: bin/python), ya da `uv tool install --python 3.13 git+https://github.com/NVIDIA/skillspector.git`. Özel yol: anafor.config.json → extensions.skillspector_bin';

export function formatScan(scan?: ScanResult): string[] {
  if (!scan) return [];
  if (!scan.ok) return [`  tarama: ${scan.error}`];
  const counts = Object.entries(scan.counts)
    .map(([k, v]) => `${k} ${v}`)
    .join(', ');
  return [
    `  SkillSpector (${scan.scanner}): skor ${scan.score} · ${scan.severity} · ${scan.recommendation}${counts ? ` · ${counts}` : ''}`,
    ...scan.top.map(
      (i) => `   - [${i.severity}] ${i.rule} ${i.title}${i.file ? ` (${i.file})` : ''}`,
    ),
  ];
}

export function formatOutcome(o: GateOutcome): string[] {
  const icon = { installed: '✔', blocked: '✘', 'needs-ack': '⚠', error: '✘' }[o.status];
  const head = {
    installed: `kuruldu: ${o.dest ?? ''}`,
    blocked: 'ENGELLENDİ',
    'needs-ack': 'onay gerekiyor',
    error: 'hata',
  }[o.status];
  return [`${icon} ${o.name}: ${head} (${o.reason})`, ...formatScan(o.scan)];
}

const HELP = `kullanım:
  anafor ext check                        kurulu skill/MCP'lerin tarama ve kayıt durumu
  anafor ext list                         kayıtlı eklentiler
  anafor ext add <dizin|git-url> [--path alt/dizin] [--name ad] [--user] [--accept-risk]
                                          skill'i SkillSpector ile tarar, geçerse kurar
  anafor ext add-mcp <ad> --source <dizin|git-url> [--accept-risk] -- <komut> [arg…]
                                          MCP sunucusunun kaynağını tarar, geçerse .mcp.json'a ekler
  anafor ext adopt <ad> [--user] [--accept-risk]
                                          zaten kurulu bir skill'i yerinde tarar ve kaydeder
  anafor ext remove <ad> [--user] [--mcp] kaydı siler (dosyalara dokunmaz)
Politika: HIGH/CRITICAL ve tarama hatası engellenir; CAUTION yalnızca --accept-risk ile (kullanıcı onayı).`;

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
    if (!all.length) return { lines: ['Kurulu yerel skill veya proje MCP sunucusu yok.'], code: 0 };
    const lines = all.map(
      (e) =>
        `${e.status === 'ok' ? '✔' : '⚠'} ${e.kind.padEnd(5)} ${e.scope.padEnd(7)} ${e.name.padEnd(24)} ${e.status}`,
    );
    const bad = all.filter((e) => e.status !== 'ok');
    if (bad.length)
      lines.push(
        '',
        `${bad.length} eklenti engelli. Skill için: anafor ext adopt <ad> [--user]; MCP için: anafor ext add-mcp … ile yeniden ekleyin.`,
      );
    return { lines, code: bad.length ? 1 : 0 };
  }
  if (sub === 'list') {
    const all = [...readRegistry('project', root), ...readRegistry('user', root)];
    if (!all.length) return { lines: ['Kayıtlı eklenti yok.'], code: 0 };
    return {
      lines: all.map(
        (e) =>
          `${e.kind.padEnd(5)} ${e.scope.padEnd(7)} ${e.name.padEnd(24)} skor ${e.score} ${e.recommendation}${e.decision === 'accepted-risk' ? ' (risk onaylı)' : ''} · ${e.scanned_at.slice(0, 10)} · ${e.source}`,
      ),
      code: 0,
    };
  }
  if (sub === 'remove') {
    const name = rest.find((a) => !a.startsWith('--'));
    if (!name) return { lines: [HELP], code: 2 };
    const ok = removeEntry(root, scope, has('mcp') ? 'mcp' : 'skill', name);
    return { lines: [ok ? `${name}: kayıt silindi` : `${name}: kayıt yok`], code: ok ? 0 : 1 };
  }
  if (sub === 'add' || sub === 'adopt' || sub === 'add-mcp') {
    const bin = findSkillspector(loadConfig(root).extensions.skillspector_bin);
    if (!bin) return { lines: [KURULUM], code: 2 };
    const acceptRisk = has('accept-risk');
    let out: GateOutcome;
    if (sub === 'add') {
      const src = rest.find(
        (a, i) => !a.startsWith('--') && !['--path', '--name'].includes(rest[i - 1] ?? ''),
      );
      if (!src) return { lines: [HELP], code: 2 };
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
      if (!name) return { lines: [HELP], code: 2 };
      out = adoptSkill(root, name, { bin, acceptRisk, scope });
    } else {
      const dd = rest.indexOf('--');
      const name = rest[0];
      const source = flag('source');
      if (!name || name.startsWith('--') || !source || dd < 0) return { lines: [HELP], code: 2 };
      out = addMcp(root, name, rest.slice(dd + 1), source, { bin, acceptRisk });
    }
    return { lines: formatOutcome(out), code: out.status === 'installed' ? 0 : 1 };
  }
  return { lines: [HELP], code: sub ? 2 : 0 };
}
