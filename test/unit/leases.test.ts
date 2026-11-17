import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  acquireLease,
  liveLeases,
  otherProjectLeases,
  pidAlive,
  releaseLease,
} from '../../src/core/leases.js';

const dirs: string[] = [];
const home = () => {
  const d = mkdtempSync(join(tmpdir(), 'anafor-lease-'));
  dirs.push(d);
  return { ANAFOR_HOME: d } as NodeJS.ProcessEnv;
};
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));

describe('makine geneli iş kiraları (F16)', () => {
  it('kira alınır, sayılır, bırakılır', () => {
    const env = home();
    acquireLease('J-1', '/p/a', env);
    acquireLease('J-2', '/p/b', env);
    expect(
      liveLeases(env)
        .map((l) => l.job)
        .sort(),
    ).toEqual(['J-1', 'J-2']);
    expect(otherProjectLeases('/p/a', env).map((l) => l.job)).toEqual(['J-2']);
    releaseLease('J-1', env);
    expect(liveLeases(env).map((l) => l.job)).toEqual(['J-2']);
  });

  it('süreci ölmüş kira bayattır ve silinir', () => {
    const env = home();
    acquireLease('J-dead', '/p/a', env, 999_999_99);
    expect(liveLeases(env, () => false)).toEqual([]);
    expect(liveLeases(env)).toEqual([]);
  });

  it('pidAlive: kendi süreci canlı', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });
});
