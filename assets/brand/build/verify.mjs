import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bounds, centerX, centerY, height, width, pathGeometry } from './geometry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFile(p, 'utf8');
const getPaths = (svg) => [...svg.matchAll(/<path[^>]*\bd="([^"]+)"[^>]*>/g)].map((m) => m[1]);
const norm = (d) => d.replace(/[\s,]+/g, '');
const sourceLogo = getPaths(await read(path.join(root, 'source', 'Logo.svg.txt')));
const sourceBg = getPaths(await read(path.join(root, 'source', 'Logo-BG.svg.txt')));
const sourceLogotype = getPaths(await read(path.join(root, 'source', 'Logo-Logotype.svg.txt')));
const symbol = sourceLogo;
const lettering = sourceLogotype.slice(-6);
let pass = true;

const files = (await readdir(path.join(root, 'svg'))).filter((f) => f.endsWith('.svg'));
for (const file of files) {
  const paths = getPaths(await read(path.join(root, 'svg', file)));
  const expected = file.includes('lockup') ? [...symbol, ...lettering] : symbol;
  const ok =
    paths.length === expected.length && paths.every((d, i) => norm(d) === norm(expected[i]));
  console.log(`${ok ? 'PASS' : 'FAIL'} source path data: ${file} (${paths.length} paths)`);
  if (!ok) pass = false;
}

function affineDeviation(reference, target, tx, ty, scale) {
  if (reference.length !== target.length) return Infinity;
  let max = 0;
  let where = '';
  for (let i = 0; i < reference.length; i++) {
    const a = pathGeometry(reference[i], 0, true);
    const b = pathGeometry(target[i], 0, true);
    if (a.length !== b.length) return Infinity;
    for (let j = 0; j < a.length; j++) {
      const expectedX = Math.round((tx + scale * a[j][0]) * 100) / 100;
      const expectedY = Math.round((ty + scale * a[j][1]) * 100) / 100;
      const dx = Math.abs(expectedX - b[j][0]);
      const dy = Math.abs(expectedY - b[j][1]);
      if (Math.max(dx, dy) > max) {
        max = Math.max(dx, dy);
        where = `path ${i + 1}, point ${j + 1}, source=${a[j].map((v) => v.toFixed(3)).join(',')}, target=${b[j].map((v) => v.toFixed(3)).join(',')}, dx=${dx.toFixed(4)}, dy=${dy.toFixed(4)}`;
      }
    }
  }
  return { max, where };
}
const transformTolerance = 0.02;
const bgDeviation = affineDeviation(symbol, sourceBg, 380, 380, 0.62);
const typeDeviation = affineDeviation(symbol, sourceLogotype.slice(0, 4), 491.19, 380, 0.62);
for (const [label, deviation] of [
  ['Logo-BG', bgDeviation],
  ['Logotype', typeDeviation],
]) {
  const ok = deviation.max <= transformTolerance + 1e-9;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${label} affine transform max absolute deviation ${deviation.max.toFixed(4)}; tolerance ${transformTolerance}; ${deviation.where}`,
  );
  if (!ok) pass = false;
}

function groupTransforms(svg) {
  return [...svg.matchAll(/<g(?: transform="([^"]+)")?>([\s\S]*?)<\/g>/g)].map((m) => {
    const transform = m[1] ?? '';
    const translate = /translate\(([-\d.]+)(?:[ ,]+([-\d.]+))?\)/.exec(transform);
    const scale = /scale\(([-\d.]+)\)/.exec(transform);
    return {
      paths: getPaths(m[2]),
      x: Number(translate?.[1] ?? 0),
      y: Number(translate?.[2] ?? 0),
      scale: Number(scale?.[1] ?? 1),
    };
  });
}
function transformedBox(group) {
  return bounds(group.paths, { x: group.x, y: group.y, scale: group.scale });
}
for (const file of files.filter((f) => f.includes('lockup'))) {
  const groups = groupTransforms(await read(path.join(root, 'svg', file)));
  if (groups.length !== 2) {
    console.log(`FAIL lockup groups: ${file} (${groups.length})`);
    pass = false;
    continue;
  }
  const [mark, word] = groups;
  const a = transformedBox(mark);
  const b = transformedBox(word);
  const boxWidth = Math.max(a.maxX, b.maxX) - Math.min(a.minX, b.minX);
  const boxHeight = Math.max(a.maxY, b.maxY) - Math.min(a.minY, b.minY);
  const horizontal = file.includes('horizontal');
  const delta = horizontal ? Math.abs(centerY(a) - centerY(b)) : Math.abs(centerX(a) - centerX(b));
  const limit = (horizontal ? 0.02 : 0.01) * (horizontal ? boxHeight : boxWidth);
  const ok = delta <= limit;
  console.log(
    `${ok ? 'PASS' : 'FAIL'} ${file} ${horizontal ? 'vertical' : 'horizontal'} center delta ${delta.toFixed(3)} / limit ${limit.toFixed(3)}`,
  );
  if (!ok) pass = false;
}

const masterPoints = symbol.flatMap((d) => pathGeometry(d, 20));
let maxSymmetryDeviation = 0;
for (const [x, y] of masterPoints) {
  const rx = 2000 - y;
  const ry = x;
  let nearest = Infinity;
  for (const [qx, qy] of masterPoints) nearest = Math.min(nearest, Math.hypot(rx - qx, ry - qy));
  maxSymmetryDeviation = Math.max(maxSymmetryDeviation, nearest);
}
const symmetryTolerance = 1.5;
const symmetryPass = maxSymmetryDeviation <= symmetryTolerance;
console.log(
  `${symmetryPass ? 'PASS' : 'FAIL'} 90-degree sampled symmetry max deviation ${maxSymmetryDeviation.toFixed(3)}; tolerance ${symmetryTolerance}`,
);
if (!symmetryPass) pass = false;

const stackedGroups = groupTransforms(
  await read(path.join(root, 'svg', 'anafor-lockup-stacked.svg')),
);
if (stackedGroups.length === 2) {
  const mark = transformedBox(stackedGroups[0]);
  const word = transformedBox(stackedGroups[1]);
  console.log(
    `INFO stacked centers x=${centerX(mark).toFixed(3)}/${centerX(word).toFixed(3)}; symbol height=${height(mark).toFixed(3)}; width=${width(mark).toFixed(3)}`,
  );
}
process.exitCode = pass ? 0 : 1;
