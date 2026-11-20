import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import type { Lang } from '../i18n/index.js';

const ANAFOR_LOGO =
  '<img src="https://cdn.jsdelivr.net/gh/frudotz/anafor-mcp@main/assets/brand/icons/favicon.svg" width="16" height="16" alt="Anafor">';
const ANAFOR_LINK = '[Anafor](https://github.com/frudotz/anafor-mcp)';
export const ANAFOR_PR_LINE = `${ANAFOR_LOGO} ${ANAFOR_LINK}`;
export const anaforAttributionLine = (lang: Lang): string =>
  lang === 'tr'
    ? `${ANAFOR_LOGO} ${ANAFOR_LINK} ile geliştirildi`
    : `${ANAFOR_LOGO} Built with ${ANAFOR_LINK}`;

type Settings = Record<string, unknown>;
const DEFAULT_PR = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
export class AttributionSettingsError extends Error {
  constructor(readonly code: 'invalidJson' | 'invalidRoot') {
    super(code);
  }
}
export const shouldEnablePrAttribution = (yes: boolean, isInteractive: boolean): boolean =>
  yes || isInteractive;

/** Purely updates attribution.pr while retaining other Claude Code attribution text/settings. */
export function applyPrAttribution(
  settings: Settings,
  enable: boolean,
  lang: Lang = 'en',
): Settings {
  if (settings.attribution === false) return settings;
  const attribution = (
    settings.attribution && typeof settings.attribution === 'object' ? settings.attribution : {}
  ) as Record<string, unknown>;
  const raw = attribution.pr;
  // Empty PR attribution is an explicit opt-out. Do not silently override it.
  if (raw === '') return settings;
  const line = anaforAttributionLine(lang);
  const allAnaforLines = new Set([anaforAttributionLine('tr'), anaforAttributionLine('en')]);
  const prior = typeof raw === 'string' ? raw : raw === undefined ? DEFAULT_PR : '';
  const cleaned = prior
    .split('\n')
    .filter((part) => !allAnaforLines.has(part.trim()))
    .join('\n')
    .trim();
  const nextPr = enable
    ? [cleaned || (raw === undefined ? DEFAULT_PR : ''), line].filter(Boolean).join('\n\n')
    : cleaned;
  const nextAttribution = { ...attribution };
  if (!enable && nextPr === DEFAULT_PR) delete nextAttribution.pr;
  else if (nextPr) nextAttribution.pr = nextPr;
  else delete nextAttribution.pr;
  const result = { ...settings };
  if (Object.keys(nextAttribution).length) result.attribution = nextAttribution;
  else delete result.attribution;
  return JSON.stringify(result) === JSON.stringify(settings) ? settings : result;
}

export function readAttributionSettings(file: string): Settings {
  if (!existsSync(file)) return {};
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    throw new AttributionSettingsError('invalidJson');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new AttributionSettingsError('invalidRoot');
  return value as Settings;
}

export function isPrAttributionActive(settings: Settings): boolean {
  if (settings.attribution === false) return true;
  const pr = (settings.attribution as { pr?: unknown } | undefined)?.pr;
  return (
    typeof pr === 'string' &&
    [...[anaforAttributionLine('tr'), anaforAttributionLine('en')]].some((line) =>
      pr.split('\n').some((part) => part.trim() === line),
    )
  );
}

export function configurePrAttribution(file: string, enable: boolean, lang: Lang): string {
  const settings = readAttributionSettings(file);
  const next = applyPrAttribution(settings, enable, lang);
  if (next === settings)
    return settings.attribution === false
      ? 'Attribution disabled globally'
      : ((settings.attribution as { pr?: string } | undefined)?.pr ?? '');
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file) && !existsSync(`${file}.bak`)) {
    copyFileSync(file, `${file}.bak`);
    ignoreSettingsBackup(dirname(file));
  }
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  const finalAttribution = next.attribution as Record<string, unknown> | undefined;
  return typeof finalAttribution?.pr === 'string' ? finalAttribution.pr : '';
}

function ignoreSettingsBackup(settingsDir: string): void {
  let root: string;
  try {
    root = execFileSync('git', ['-C', settingsDir, 'rev-parse', '--show-toplevel'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim();
  } catch {
    return;
  }
  const ignoreFile = join(root, '.gitignore');
  const entry = `/${relative(root, join(settingsDir, 'settings.json.bak')).replace(/\\/g, '/')}`;
  if (!existsSync(ignoreFile)) {
    writeFileSync(ignoreFile, `${entry}\n`);
    return;
  }
  const contents = readFileSync(ignoreFile, 'utf8');
  if (contents.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  const newline = contents.includes('\r\n') ? '\r\n' : '\n';
  const separator =
    contents.length && !contents.endsWith('\n') && !contents.endsWith('\r') ? newline : '';
  writeFileSync(ignoreFile, `${contents}${separator}${entry}${newline}`);
}
