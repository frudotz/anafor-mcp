import { realpathSync } from 'node:fs';
import { basename, isAbsolute, matchesGlob, posix, relative, resolve, win32 } from 'node:path';
import { loadConfig, resolveProjectRoot, type AnaforConfig } from '../core/config.js';
import { extensionGuard } from '../extensions/guard.js';
import { activeGrants, recordViolation, type Grant } from './grants.js';
import { m } from '../i18n/index.js';
import type { Messages } from '../i18n/tr.js';

/** Claude Code PreToolUse hook girdisinin kullandığımız alanları (F0'da doğrulandı). */
export interface PreToolUseInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  session_id?: string;
}

export type Decision =
  | { action: 'allow'; reason?: string }
  | { action: 'deny'; reason: string }
  | { action: 'warn'; reason: string };

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

// Dosya değiştiren shell desenleri (sezgisel; amaç disiplin, güvenlik değil).
type Why = keyof Messages['director']['why'];
const FS_COMMAND_PATTERN =
  /(^|[\s;&|(])(rm|rmdir|mv|cp|mkdir|touch|tee|truncate|ln|chmod|chown|dd|install)\s/;
const FS_COMMAND_EXCEPT_INSTALL =
  /(^|[\s;&|(])(rm|rmdir|mv|cp|mkdir|touch|tee|truncate|ln|chmod|chown|dd)\s/;
const INSTALL_COMMAND = /(^|[\s;&|(])install\s/;
const MUTATING_PATTERNS: [RegExp, Why][] = [
  [
    /(^|[^0-9&>=(-])(?:[0-9]+)?\s*>{1,2}(?!\s*&)(?!\s*\/dev\/null)(?!\s*\$null)(?!\s*nul\b)\s*[^\s|&;)]+/i,
    'redirect',
  ],
  [/[;(]\s*>{1,2}(?!\s*&)(?!\s*\/dev\/null)(?!\s*\$null)(?!\s*nul\b)\s*[^\s|&;)]+/i, 'redirect'],
  [FS_COMMAND_PATTERN, 'fsCommand'],
  [/\bfind\b.*(?:\.\.|-delete)/i, 'fsCommand'],
  [/(^|[\s;&|(])(sed|perl)\s+[^|;&]*-i\b/, 'inPlace'],
  [
    /(^|[\s;&|(])git\s+(apply\b|am\b|checkout\s+--(\s|$)|restore\b|clean\b|stash\s+(pop|apply)\b)/,
    'gitMutation',
  ],
  [/\bgit\s+-C\s+\S+\s+(apply\b|am\b|restore\b|clean\b)/, 'gitMutation'],
  [
    /\b(?:bash|sh|zsh|pwsh|powershell|cmd|node|python|perl|ruby)\s+(?:-c|-e|-command|-encodedcommand|\/c)\b.*(?:sed\s+.*-i\b|\b(?:rm|mv|cp|touch|tee|dd)\s|writeFileSync|open\()/i,
    'scriptWrite',
  ],
  [
    /\b(Set-Content|Add-Content|Out-File|New-Item|Remove-Item|Move-Item|Copy-Item|Rename-Item|Clear-Content)\b/i,
    'psCmdlet',
  ],
  [/\[(System\.)?IO\.File\]::(Write|Append|Delete|Move|Copy)/i, 'dotnetWrite'],
  [/\bwriteFileSync|appendFileSync|rmSync|unlinkSync|renameSync\b/, 'scriptWrite'],
  [/\bopen\([^)]*['"][wa]\+?['"]/, 'scriptWrite'],
];

const COMMAND_START = String.raw`(?:^|[\s;&|("'\x60])`;
const COMMAND_PREAMBLE = String.raw`(?:(?:env\s+)?(?:[A-Za-z_]\w*=\S+\s+)*)(?:(?:sudo|command|exec)\s+)*`;
const EXECUTABLE_PATH = String.raw`(?:[A-Za-z]:)?(?:[^\s;&|()"'\x60]*[\\/])?`;
const PACKAGE_MANAGER_NAME = String.raw`(?:npm|pnpm|yarn|bun)(?:\.cmd|\.exe)?`;
const PACKAGE_MANAGER_PREFIX = `${COMMAND_START}${COMMAND_PREAMBLE}${EXECUTABLE_PATH}${PACKAGE_MANAGER_NAME}`;
const PACKAGE_MANAGER_FLAGS = String.raw`(?:\s+--?[A-Za-z][\w-]*(?:=\S+)?(?:\s+\S+)?)*`;
const PACKAGE_MANAGER_ACTION = String.raw`(?:install|i|add|remove|rm|uninstall|un|update|up|upgrade|link)`;
const PIP_FLAGS = String.raw`(?:--?[A-Za-z][\w-]*(?:=\S+)?(?:\s+\S+)?\s+)*`;
const PIP_NAME = String.raw`(?:pip(?:3(?:\.\d+)?)?|python(?:3(?:\.\d+)?)?|py)(?:\.exe)?`;
const COMMAND_HEAD = `${COMMAND_START}${COMMAND_PREAMBLE}${EXECUTABLE_PATH}`;
const PACKAGE_MANAGER = new RegExp(
  [
    `${PACKAGE_MANAGER_PREFIX}${PACKAGE_MANAGER_FLAGS}\\s+(?:global\\s+)?${PACKAGE_MANAGER_ACTION}\\b`,
    `${COMMAND_HEAD}${PIP_NAME}\\s+-m\\s+pip\\s+${PIP_FLAGS}(?:install|uninstall)\\b`,
    `${COMMAND_HEAD}pip(?:3(?:\\.\\d+)?)?(?:\\.exe)?\\s+${PIP_FLAGS}(?:install|uninstall)\\b`,
    `${COMMAND_HEAD}(?:brew|apt-get|apt|dnf|yum|pacman|winget|choco|scoop|cargo|go|gem)(?:\\.exe)?\\s+(?:install|-S)\\b`,
  ].join('|'),
  'i',
);
const GLOBAL_PACKAGE_ACTION = String.raw`(?:global\s+${PACKAGE_MANAGER_ACTION}|${PACKAGE_MANAGER_ACTION})`;
const GLOBAL_PACKAGE_MARKER = String.raw`(?:-[a-zA-Z]*g[a-zA-Z]*\b|--global\b|--location(?:=|\s+)global\b)`;
const GLOBAL_PACKAGE_INSTALL = new RegExp(
  [
    `${PACKAGE_MANAGER_PREFIX}(?=[^;&|()]*\\s${GLOBAL_PACKAGE_MARKER})[^;&|()]*\\b${GLOBAL_PACKAGE_ACTION}\\b`,
    `${COMMAND_HEAD}yarn(?:\\.cmd|\\.exe)?\\s+global\\s+${PACKAGE_MANAGER_ACTION}\\b`,
    `${COMMAND_HEAD}npm(?:\\.cmd|\\.exe)?\\s+link\\s*(?:-[A-Za-z]*g[A-Za-z]*|--global)?\\s*$`,
    `\\bnpm_config_global\\s*=`,
  ].join('|'),
  'i',
);
const GLOBAL_PIP_INSTALL = new RegExp(
  `${COMMAND_START}${COMMAND_PREAMBLE}${EXECUTABLE_PATH}${PIP_NAME}(?:\\s+-m\\s+pip)?\\s+${PIP_FLAGS}(?:install|uninstall)\\b`,
  'i',
);
const VENV_PIP_INSTALL = new RegExp(
  `${COMMAND_START}[^\\s;&|()"'\\x60]*?(?:\\.venv|venv|env)[\\\\/](?:bin[\\\\/]pip(?:3(?:\\.\\d+)?)?|Scripts[\\\\/]pip(?:3(?:\\.\\d+)?)?)(?:\\.exe)?\\s+${PIP_FLAGS}(?:install|uninstall)\\b`,
  'i',
);
const GLOBAL_SYSTEM_INSTALL = new RegExp(
  `${COMMAND_START}${COMMAND_PREAMBLE}${EXECUTABLE_PATH}(?:brew|apt-get|apt|dnf|yum|pacman|winget|choco|scoop)(?:\\.exe)?\\s+(?:install|-S)\\b|${COMMAND_START}${COMMAND_PREAMBLE}${EXECUTABLE_PATH}(?:cargo|go|gem)(?:\\.exe)?\\s+install\\b`,
  'i',
);

const INTERPRETER_COMMAND =
  /(?:^|[\s;&|(])(?:bash|sh|zsh)\s+-c\b|(?:^|[\s;&|(])(?:pwsh|powershell)\s+(?:-c\b|-command\b)|(?:^|[\s;&|(])cmd\s+\/c\b|(?:^|[\s;&|(])eval\b|(?:^|[\s;&|(])(?:node\s+-e|python\s+-c)\b/i;

function shellCandidate(command: string): string {
  return stripQuotedAndHeredoc(command, !INTERPRETER_COMMAND.test(command));
}

function packageRuleCandidate(command: string): string {
  return stripQuotedContent(command, !INTERPRETER_COMMAND.test(command));
}

function isMachineWideInstall(candidate: string): boolean {
  return candidate.split(/(?:&&|\|\||[;|\n])/).some((segment) => {
    if (VENV_PIP_INSTALL.test(segment)) return false;
    return (
      (GLOBAL_PACKAGE_INSTALL.test(segment) &&
        (PACKAGE_MANAGER.test(segment) || /\bnpm_config_global\s*=/i.test(segment))) ||
      GLOBAL_PIP_INSTALL.test(segment) ||
      GLOBAL_SYSTEM_INSTALL.test(segment)
    );
  });
}

/** Shell komutu dosya değiştiriyor mu? Değiştiriyorsa neden döner. */
function classifyCandidate(candidate: string, packageCandidate = candidate): string | null {
  if (PACKAGE_MANAGER.test(packageCandidate)) return m().director.why.pkgManager;
  for (const [re, why] of MUTATING_PATTERNS) {
    if (re === FS_COMMAND_PATTERN) {
      if (
        FS_COMMAND_EXCEPT_INSTALL.test(candidate) ||
        (INSTALL_COMMAND.test(candidate) && INSTALL_COMMAND.test(packageCandidate))
      )
        return m().director.why[why];
    } else if (re.test(candidate)) return m().director.why[why];
  }
  return null;
}

export function classifyShell(command: string): string | null {
  return classifyCandidate(shellCandidate(command), packageRuleCandidate(command));
}

function quotedEnd(text: string, start: number, quote: string): number {
  for (let i = start + 1; i < text.length; i++) {
    if (quote === '"' && text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === quote) return i + 1;
  }
  return text.length;
}

function backtickEnd(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === '\\') {
      i++;
      continue;
    }
    if (text[i] === '`') return i + 1;
  }
  return text.length;
}

function commandSubstitutionEnd(text: string, start: number): number {
  let depth = 1;
  for (let i = start + 2; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === "'" || ch === '"') {
      i = quotedEnd(text, i, ch) - 1;
      continue;
    }
    if (ch === '`') {
      i = backtickEnd(text, i) - 1;
      continue;
    }
    if (ch === '$' && text[i + 1] === '(') {
      i = commandSubstitutionEnd(text, i) - 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i + 1;
  }
  return text.length;
}

function stripQuotedContent(command: string, stripQuotes = true): string {
  if (!stripQuotes) return command;
  let output = '';
  for (let i = 0; i < command.length;) {
    const ch = command[i];
    if (ch === "'") {
      i = quotedEnd(command, i, ch);
      continue;
    }
    if (ch === '"') {
      const end = quotedEnd(command, i, ch);
      let inner = '';
      for (let j = i + 1; j < end - 1;) {
        if (command[j] === '\\') {
          j += 2;
          continue;
        }
        if (command[j] === '$' && command[j + 1] === '(') {
          const subEnd = commandSubstitutionEnd(command, j);
          inner += `$(${stripQuotedContent(command.slice(j + 2, subEnd - 1))})`;
          j = subEnd;
          continue;
        }
        if (command[j] === '`') {
          const subEnd = backtickEnd(command, j);
          inner += `\`${stripQuotedContent(command.slice(j + 1, subEnd - 1))}\``;
          j = subEnd;
          continue;
        }
        j++;
      }
      output += inner;
      i = end;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      const end = commandSubstitutionEnd(command, i);
      output += `$(${stripQuotedContent(command.slice(i + 2, end - 1))})`;
      i = end;
      continue;
    }
    if (ch === '`') {
      const end = backtickEnd(command, i);
      output += `\`${stripQuotedContent(command.slice(i + 1, end - 1))}\``;
      i = end;
      continue;
    }
    output += ch;
    i++;
  }
  return output;
}

/** Removes non-command text while preserving shell syntax that can execute substitutions. */
export function stripQuotedAndHeredoc(command: string, stripQuotes = true): string {
  const lines = command.split(/\r?\n/);
  let text = '';
  let heredoc: { delimiter: string; stripTabs: boolean } | null = null;
  for (const line of lines) {
    if (heredoc) {
      const end = heredoc.stripTabs ? line.replace(/^\t+/, '') : line;
      if (end.trimEnd() === heredoc.delimiter) heredoc = null;
      text += line.replace(/>/g, ' ') + '\n';
      continue;
    }
    let out = '';
    for (let i = 0; i < line.length;) {
      if (line.startsWith('<<', i)) {
        const match = line.slice(i).match(/^<<(-?)[ \t]*(['"]?)([\w.-]+)\2/);
        if (match) heredoc = { delimiter: match[3] ?? '', stripTabs: match[1] === '-' };
      }
      const ch = line[i];
      if (stripQuotes && ch === "'") {
        const end = line.indexOf("'", i + 1);
        if (end >= 0) {
          out += line.slice(i + 1, end).replace(/>/g, ' ');
          i = end + 1;
          continue;
        }
      } else if (stripQuotes && ch === '"') {
        let end = i + 1;
        while (end < line.length && line[end] !== '"') end++;
        if (end < line.length) {
          const value = line.slice(i + 1, end);
          if (!value.includes('$(') && !value.includes('`')) {
            out += value.replace(/>/g, ' ');
            i = end + 1;
            continue;
          }
        }
      }
      out += ch;
      i++;
    }
    text += out + '\n';
  }
  return text;
}

function toRel(root: string, cwd: string, p: string): string | null {
  const abs = isAbsolute(p) ? p : resolve(cwd, p);
  const rel = relative(root, abs).replace(/\\/g, '/');
  if (rel.startsWith('..') || isAbsolute(rel)) return null; // proje dışı
  return rel;
}

/** win32.isAbsolute('/tmp') de true döner; Windows yolu yalnız sürücü harfi veya UNC ile tanınır. */
const isWindowsPath = (p: string): boolean => /^[a-z]:[\\/]/i.test(p) || p.startsWith('\\\\');

function shellPath(cwd: string, value: string, windows = isWindowsPath(cwd)): string {
  let path = value.replace(/^("|')(.*)\1$/, '$2');
  if (windows) {
    const gitBash = path.match(/^\/([a-z])\/(.*)$/i) ?? path.match(/^\/mnt\/([a-z])\/(.*)$/i);
    if (gitBash) path = (gitBash[1] ?? '').toUpperCase() + ':/' + (gitBash[2] ?? '');
    return win32.resolve(cwd, path);
  }
  return posix.resolve(cwd, path);
}

function insidePath(base: string, candidate: string, windows: boolean): boolean {
  const api = windows ? win32 : posix;
  const rel = api.relative(api.resolve(base), api.resolve(candidate));
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith('..' + (windows ? '\\' : '/')) && !api.isAbsolute(rel))
  );
}

function safeOutsideShell(command: string, cwd: string, root: string): boolean {
  const match = command.match(/^\s*cd\s+(?:\/d\s+)?("[^"]*"|'[^']*'|[^\s;&|]+)\s+&&\s*(.+)$/is);
  const windows = isWindowsPath(root);
  let effective = cwd;
  let rest = command;
  if (match) {
    const raw = match[1] ?? '';
    const literal = raw.replace(/^("|')(.*)\1$/, '$2');
    if (
      /[\$~%*?\[\]]/.test(literal) ||
      literal === '-' ||
      literal.includes(String.fromCharCode(96)) ||
      /["']/.test(literal) ||
      (!windows && literal.includes('\\'))
    )
      return false;
    effective = shellPath(cwd, raw, windows);
    rest = match[2] ?? '';
  }
  const lower = rest.toLowerCase();
  if (
    /\.\.|[$%~*?{};|()[\]]/.test(rest) ||
    rest.includes(String.fromCharCode(96)) ||
    (!windows && rest.includes('\\'))
  )
    return false;
  if (/\b(?:cd|pushd|popd)\b|\bgit\s+-c\b|--git-dir|--work-tree/.test(lower)) return false;
  if (
    /\b(?:bash|sh|zsh|pwsh|powershell|cmd|node|python|perl|ruby)\s+(?:-c|-e|-command|-encodedcommand|\/c)\b/i.test(
      rest,
    )
  )
    return false;
  if (/\brm\s+-rf\b|\bfind\s+.*\.\./i.test(rest)) return false;
  let realEffective: string;
  try {
    realEffective = realpathSync(effective);
  } catch {
    return false;
  }
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    // Keep lexical comparison for roots that are not present in isolated hook inputs.
  }
  if (insidePath(realRoot, realEffective, windows) || insidePath(realEffective, realRoot, windows))
    return false;
  const unquotedRest = rest
    .replace(/["']/g, '')
    .replace(new RegExp(String.fromCharCode(96), 'g'), '');
  const normalized = unquotedRest.replace(/\\/g, '/').toLowerCase();
  const api = windows ? win32 : posix;
  const normalizedRoot = api.resolve(realRoot).replace(/\\/g, '/').toLowerCase();
  const rootBase = api.basename(root).toLowerCase();
  const drive = windows ? normalizedRoot.slice(0, 2) : '';
  const rootTail = windows ? normalizedRoot.slice(2) : normalizedRoot;
  const gitBashRoot = windows ? '/' + drive[0]?.toLowerCase() + rootTail : '';
  const mntRoot = windows ? '/mnt/' + drive[0]?.toLowerCase() + rootTail : '';
  if (
    (rootBase.length >= 4 && normalized.includes(rootBase)) ||
    normalized.includes(normalizedRoot) ||
    (gitBashRoot && normalized.includes(gitBashRoot)) ||
    (mntRoot && normalized.includes(mntRoot))
  )
    return false;
  const quotedTokens = rest.match(/"[^"\n]*"|'[^'\n]*'|[^\s]+/g) ?? [];
  const absolutePaths = [
    ...(unquotedRest.match(/(?:[a-z]:[^\s]+|\\\\[^\s]+|\/[^\s]+)/gi) ?? []),
    ...(normalized.match(/(?:[a-z]:[^\s]+|\/[^\s]+)/gi) ?? []),
    ...quotedTokens.flatMap((token) => {
      const value = token.replace(/^(["'])(.*)\1$/, '$2');
      return value.match(/(?:[a-z]:[\\/].+|\\\\.+|\/.+)/i) ?? [];
    }),
  ];
  for (const path of absolutePaths) {
    const candidate = shellPath(realEffective, path, windows);
    if (insidePath(realRoot, candidate, windows) || insidePath(candidate, realRoot, windows))
      return false;
  }
  return true;
}

const matchAny = (rel: string, globs: string[]) => globs.some((g) => matchesGlob(rel, g));

const DENY_MESSAGE = (what: string) => m().director.deny(what);

/**
 * Yönetici disiplini kararı. Saf fonksiyon: dosya sistemi yalnızca config/izin okumak için.
 */
export function decide(
  input: PreToolUseInput,
  ctx: { root: string; config: AnaforConfig; grants: Grant[] },
): Decision {
  const tool = input.tool_name ?? '';
  const cwd = input.cwd ?? ctx.root;
  const ti = input.tool_input ?? {};
  if (ctx.config.director_mode === 'off') return { action: 'allow' };
  const verdict = (reason: string): Decision =>
    ctx.config.director_mode === 'warn' ? { action: 'warn', reason } : { action: 'deny', reason };

  if (EDIT_TOOLS.has(tool)) {
    const p = String(ti.file_path ?? ti.notebook_path ?? '');
    if (!p) return { action: 'allow' };
    const rel = toRel(ctx.root, cwd, p);
    if (rel === null) return { action: 'allow', reason: m().director.outside };
    const inWorktree = rel.startsWith('.anafor/worktrees/') && !rel.endsWith('.md');
    if (!inWorktree && matchAny(rel, ctx.config.allow_paths))
      return { action: 'allow', reason: m().director.allowedPath };
    const g = ctx.grants.find((x) => matchAny(rel, x.paths));
    if (g) return { action: 'allow', reason: m().director.grant(g.grant_id) };
    return verdict(DENY_MESSAGE(m().director.editForbidden(rel)));
  }

  if (SHELL_TOOLS.has(tool)) {
    const cmd = String(ti.command ?? '');
    const candidate = shellCandidate(cmd);
    const packageCandidate = packageRuleCandidate(cmd);
    const why = classifyCandidate(candidate, packageCandidate);
    if (!why) return { action: 'allow' };
    if (why === m().director.why.pkgManager && isMachineWideInstall(packageCandidate)) {
      if (ctx.grants.length > 0) return { action: 'allow', reason: m().director.activeGrant };
      return verdict(DENY_MESSAGE(m().director.globalPackageInstall));
    }
    if (safeOutsideShell(cmd, cwd, ctx.root))
      return { action: 'allow', reason: m().director.outside };
    if (ctx.grants.length > 0) return { action: 'allow', reason: m().director.activeGrant };
    return verdict(DENY_MESSAGE(m().director.shellForbidden(why)));
  }

  return { action: 'allow' };
}

/** Hook giriş noktası: girdiyi değerlendirir, Claude Code'un beklediği çıktıyı üretir. */
export function runPreToolUse(
  input: PreToolUseInput,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (env.ANAFOR_WORKER === '1') return ''; // işçi süreci: yönetici kuralı uygulanmaz
  const resolved = resolveProjectRoot(env, input.cwd ?? process.cwd());
  if (!resolved.initialized) return ''; // Anafor projesi değil
  const root = resolved.root;
  const config = loadConfig(root);
  // Eklenti kapısı yönetici modundan bağımsız uygulanır (F23).
  const g = extensionGuard(input, { root, config });
  const d =
    g && g.action !== 'allow' ? g : decide(input, { root, config, grants: activeGrants(root) });
  if (d.action === 'allow') return '';
  recordViolation(root, {
    tool: input.tool_name,
    mode: config.director_mode,
    action: d.action,
    reason: d.reason,
    session_id: input.session_id ?? null,
  });
  if (d.action === 'warn') return '';
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: d.reason,
    },
  });
}
