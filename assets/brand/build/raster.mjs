import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdir } from 'node:fs/promises';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const targetArg = process.argv[2];
if (!targetArg) throw new Error('Usage: node raster.mjs <output-directory>');
const target = path.resolve(targetArg);
if (target === repo || target.startsWith(`${repo}${path.sep}`)) {
  throw new Error('Output directory must be outside the repository.');
}
const candidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);
let chrome;
for (const candidate of candidates) {
  try {
    await access(candidate);
    chrome = candidate;
    break;
  } catch {
    /* try next */
  }
}
if (!chrome) throw new Error('Chrome/Chromium not found; set CHROME_PATH.');
await mkdir(target, { recursive: true });
const svgDir = path.join(repo, 'assets', 'brand');
const jobs = [];
const add = (name, svg, width, height = width, background = 'transparent') => {
  jobs.push({ name, svg, width, height, background });
};
for (const size of [16, 24, 32, 64, 128, 256, 512])
  add(`symbol-${size}.png`, path.join(svgDir, 'svg', 'anafor-symbol-primary.svg'), size);
for (const [name, size] of [
  ['favicon-16.png', 16],
  ['favicon-32.png', 32],
  ['apple-touch-icon.png', 180],
  ['icon-192.png', 192],
  ['icon-512.png', 512],
]) {
  add(
    name,
    path.join(svgDir, 'icons', 'favicon.svg'),
    size,
    size,
    name === 'apple-touch-icon.png' ? '#0B1016' : 'transparent',
  );
}
for (const [name, width, height] of [
  ['github-social-preview.png', 1280, 640],
  ['og-image.png', 1200, 630],
]) {
  jobs.push({
    name: path.join('social', name),
    svg: path.join(svgDir, 'svg', 'anafor-lockup-horizontal-dark.svg'),
    width,
    height,
    background: '#0B1016',
    kind: 'social',
  });
}
for (const [folder, prefix] of [
  ['svg', ''],
  ['icons', 'icons-'],
]) {
  for (const file of (await readdir(path.join(svgDir, folder))).filter((name) =>
    name.endsWith('.svg'),
  )) {
    const svgPath = path.join(svgDir, folder, file);
    const source = await readFile(svgPath, 'utf8');
    const viewBox = /viewBox="([\d.-]+) ([\d.-]+) ([\d.]+) ([\d.]+)"/.exec(source);
    if (!viewBox) throw new Error(`Missing viewBox: ${svgPath}`);
    const ratio = Number(viewBox[4]) / Number(viewBox[3]);
    add(
      path.join('preview', `${prefix}${path.basename(file, '.svg')}.png`),
      svgPath,
      1000,
      Math.round(1000 * ratio),
    );
  }
}
for (const job of jobs) {
  const source = await readFile(job.svg, 'utf8');
  const dataUri = `data:image/svg+xml,${encodeURIComponent(source)}`;
  const page =
    job.kind === 'social'
      ? `<svg xmlns="http://www.w3.org/2000/svg" width="${job.width}" ` +
        `height="${job.height}" viewBox="0 0 ${job.width} ${job.height}">` +
        `<rect width="100%" height="100%" fill="#0B1016"/>` +
        `<image href="${dataUri}" x="${job.width * 0.15}" ` +
        `y="${job.height * 0.22}" width="${job.width * 0.7}" ` +
        `height="${job.height * 0.56}" preserveAspectRatio="xMidYMid meet"/>` +
        `<text x="50%" y="82%" text-anchor="middle" fill="#93A4B2" ` +
        `font-family="Inter, 'Segoe UI', Helvetica, Arial, sans-serif" ` +
        `font-size="${Math.round(job.width * 0.022)}">` +
        'Orchestration MCP server for frontier AI models</text></svg>'
      : `<svg xmlns="http://www.w3.org/2000/svg" width="${job.width}" height="${job.height}" viewBox="0 0 ${job.width} ${job.height}"><rect width="100%" height="100%" fill="${job.background}"/><image href="${dataUri}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet"/></svg>`;
  const html = `<!doctype html><html><body style="margin:0">${page}</body></html>`;
  const htmlPath = path.join(target, `.raster-${job.name.replaceAll(/[\\/]/g, '-')}.html`);
  await writeFile(htmlPath, html);
  const out = path.join(target, job.name);
  await mkdir(path.dirname(out), { recursive: true });
  await new Promise((resolve, reject) => {
    const child = spawn(
      chrome,
      [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        `--window-size=${job.width},${job.height}`,
        `--screenshot=${out}`,
        `file://${htmlPath}`,
      ],
      { stdio: 'ignore' },
    );
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`Chrome exited ${code}`)),
    );
  });
}
console.log(`Rendered ${jobs.length} PNG files to ${target}`);
