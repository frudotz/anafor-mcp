import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { collectChecks, summarize } from '../../src/cli/doctor-cmd.js';
import { tempDir } from '../helpers.js';

const root = join(import.meta.dirname, '..', '..');

describe('anafor doctor (F25)', () => {
  it('kodlu kontroller: bağlı olmayan dizin, özet', async () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, 'bos'));
      const checks = await collectChecks(join(t.dir, 'bos'), false);
      const codes = checks.map((c) => c.code);
      expect(codes).toContain('PROJECT_NOT_INIT');
      expect(codes).toContain('NOT_GIT_REPO');
      for (const c of checks) {
        expect(['ok', 'warn', 'fail', 'off']).toContain(c.status);
        expect(c.code).toMatch(/^[A-Z_]+$/);
        if (c.status === 'fail') expect(c.fix).toBeTruthy();
      }
      expect(checks.find((c) => c.code === 'PROJECT_NOT_INIT')?.fix).toBe('anafor init');
      const s = summarize(checks);
      expect(s.ok).toBe(s.problems.length === 0);
    } finally {
      t.cleanup();
    }
  });

  it('yapay zekâ kurulum rehberi doctor kodlarının tümünü belgeler', () => {
    const src = readFileSync(join(root, 'src', 'cli', 'doctor-cmd.ts'), 'utf8');
    const codes = [...src.matchAll(/'([A-Z][A-Z_]{3,})'/g)].map((m) => m[1]!);
    const doc = readFileSync(join(root, 'docs', 'agent-install.md'), 'utf8');
    const missing = [...new Set(codes)].filter((c) => !doc.includes(`\`${c}\``));
    expect(missing).toEqual([]);
    expect(codes.length).toBeGreaterThan(15);
  });
});
