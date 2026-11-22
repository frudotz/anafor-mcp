import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { spawnSyncMock } = vi.hoisted(() => ({
  spawnSyncMock: vi.fn(() => ({ status: 0 })),
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawnSync: spawnSyncMock };
});

import { runUpdate } from '../../src/cli/update.js';
import { tempDir } from '../helpers.js';
import { ANAFOR_VERSION } from '../../src/version.js';

describe('anafor update installer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    spawnSyncMock.mockReset();
    spawnSyncMock.mockReturnValue({ status: 0 });
  });

  it('npm kurulumunu --ignore-scripts ile spawnSync üzerinden çağırır', async () => {
    const t = tempDir();
    const major = Number(ANAFOR_VERSION.split('.')[0] ?? 0) + 1;
    const latest = `${major}.0.0`;
    const archive = Buffer.from('verified test archive');
    const hash = createHash('sha256').update(archive).digest('hex');
    const filename = `anafor-mcp-${latest}.tgz`;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.includes('/releases/latest')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ tag_name: `v${latest}` }),
        } as Response;
      }
      if (href.endsWith('SHA256SUMS.txt')) {
        const sums = Buffer.from(`${hash}  ${filename}\n`);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            sums.buffer.slice(sums.byteOffset, sums.byteOffset + sums.byteLength),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () =>
          archive.buffer.slice(archive.byteOffset, archive.byteOffset + archive.byteLength),
      } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubEnv('ANAFOR_HOME', t.dir);
    const logs: string[] = [];
    try {
      expect(await runUpdate((line) => logs.push(line))).toBe(0);
      expect(spawnSyncMock).toHaveBeenNthCalledWith(
        1,
        'npm',
        ['install', '-g', '--ignore-scripts', expect.stringContaining(filename)],
        expect.objectContaining({ stdio: 'inherit' }),
      );
      expect(spawnSyncMock).toHaveBeenNthCalledWith(
        2,
        'anafor',
        ['setup', '--yes', '--no-statusline', '--no-project'],
        expect.objectContaining({ stdio: 'inherit' }),
      );
    } finally {
      t.cleanup();
    }
  });
});
