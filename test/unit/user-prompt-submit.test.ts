import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runUserPromptSubmit } from '../../src/hooks/user-prompt-submit.js';
import type { LoopState } from '../../src/loop/state.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('UserPromptSubmit limit context', () => {
  it('warns outside loops, uses the safe-point prompt during loops, and stays quiet below threshold', () => {
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
    const outsideLoop = JSON.parse(runUserPromptSubmit({ cwd: root }, env));
    expect(outsideLoop.hookSpecificOutput.additionalContext).toContain('kullanıcıyı kalan limit');
    put(80);
    const loop: LoopState = {
      state: 'running',
      cycle: 1,
      session_id: null,
      started_at: new Date().toISOString(),
      paused_reason: null,
      resume_at: null,
      auto_resume: false,
      max_cycles: null,
      until: null,
      last_task: null,
      completed_items: [],
    };
    writeFileSync(join(root, '.anafor', 'loop.json'), JSON.stringify(loop));
    const output = JSON.parse(runUserPromptSubmit({ cwd: root }, env));
    expect(output.hookSpecificOutput.additionalContext).toContain('güvenli noktaya getir');
    writeFileSync(join(root, '.anafor', 'loop.json'), JSON.stringify({ ...loop, state: 'paused' }));
    expect(
      JSON.parse(runUserPromptSubmit({ cwd: root }, env)).hookSpecificOutput.additionalContext,
    ).toContain('güvenli noktaya getir');
    writeFileSync(
      join(root, '.anafor', 'loop.json'),
      JSON.stringify({ ...loop, state: 'stopped' }),
    );
    expect(
      JSON.parse(runUserPromptSubmit({ cwd: root }, env)).hookSpecificOutput.additionalContext,
    ).toContain('kullanıcıyı kalan limit');
    put(70);
    expect(runUserPromptSubmit({ cwd: root }, env)).toBe('');
    put(95, Math.floor(Date.now() / 1000) - 60);
    expect(runUserPromptSubmit({ cwd: root }, env)).toBe('');
  });
});
