import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../src/core/config.js';
import { migrateWorkerConfigs } from '../../src/governance/migrate.js';
import { limitAccount } from '../../src/limits/limits.js';

const dirs: string[] = [];
const root = () => {
  const d = mkdtempSync(join(tmpdir(), 'anafor-alias-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('cirak legacy alias', () => {
  it('merges brain config with project values taking precedence', () => {
    const d = root();
    mkdirSync(join(d, '.anafor'));
    writeFileSync(
      join(d, '.anafor', 'config.json'),
      JSON.stringify({ brain: { lean: false, effort: 'low', model: 'local' } }),
    );
    writeFileSync(join(d, 'anafor.config.json'), JSON.stringify({ brain: { model: 'project' } }));
    expect(loadConfig(d).brain).toEqual({ lean: false, effort: 'low', model: 'project' });
    expect(loadConfig(join(d, 'missing')).brain).toEqual({ lean: true });
  });
  it('merges worker config and canonicalizes routing', () => {
    const d = root();
    mkdirSync(join(d, '.anafor'));
    writeFileSync(
      join(d, '.anafor', 'config.json'),
      JSON.stringify({
        workers: {
          'claude-lite': { model: 'haiku', max_concurrency: 1 },
          cirak: { max_concurrency: 2 },
        },
        routing: { review: ['claude-lite'] },
        statusline: { workers: ['claude-lite'] },
      }),
    );
    const cfg = loadConfig(d);
    expect(cfg.workers.cirak).toMatchObject({ model: 'haiku', max_concurrency: 2 });
    expect(cfg.routing.review).toEqual(['cirak']);
    expect(cfg.statusline.workers).toEqual(['cirak']);
  });
  it('warns once and maps history limits and worker ids', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.resetModules();
    return import('../../src/core/config.js').then(({ canonicalWorkerId }) => {
      expect(canonicalWorkerId('claude-lite')).toBe('cirak');
      expect(canonicalWorkerId('claude-lite')).toBe('cirak');
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockRestore();
    });
  });
  it('maps legacy limit account', () => {
    expect(limitAccount('claude-lite')).toBe('claude');
  });
  it('migrates both config files once', () => {
    const d = root();
    mkdirSync(join(d, '.anafor'));
    const legacy = JSON.stringify({
      workers: { 'claude-lite': { model: 'haiku' } },
      routing: { review: ['claude-lite'] },
      statusline: { workers: ['claude-lite'] },
    });
    writeFileSync(join(d, '.anafor', 'config.json'), legacy);
    writeFileSync(join(d, 'anafor.config.json'), legacy);
    expect(migrateWorkerConfigs(d)).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(d, 'anafor.config.json'), 'utf8'))).toMatchObject({
      routing: { review: ['cirak'] },
      statusline: { workers: ['cirak'] },
    });
    expect(migrateWorkerConfigs(d)).toEqual([]);
    expect(readFileSync(join(d, 'anafor.config.json'), 'utf8')).toContain('cirak');
  });
});
