import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounds, width, height, centerX } from './geometry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'source');
const out = path.join(root, 'svg');
const read = async (name) => readFile(path.join(sourceDir, `${name}.txt`), 'utf8');
const paths = (svg) => [...svg.matchAll(/<path[^>]*\bd="([^"]+)"[^>]*>/g)].map((m) => m[1]);
const wrap = (viewBox, body, title) =>
  `<?xml version="1.0" encoding="UTF-8"?>\n` +
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" ` +
  `preserveAspectRatio="xMidYMid meet" role="img" aria-labelledby="title">\n` +
  `<title id="title">${title}</title>\n${body}\n</svg>\n`;
const splitPath = (d) => {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const lines = [];
  let line = '';
  for (const token of tokens) {
    if (line && line.length + token.length + 1 > 100) {
      lines.push(line);
      line = token;
    } else line += `${line ? ' ' : ''}${token}`;
  }
  if (line) lines.push(line);
  return lines.join('\n');
};
const pathNode = (d, fill, transform = '') =>
  `<path fill="${fill}"${transform ? ` transform="${transform}"` : ''}` + ` d="${splitPath(d)}"/>`;
const [logo, bg, logotype] = await Promise.all([
  read('Logo.svg'),
  read('Logo-BG.svg'),
  read('Logo-Logotype.svg'),
]);
const symbol = paths(logo);
const lettering = paths(logotype).slice(-6);
if (symbol.length !== 4 || lettering.length !== 6) {
  throw new Error(
    `Expected four symbol and six wordmark paths; got ${symbol.length}/${lettering.length}`,
  );
}
await mkdir(out, { recursive: true });

const emit = async (name, vb, body, title) =>
  writeFile(path.join(out, name), wrap(vb, body, title), 'utf8');
const symbolBody = (fill) => symbol.map((d) => pathNode(d, fill)).join('\n');
const symbolFiles = [
  ['anafor-symbol-primary.svg', '#C9F36B'],
  ['anafor-symbol-dark.svg', '#0B1016'],
  ['anafor-symbol-white.svg', '#FFFFFF'],
  ['anafor-symbol-black.svg', '#000000'],
];
for (const [name, fill] of symbolFiles) {
  await emit(name, '-400 -400 2800 2800', symbolBody(fill), 'Anafor symbol');
}

const layout = (background, symbolFill, textFill, transparent = false) => {
  const nodes = [];
  if (!transparent) nodes.push(`<rect width="5000" height="2000" fill="${background}"/>`);
  nodes.push(`<g transform="translate(491.19 380) scale(.62)">`);
  nodes.push(...symbol.map((d) => pathNode(d, symbolFill)));
  nodes.push('</g>');
  nodes.push('<g>');
  nodes.push(...lettering.map((d) => pathNode(d, textFill)));
  nodes.push('</g>');
  return nodes.join('\n');
};
await emit(
  'anafor-lockup-horizontal-dark.svg',
  '0 0 5000 2000',
  layout('#0B1016', '#C9F36B', '#F2F5F7'),
  'Anafor',
);
await emit(
  'anafor-lockup-horizontal-light.svg',
  '0 0 5000 2000',
  layout('#F2F5F7', '#0B1016', '#0B1016'),
  'Anafor',
);
await emit(
  'anafor-lockup-horizontal-dark-transparent.svg',
  '0 0 5000 2000',
  layout(null, '#C9F36B', '#F2F5F7', true),
  'Anafor',
);
await emit(
  'anafor-lockup-horizontal-light-transparent.svg',
  '0 0 5000 2000',
  layout(null, '#0B1016', '#0B1016', true),
  'Anafor',
);
const symbolBox = bounds(symbol);
const wordScale = 0.62;
const wordBox = bounds(lettering, { x: 0, y: 0, scale: wordScale });
const symbolWidth = width(symbolBox);
const symbolHeight = height(symbolBox);
const wordWidth = width(wordBox);
const wordHeight = height(wordBox);
const stackWidth = Math.max(symbolWidth, wordWidth);
const clear = 0.2 * stackWidth;
const gap = 0.15 * symbolHeight;
const stackHeight = symbolHeight + gap + wordHeight;
const symbolTx = -centerX(symbolBox);
const wordTx = -centerX(wordBox);
const wordTy = symbolHeight + gap - wordBox.minY;
const stacked =
  `<g transform="translate(${symbolTx.toFixed(3)} 0)">${symbol.map((d) => pathNode(d, '#C9F36B')).join('\n')}</g>\n` +
  `<g transform="translate(${wordTx.toFixed(3)} ${wordTy.toFixed(3)}) scale(${wordScale})">${lettering.map((d) => pathNode(d, '#F2F5F7')).join('\n')}</g>`;
await emit(
  'anafor-lockup-stacked.svg',
  `${(-stackWidth / 2 - clear).toFixed(3)} ${(-clear).toFixed(3)} ` +
    `${(stackWidth + 2 * clear).toFixed(3)} ${(stackHeight + 2 * clear).toFixed(3)}`,
  stacked,
  'Anafor stacked',
);
await mkdir(path.join(root, 'icons'), { recursive: true });
await writeFile(
  path.join(root, 'icons', 'favicon.svg'),
  wrap('-400 -400 2800 2800', symbolBody('#C9F36B'), 'Anafor favicon'),
  'utf8',
);
