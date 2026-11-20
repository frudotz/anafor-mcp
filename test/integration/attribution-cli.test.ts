import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const cli = resolve('dist/cli/main.js');
const sandbox = resolve('.anafor-tmp');
mkdirSync(sandbox, { recursive: true });
const project = () => mkdtempSync(join(sandbox, 'attribution-'));
const run = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', windowsHide: true });

describe('attribution CLI', () => {
  it('enable/disable/status backs up settings and changes only attribution.pr', () => {
    const dir = project();
    const originalLang = process.env.ANAFOR_LANG;
    try {
      expect(run(dir, 'init', dir, '--yes').status).toBe(0);
      const file = join(dir, '.claude', 'settings.json');
      const initial = {
        permissions: { allow: ['Read'] },
        attribution: { commit: 'keep', pr: 'Custom' },
        statusLine: { command: 'keep' },
      };
      writeFileSync(file, `${JSON.stringify(initial)}\n`);
      expect(run(dir, 'attribution', 'enable').status).toBe(0);
      const enabled = JSON.parse(readFileSync(file, 'utf8')) as typeof initial;
      expect(enabled).toMatchObject({
        permissions: initial.permissions,
        statusLine: initial.statusLine,
        attribution: { commit: 'keep', pr: expect.stringContaining('Custom') },
      });
      expect(existsSync(`${file}.bak`)).toBe(true);
      expect(JSON.parse(readFileSync(`${file}.bak`, 'utf8'))).toEqual(initial);
      const once = readFileSync(file, 'utf8');
      expect(run(dir, 'attribution', 'enable').status).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe(once);
      writeFileSync(`${file}.bak`, 'preserve original backup');
      expect(run(dir, 'attribution', 'enable').status).toBe(0);
      expect(readFileSync(`${file}.bak`, 'utf8')).toBe('preserve original backup');
      expect(run(dir, 'attribution', 'status').status).toBe(0);
      expect(run(dir, 'attribution', 'disable').status).toBe(0);
      const disabled = JSON.parse(readFileSync(file, 'utf8')) as typeof initial;
      expect(disabled.attribution).toEqual({ commit: 'keep', pr: 'Custom' });
      expect(disabled.permissions).toEqual(initial.permissions);
      expect(disabled.statusLine).toEqual(initial.statusLine);
      process.env.ANAFOR_LANG = 'tr';
      expect(run(dir, 'attribution', 'enable').status).toBe(0);
      process.env.ANAFOR_LANG = 'en';
      expect(run(dir, 'attribution', 'enable').status).toBe(0);
      const switched = JSON.parse(readFileSync(file, 'utf8')) as typeof initial;
      expect((switched.attribution.pr as string).match(/Built with \[Anafor\]/g)).toHaveLength(1);
      expect(switched.attribution.pr).not.toContain('ile geliştirildi');
    } finally {
      if (originalLang === undefined) delete process.env.ANAFOR_LANG;
      else process.env.ANAFOR_LANG = originalLang;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed JSON without changing settings', () => {
    const dir = project();
    try {
      const file = join(dir, '.claude', 'settings.json');
      mkdirSync(join(dir, '.claude'), { recursive: true });
      writeFileSync(file, '{ invalid');
      expect(run(dir, 'init', dir, '--yes').status).toBe(0);
      expect(readFileSync(file, 'utf8')).toBe('{ invalid');
      expect(run(dir, 'attribution', 'enable').status).toBe(1);
      expect(readFileSync(file, 'utf8')).toBe('{ invalid');
      writeFileSync(file, '[]');
      expect(run(dir, 'attribution', 'disable').status).toBe(1);
      expect(readFileSync(file, 'utf8')).toBe('[]');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('init --yes writes attribution while noninteractive init without --yes does not', () => {
    const yesDir = project();
    const quietDir = project();
    try {
      expect(run(yesDir, 'init', yesDir, '--yes').status).toBe(0);
      expect(existsSync(join(yesDir, '.claude', 'settings.json'))).toBe(true);
      expect(run(quietDir, 'init', quietDir).status).toBe(0);
      expect(existsSync(join(quietDir, '.claude', 'settings.json'))).toBe(false);
    } finally {
      rmSync(yesDir, { recursive: true, force: true });
      rmSync(quietDir, { recursive: true, force: true });
    }
  });
});
