import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith('.ts') ? [path] : [];
  });

const processFns = new Set([
  'spawn',
  'spawnSync',
  'execFile',
  'execFileSync',
  'exec',
  'execSync',
  'fork',
]);

// Mask comments and literals while retaining source offsets and punctuation for balanced calls.
function maskTriviaAndLiterals(source: string): string {
  return source.replace(
    /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*)/g,
    (match) => match.replace(/[^\r\n]/g, ' '),
  );
}

function matchingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '(') depth++;
    if (source[i] === ')' && --depth === 0) return i;
  }
  return -1;
}

describe('Windows child process visibility', () => {
  it('sets windowsHide on every child_process call in src', () => {
    const violations: string[] = [];
    let scannedCalls = 0;
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const raw = readFileSync(file, 'utf8');
      const code = maskTriviaAndLiterals(raw);
      const aliases = new Set<string>();
      const imports = [
        ...raw.matchAll(
          /(?:import\s+([\s\S]*?)\s+from\s*|require\s*\(|import\s*\()\s*(['"])(node:)?child_process\2/g,
        ),
      ];
      for (const match of imports) {
        const clause = match[1]?.trim();
        if (!clause) {
          // require/import() forms are handled by inspecting references through assigned bindings below.
          const before = raw.slice(0, match.index);
          const assignment = before.match(/(?:const|let|var)\s+([\w$]+)\s*=\s*$/);
          if (assignment) aliases.add(`${assignment[1]}.`);
          else violations.push(`${file}: unrecognized child_process require/import form`);
        } else if (clause.startsWith('*')) {
          const namespace = clause.match(/^\*\s+as\s+([\w$]+)/)?.[1];
          if (namespace) aliases.add(`${namespace}.`);
          else violations.push(`${file}: unrecognized child_process namespace import`);
        } else {
          const named = clause.match(/\{([^}]+)\}/)?.[1];
          if (named) {
            for (const item of named.split(',')) {
              const [original, alias] = item.trim().split(/\s+as\s+/);
              if (processFns.has(original!)) aliases.add(alias ?? original!);
            }
          }
          const defaultName = clause.match(/^([\w$]+)/)?.[1];
          if (defaultName) aliases.add(`${defaultName}.`);
        }
      }
      for (const alias of aliases) {
        const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        for (const match of code.matchAll(
          new RegExp(
            `\\b${escaped}(${[...processFns].join('|')})\\s*\\(|\\b${escaped}\\s*\\(`,
            'g',
          ),
        )) {
          const name = match[1] ?? (alias.endsWith('.') ? '' : alias);
          if (alias.endsWith('.') && !processFns.has(name)) continue;
          const open = code.indexOf('(', match.index!);
          const close = matchingParen(code, open);
          scannedCalls++;
          if (close < 0 || !/windowsHide\s*:\s*true/.test(code.slice(open + 1, close))) {
            const line = raw.slice(0, match.index).split('\n').length;
            violations.push(`${file}:${line} ${name || alias}`);
          }
        }
      }
      // Any child_process source reference must match a recognized static import form.
      if (/child_process/.test(raw) && imports.length === 0)
        violations.push(`${file}: unrecognized child_process import form`);
    }
    expect(scannedCalls).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });
});
