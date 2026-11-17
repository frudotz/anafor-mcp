import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { m } from '../i18n/index.js';
import { anaforHome } from '../limits/limits.js';
import { ANAFOR_VERSION } from '../version.js';

/**
 * Sürüm denetimi ve güncelleme (F28). Yalnızca herkese açık GitHub Release meta verisi okunur;
 * kullanıcıya ait hiçbir bilgi gönderilmez (genel User-Agent). Statusline ağı hiç beklemez:
 * önbellek bayatsa denetim ayrık bir süreçte yapılır.
 */
export const REPO = 'frudotz/anafor-mcp';
const RELEASES = `https://github.com/${REPO}/releases`;
export const UPDATE_COMMAND = 'anafor update';
const TTL_MS = 6 * 3600_000;
const UA = { 'User-Agent': 'anafor-cli', Accept: 'application/vnd.github+json' };

export interface UpdateCache {
  checked_at: string;
  latest: string | null;
  error?: string;
}

const cacheFile = (env?: NodeJS.ProcessEnv) => join(anaforHome(env), 'update-check.json');

export function readUpdateCache(env?: NodeJS.ProcessEnv): UpdateCache | null {
  try {
    return JSON.parse(readFileSync(cacheFile(env), 'utf8')) as UpdateCache;
  } catch {
    return null;
  }
}

/** a > b ise pozitif (yalnızca x.y.z sayısal karşılaştırma). */
export function compareVersions(a: string, b: string): number {
  const n = (v: string) => v.replace(/^v/, '').split('-')[0]!.split('.').map(Number);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** Önbellekteki daha yeni sürüm (yoksa null). */
export function availableUpdate(
  cache: UpdateCache | null,
  current = ANAFOR_VERSION,
): string | null {
  return cache?.latest && compareVersions(cache.latest, current) > 0 ? cache.latest : null;
}

export async function fetchLatest(timeoutMs = 5000): Promise<string> {
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: UA,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}`);
  const tag = ((await r.json()) as { tag_name?: string }).tag_name;
  if (!tag) throw new Error('tag_name yok');
  return tag.replace(/^v/, '');
}

export async function refreshUpdateCache(env?: NodeJS.ProcessEnv): Promise<UpdateCache> {
  let cache: UpdateCache;
  try {
    cache = { checked_at: new Date().toISOString(), latest: await fetchLatest() };
  } catch (e) {
    cache = {
      checked_at: new Date().toISOString(),
      latest: readUpdateCache(env)?.latest ?? null,
      error: (e as Error).message,
    };
  }
  mkdirSync(anaforHome(env), { recursive: true });
  writeFileSync(cacheFile(env), JSON.stringify(cache, null, 2));
  return cache;
}

/** Önbellek bayatsa denetimi ayrık süreçte başlatır (çağıranı bekletmez). */
export function refreshInBackground(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): boolean {
  if (env.ANAFOR_NO_UPDATE_CHECK === '1') return false;
  const c = readUpdateCache(env);
  if (c && now - Date.parse(c.checked_at) < TTL_MS) return false;
  // Aynı anda birden çok denetim başlamasın: önce zaman damgası yazılır.
  mkdirSync(anaforHome(env), { recursive: true });
  writeFileSync(
    cacheFile(env),
    JSON.stringify({ ...(c ?? { latest: null }), checked_at: new Date(now).toISOString() }),
  );
  const cli = fileURLToPath(new URL('./main.js', import.meta.url));
  const child = spawn(process.execPath, [cli, 'update-check'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env,
  });
  child.unref();
  return true;
}

/** SHA256SUMS.txt içinden bir dosyanın özeti. */
export function sumFor(sums: string, file: string): string | null {
  for (const line of sums.split('\n')) {
    const [hash, name] = line.trim().split(/\s+\*?/);
    if (name === file && hash && /^[0-9a-f]{64}$/i.test(hash)) return hash.toLowerCase();
  }
  return null;
}

/**
 * `anafor update`: son sürüm paketini indirir, SHA256SUMS ile doğrular, npm ile kurar ve
 * plugin'i yeniler. Doğrulama başarısızsa hiçbir şey kurulmaz.
 */
export async function runUpdate(log: (s: string) => void, check = false): Promise<number> {
  const latest = await fetchLatest(15_000);
  await refreshUpdateCache();
  if (compareVersions(latest, ANAFOR_VERSION) <= 0) {
    log(m().update.upToDate(ANAFOR_VERSION));
    return 0;
  }
  log(m().update.newVersion(ANAFOR_VERSION, latest));
  if (check) return 0;
  const tmp = mkdtempSync(join(tmpdir(), 'anafor-update-'));
  try {
    const get = async (name: string) => {
      const r = await fetch(`${RELEASES}/download/v${latest}/${name}`, {
        headers: { 'User-Agent': 'anafor-cli' },
        signal: AbortSignal.timeout(120_000),
      });
      if (!r.ok) throw new Error(`${name} indirilemedi (${r.status})`);
      return Buffer.from(await r.arrayBuffer());
    };
    const file = `anafor-mcp-${latest}.tgz`;
    const sums = (await get('SHA256SUMS.txt')).toString('utf8');
    const expected = sumFor(sums, file);
    if (!expected) throw new Error(`SHA256SUMS.txt içinde ${file} yok`);
    const tgz = await get(file);
    const actual = createHash('sha256').update(tgz).digest('hex');
    if (actual !== expected)
      throw new Error(`özet uyuşmuyor: beklenen ${expected}, gelen ${actual}`);
    log(m().update.verified(actual.slice(0, 12)));
    const path = join(tmp, file);
    writeFileSync(path, tgz);
    const npm = spawnSync('npm', ['install', '-g', path], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    if (npm.status !== 0) throw new Error(`npm install başarısız (${npm.status})`);
    log(m().update.installed);
    // Yeni kurulan sürümün setup'ı: yalnızca plugin (statusline ve proje adımı atlanır).
    const setup = spawnSync('anafor', ['setup', '--yes', '--no-statusline', '--no-project'], {
      stdio: 'inherit',
      shell: process.platform === 'win32',
      windowsHide: true,
    });
    if (setup.status !== 0) log(m().update.pluginFail);
    log(m().update.done(latest));
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
