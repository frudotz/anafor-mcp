import { describe, expect, it, vi } from 'vitest';
import {
  planShutdownCommand,
  scheduleShutdown,
  shutdownStartNotice,
  applyShutdownResult,
  shouldShutdown,
  loopControlChanged,
  waitForJobs,
} from '../../src/loop/shutdown.js';
import type { LoopState } from '../../src/loop/state.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach } from 'vitest';
import { execute, runLoopCommand } from '../../src/cli/loop-cmd.js';
import { Store } from '../../src/store/store.js';
import { readLoopState, writeLoopState } from '../../src/loop/state.js';
import { AnaforService } from '../../src/server/service.js';
import { defaultAdapters } from '../../src/adapters/registry.js';
import { loadConfig } from '../../src/core/config.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const state = (s: LoopState['state'], paused_reason: string | null = null): LoopState => ({
  state: s,
  cycle: 1,
  session_id: null,
  started_at: '',
  paused_reason,
  resume_at: null,
  auto_resume: false,
  max_cycles: null,
  until: null,
  last_task: null,
  completed_items: [],
});

describe('loop shutdown', () => {
  async function executeFinal(
    finalState: LoopState['state'],
    reason: string | null = null,
    options: {
      sleep?: (ms: number) => Promise<void>;
      runner?: (cmd: string, args: string[]) => { status: number | null; stderr?: string };
    } = {},
  ) {
    const root = mkdtempSync(join(tmpdir(), 'anafor-shutdown-'));
    dirs.push(root);
    const initial = { ...state('running'), goal: 'goal', shutdown_on_finish: true };
    writeLoopState(root, initial);
    const fakeLoop = async () => {
      const final = { ...initial, state: finalState, paused_reason: reason } as LoopState;
      writeLoopState(root, final);
      return final;
    };
    const result = await execute(root, initial, true, {
      loopRunner: fakeLoop as typeof import('../../src/loop/run.js').runLoop,
      shutdownRunner: options.runner,
      sleep: options.sleep,
      now: () => 1000,
    });
    return { root, result, saved: readLoopState(root) };
  }

  it('schedules shutdown for DONE when explicitly enabled', async () => {
    const runner = vi.fn(() => ({ status: 0 }));
    const { saved } = await executeFinal('done', null, { runner });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(saved?.shutdown_scheduled_at).toBeTruthy();
    expect(saved?.shutdown_pending).toBe(false);
  });

  it('does not schedule shutdown after loop_stop during the wait', async () => {
    const rootRef: { root?: string } = {};
    const root = mkdtempSync(join(tmpdir(), 'anafor-shutdown-'));
    dirs.push(root);
    rootRef.root = root;
    const initial = { ...state('running'), goal: 'goal', shutdown_on_finish: true };
    writeLoopState(root, initial);
    const store = new Store(root);
    const task = store.createTask({ title: 't', objective: 'o', acceptanceCriteria: ['a'] });
    store.createJob({
      taskId: task.id,
      role: 'implementation',
      worker: 'fake',
      workspaceMode: 'shared',
      workdir: root,
      instructions: 'x',
      timeoutS: 60,
    });
    store.close();
    const runner = vi.fn(() => ({ status: 0 }));
    const fakeLoop = async () => {
      const final = { ...initial, state: 'done' as const };
      writeLoopState(root, final);
      return final;
    };
    await execute(root, initial, true, {
      loopRunner: fakeLoop as typeof import('../../src/loop/run.js').runLoop,
      shutdownRunner: runner,
      sleep: async () => {
        await runLoopCommand(root, ['stop']);
      },
    });
    expect(runner).not.toHaveBeenCalled();
    expect(readLoopState(root)?.state).toBe('done');
    expect(readLoopState(root)?.shutdown_cancelled).toBe(true);
  });

  it('records shutdown errors and does not schedule paused or stopped results', async () => {
    const failed = await executeFinal('done', null, {
      runner: () => ({ status: 1, stderr: 'denied' }),
    });
    expect(failed.saved?.shutdown_error).toBe('denied');
    expect(failed.saved?.shutdown_scheduled_at).toBeNull();
    for (const final of ['paused', 'stopped'] as const) {
      const runner = vi.fn(() => ({ status: 0 }));
      await executeFinal(final, final === 'paused' ? 'limit:weekly' : null, { runner });
      expect(runner).not.toHaveBeenCalled();
    }
  });

  it.each(['stop', 'pause'] as const)(
    'CLI %s cancels shutdown during the wait without changing done',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'anafor-shutdown-stop-'));
      dirs.push(root);
      writeLoopState(root, { ...state('done'), shutdown_on_finish: true, shutdown_pending: true });
      await runLoopCommand(root, [mode]);
      expect(readLoopState(root)).toMatchObject({ state: 'done', shutdown_cancelled: true });
    },
  );

  it.each(['stop', 'pause'] as const)(
    'CLI %s invokes the injected cancel runner when shutdown is scheduled',
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'anafor-shutdown-stop-'));
      dirs.push(root);
      writeLoopState(root, {
        ...state('done'),
        shutdown_on_finish: true,
        shutdown_scheduled_at: '2026-01-01T00:00:00Z',
        shutdown_cancel_command: 'shutdown /a',
      });
      const runner = vi.fn(() => ({ status: 0 }));
      await runLoopCommand(root, [mode], { shutdownRunner: runner });
      expect(runner).toHaveBeenCalledWith(
        'shutdown',
        process.platform === 'win32' ? ['/a'] : ['-c'],
      );
      expect(readLoopState(root)?.shutdown_scheduled_at).toBeNull();
      expect(readLoopState(root)?.shutdown_cancelled).toBe(true);
    },
  );

  it('CLI records and logs an injected cancellation failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anafor-shutdown-cli-fail-'));
    dirs.push(root);
    writeLoopState(root, {
      ...state('done'),
      shutdown_scheduled_at: '2026-01-01T00:00:00Z',
      shutdown_cancel_command: 'shutdown /a',
    });
    const runner = vi.fn(() => ({ status: 1, stderr: 'denied' }));
    const code = await runLoopCommand(root, ['pause'], { shutdownRunner: runner });
    expect(code).toBe(1);
    expect(readLoopState(root)?.shutdown_cancel_error).toBe('denied');
    expect(readFileSync(join(root, '.anafor', 'loop.log'), 'utf8')).toContain('shutdown /a');
  });

  it.each(['stop', 'pause'] as const)(
    'MCP loopStop %s cancels while waiting and keeps the terminal state',
    (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'anafor-shutdown-mcp-wait-'));
      dirs.push(root);
      const store = new Store(root);
      const service = new AnaforService(store, defaultAdapters(loadConfig(root)));
      try {
        writeLoopState(root, {
          ...state('paused', 'blocked: criteria'),
          shutdown_pending: true,
          shutdown_on_finish: true,
        });
        expect(service.loopStop(mode)).toMatchObject({ shutdown_cancelled: true, state: 'paused' });
        expect(readLoopState(root)).toMatchObject({
          state: 'paused',
          paused_reason: 'blocked: criteria',
          shutdown_cancelled: true,
        });
      } finally {
        store.close();
      }
    },
  );

  it.each(['stop', 'pause'] as const)(
    'MCP loopStop %s cancels shutdown and reports cancel failure',
    (mode) => {
      const root = mkdtempSync(join(tmpdir(), 'anafor-shutdown-mcp-'));
      dirs.push(root);
      const store = new Store(root);
      const service = new AnaforService(store, defaultAdapters(loadConfig(root)));
      try {
        writeLoopState(root, {
          ...state('done'),
          shutdown_on_finish: true,
          shutdown_scheduled_at: '2026-01-01T00:00:00Z',
          shutdown_cancel_command: 'shutdown /a',
        });
        const result = service.loopStop(mode, () => ({ status: 1, stderr: 'denied' }));
        expect(result).toMatchObject({
          shutdown_cancelled: false,
          shutdown_cancel_error: 'denied',
          manual_cancel_command: 'shutdown /a',
        });
        expect(readLoopState(root)?.shutdown_cancel_error).toBe('denied');
      } finally {
        store.close();
      }
    },
  );

  it('does not overwrite a stop written after runLoop returns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anafor-shutdown-race-'));
    dirs.push(root);
    const initial = { ...state('running'), goal: 'goal', shutdown_on_finish: true };
    writeLoopState(root, initial);
    const runner = vi.fn(() => ({ status: 0 }));
    const fakeLoop = async () => {
      const final = { ...initial, state: 'done' as const };
      writeLoopState(root, final);
      writeLoopState(root, { ...final, state: 'stopped', paused_reason: 'stopped' });
      return final;
    };
    await execute(root, initial, true, {
      loopRunner: fakeLoop as typeof import('../../src/loop/run.js').runLoop,
      shutdownRunner: runner,
    });
    expect(runner).not.toHaveBeenCalled();
    expect(readLoopState(root)).toMatchObject({ state: 'stopped', paused_reason: 'stopped' });
  });

  it('records failed cancellation after shutdown was scheduled while the command ran', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anafor-shutdown-cancel-race-'));
    dirs.push(root);
    const initial = { ...state('running'), goal: 'goal', shutdown_on_finish: true };
    writeLoopState(root, initial);
    const fakeLoop = async () => {
      const final = { ...initial, state: 'done' as const };
      writeLoopState(root, final);
      return final;
    };
    let calls = 0;
    await execute(root, initial, true, {
      loopRunner: fakeLoop as typeof import('../../src/loop/run.js').runLoop,
      now: () => 1000,
      shutdownRunner: () => {
        calls++;
        if (calls === 1) {
          const live = readLoopState(root)!;
          live.shutdown_cancelled = true;
          writeLoopState(root, live);
          return { status: 0 };
        }
        return { status: 1, stderr: 'cancel denied' };
      },
    });
    expect(calls).toBe(2);
    expect(readLoopState(root)?.shutdown_cancel_error).toBe('cancel denied');
  });

  it('only shuts down for DONE or BLOCKED when explicitly enabled', () => {
    expect(shouldShutdown(state('done'), 'shutdown')).toBe(true);
    expect(shouldShutdown(state('paused', 'blocked: reason'), 'shutdown')).toBe(true);
    for (const final of [
      state('paused', 'limit'),
      state('paused', 'error: failed'),
      state('stopped'),
    ])
      expect(shouldShutdown(final, 'shutdown')).toBe(false);
    expect(shouldShutdown(state('done'), 'none')).toBe(false);
  });

  it('detects a user stop or pause while waiting', () => {
    expect(loopControlChanged(state('done'), state('stopped'))).toBe(true);
    expect(loopControlChanged(state('paused', 'blocked: reason'), state('paused', 'manual'))).toBe(
      true,
    );
    expect(loopControlChanged(state('done'), state('done'))).toBe(false);
  });

  it('plans platform commands and reports runner errors', () => {
    expect(planShutdownCommand('win32')).toEqual({
      cmd: 'shutdown',
      args: ['/s', '/t', '120', '/c', 'Anafor: döngü bitti'],
      cancel: 'shutdown /a',
    });
    expect(planShutdownCommand('linux')).toEqual({
      cmd: 'shutdown',
      args: ['-h', '+2'],
      cancel: 'shutdown -c',
    });
    expect(
      scheduleShutdown(planShutdownCommand('linux'), () => ({ status: 1, stderr: 'denied' })),
    ).toBe('denied');
    const plan = planShutdownCommand('win32');
    const failed = applyShutdownResult(
      { ...state('done') },
      plan,
      'denied',
      '2026-01-01T00:00:00.000Z',
    );
    expect(failed.shutdown_error).toBe('denied');
    expect(failed.shutdown_scheduled_at).toBeNull();
    expect(shutdownStartNotice(true, 'linux', (cancel) => `Cancel: ${cancel}`)).toBe(
      'Cancel: shutdown -c',
    );
    expect(shutdownStartNotice(false, 'win32', (cancel) => cancel)).toBeNull();
  });

  it('cancels remaining jobs through the provided jobCancel callback after timeout', async () => {
    const jobs = [{ id: 'j1' }];
    const jobCancel = vi.fn((id: string) => {
      jobs.splice(0, 1);
    });
    await waitForJobs(
      () => jobs,
      jobCancel,
      async () => {},
      0,
    );
    expect(jobCancel).toHaveBeenCalledWith('j1');
  });

  it('stops waiting and skips cancellation when the loop is stopped', async () => {
    const jobs = [{ id: 'j1' }];
    const cancel = vi.fn();
    let stopped = false;
    const wait = waitForJobs(
      () => jobs,
      cancel,
      async () => {
        stopped = true;
      },
      60_000,
      () => stopped,
    );
    expect(await wait).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('finishes waiting as soon as jobs complete', async () => {
    const jobs = [{ id: 'j1' }];
    let sleeps = 0;
    const completed = await waitForJobs(
      () => jobs,
      vi.fn(),
      async () => {
        sleeps++;
        jobs.splice(0, 1);
      },
      60_000,
    );
    expect(completed).toBe(true);
    expect(sleeps).toBe(1);
  });
});
