import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { generateTestEvidenceAsync } from '../../src/governance/evidence.js';
import { tempDir } from '../helpers.js';

describe('auto_check async evidence runner', () => {
  it('records success and failure', async () => {
    const t = tempDir();
    try {
      const ok = await generateTestEvidenceAsync(
        t.dir,
        t.dir,
        join(t.dir, '.anafor', 'evidence'),
        'ok',
        'node -e "process.exit(0)"',
      );
      const failed = await generateTestEvidenceAsync(
        t.dir,
        t.dir,
        join(t.dir, '.anafor', 'evidence'),
        'failed',
        'node -e "process.exit(1)"',
      );
      expect(ok.passed).toBe(true);
      expect(failed.passed).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it('kills the process tree on timeout and reports failure', async () => {
    const t = tempDir();
    try {
      const result = await generateTestEvidenceAsync(
        t.dir,
        t.dir,
        join(t.dir, '.anafor', 'evidence'),
        'timeout',
        'node -e "setTimeout(()=>{},60000)"',
        2_000,
      );
      expect(result.passed).toBe(false);
      expect(result.summary).toContain('zaman aşımı');
    } finally {
      t.cleanup();
    }
  });
});
