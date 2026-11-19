import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('UserPromptSubmit loop warning', () => {
  it('emits context only when cached Claude usage exceeds warn_at', () => {
    const root = mkdtempSync(join(tmpdir(), 'anafor-prompt-hook-'));
    dirs.push(root);
    mkdirSync(join(root, '.anafor'));
    const env = { ANAFOR_HOME: join(root, 'home') };
    const limitsPath = join(env.ANAFOR_HOME, 'limits.json');
    mkdirSync(env.ANAFOR_HOME);
    const put = (percent: number, resetsAt: number | null = null) =>
      writeFileSync(
        limitsPath,
        JSON.stringify({
          claude: {
            observed_at: new Date().toISOString(),
            windows: [{ name: 'five_hour', used_percent: percent, resets_at: resetsAt }],
          },
        }),
      );
    expect(runUserPromptSubmit({ cwd: root }, env)).toBe('');
    put(70);
    expect(runUserPromptSubmit({ cwd: root }, env)).toBe('');
    put(80);
    const output = JSON.parse(runUserPromptSubmit({ cwd: root }, env));
    expect(output.hookSpecificOutput.additionalContext).toContain('%80');
    put(95, Math.floor(Date.now() / 1000) - 60);
    expect(runUserPromptSubmit({ cwd: root }, env)).toBe('');
  });
});
