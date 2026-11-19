import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runLoop, parseBacklog, parseLoopCompletion } from '../../src/loop/run.js';
import {
  acquireLoopLock,
  readLoopState,
  releaseLoopLock,
  setLoopBrainPid,
  writeLoopState,
  type LoopState,
} from '../../src/loop/state.js';
import type { WorkerLimits } from '../../src/limits/limits.js';
import { runBrainTurn } from '../../src/loop/brain-turn.js';
import { parseBrainLine } from '../../src/chat/brain.js';
import {
  createLoopShutdownHandler,
  defaultLoopProfile,
  runLoopCommand,
} from '../../src/cli/loop-cmd.js';
import { createGrant } from '../../src/hooks/grants.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const setup = () => {
  const root = mkdtempSync(join(tmpdir(), 'anafor-loop-'));
  dirs.push(root);
  const state: LoopState = {
    state: 'running',
    goal: 'goal',
    cycle: 0,
    session_id: null,
    started_at: new Date(0).toISOString(),
    paused_reason: null,
    resume_at: null,
    auto_resume: false,
    max_cycles: null,
    until: null,
    last_task: null,
    completed_items: [],
  };
  writeLoopState(root, state);
  return { root, state };
};
const highLimit = (): WorkerLimits => ({
  worker: 'claude',
  source: 'test',
  observed_at: '',
  status: 'limited',
  windows: [{ name: 'five_hour', used_percent: 95, resets_at: 101, window_minutes: 300 }],
});
const deps = (
  root: string,
  state: LoopState,
  options: {
    limits?: () => WorkerLimits | null;
    sleep?: (ms: number) => Promise<void>;
    turns?: Array<{
      sessionId: string | null;
      rateLimited?: boolean;
      resetsAt?: number | null;
      completion?:
        | { status: 'done'; marked?: true }
        | { status: 'continue'; marked?: boolean }
        | { status: 'blocked'; reason: string; marked?: true };
      error?: boolean;
      message?: string;
    }>;
  } = {},
) => {
  let now = 100_000;
  const turns = options.turns ?? [{ sessionId: 's', completion: { status: 'done' as const } }];
  return {
    root,
    state,
    now: () => now,
    sleep:
      options.sleep ??
      (async (ms) => {
        now += ms;
      }),
    readLimits: options.limits ?? (() => null),
    checkpoint: () => {},
    log: () => {},
    minTurnGapSec: 0,
    brain: {
      turn: async (_prompt: string, _options: { resume: boolean; sessionId: string | null }) =>
        turns.shift() ?? { sessionId: 's', completion: { status: 'done' as const } },
    },
  };
};

describe('runLoop', () => {
  it('auto resumes when limits clear and then completes', async () => {
    const { root, state } = setup();
    let reads = 0;
    const d = deps(
      root,
      { ...state, auto_resume: true },
      { limits: () => (reads++ === 0 ? highLimit() : null) },
    );
    writeLoopState(root, { ...state, auto_resume: true });
    const result = await runLoop(d);
    expect(result.state).toBe('done');
    expect(result.cycle).toBe(1);
  });
  it('stays paused when auto resume is disabled', async () => {
    const { root, state } = setup();
    const pausedState = { ...state, auto_resume: false };
    writeLoopState(root, pausedState);
    const result = await runLoop(deps(root, pausedState, { limits: highLimit }));
    expect(result).toMatchObject({ state: 'paused', paused_reason: 'limit:five_hour' });
  });
  it('pauses immediately on rate limit event after safe turn completion', async () => {
    const { root, state } = setup();
    const result = await runLoop(
      deps(root, state, { turns: [{ sessionId: 's', rateLimited: true }] }),
    );
    expect(result).toMatchObject({ state: 'paused', paused_reason: 'rate_limit_event' });
  });
  it('tracks backlog items and honors max cycles', async () => {
    const { root, state } = setup();
    writeFileSync(join(root, 'backlog.md'), '- [ ] first\n1. second\n');
    expect(parseBacklog(readFileSync(join(root, 'backlog.md'), 'utf8'))).toEqual([
      'first',
      'second',
    ]);
    const backlogState = { ...state, goal: undefined, backlog: 'backlog.md', max_cycles: 1 };
    writeLoopState(root, backlogState);
    const result = await runLoop(
      deps(root, backlogState, { turns: [{ sessionId: 's', completion: { status: 'done' } }] }),
    );
    expect(result).toMatchObject({ state: 'done', cycle: 1, completed_items: ['0'] });
  });
  it('advances through every backlog item when a turn returns DONE', async () => {
    const { root, state } = setup();
    writeFileSync(join(root, 'backlog.md'), '- [ ] repeated\n- [ ] repeated\n');
    const backlogState = { ...state, goal: undefined, backlog: 'backlog.md' };
    writeLoopState(root, backlogState);
    const result = await runLoop(deps(root, backlogState));
    expect(result).toMatchObject({ state: 'done', cycle: 2, completed_items: ['0', '1'] });
  });
  it('waits for rate event resume_at even if cached limits look clear', async () => {
    const { root, state } = setup();
    const auto = { ...state, auto_resume: true };
    writeLoopState(root, auto);
    let calls = 0;
    const d = deps(root, auto, {
      limits: () => null,
      turns: [
        { sessionId: 's', rateLimited: true, resetsAt: 101 },
        { sessionId: 's', completion: { status: 'done' } },
      ],
    });
    const originalTurn = d.brain.turn;
    d.brain.turn = async (...args) => {
      if (calls++ === 1) expect(d.now()).toBeGreaterThanOrEqual(161_000);
      return originalTurn(...args);
    };
    const result = await runLoop(d);
    expect(result.state).toBe('done');
    expect(calls).toBe(2);
  });
  it('uses the last structured marker and keeps BLOCKED paused despite auto resume', async () => {
    expect(parseLoopCompletion('ANAFOR_LOOP: DONE\n**`ANAFOR_LOOP: CONTINUE.`**')).toEqual({
      status: 'continue',
      marked: true,
    });
    expect(parseLoopCompletion('ordinary output')).toEqual({ status: 'continue', marked: false });
    expect(parseLoopCompletion('ANAFOR_LOOP: BLOCKED')).toEqual({
      status: 'blocked',
      reason: 'unspecified',
      marked: true,
    });
    const { root, state } = setup();
    const auto = { ...state, auto_resume: true };
    writeLoopState(root, auto);
    const result = await runLoop(
      deps(root, auto, {
        turns: [{ sessionId: 's', completion: { status: 'blocked', reason: 'needs approval' } }],
      }),
    );
    expect(result).toMatchObject({ state: 'paused', paused_reason: 'blocked: needs approval' });
  });
  it.each([
    ['error', { sessionId: null, error: true, message: 'failed' }],
    ['blocked', { sessionId: 's', completion: { status: 'blocked', reason: 'need help' } }],
    ['rate-limit', { sessionId: null, rateLimited: true }],
  ] as const)('preserves stop during a turn with %s result', async (_name, turn) => {
    const { root, state } = setup();
    const d = deps(root, state, { turns: [turn] as never });
    d.brain.turn = async () => {
      writeLoopState(root, { ...state, state: 'stopped', paused_reason: 'stopped' });
      return turn as never;
    };
    const result = await runLoop(d);
    expect(result).toMatchObject({ state: 'stopped', paused_reason: 'stopped' });
    expect(readLoopState(root)).toMatchObject({ state: 'stopped' });
  });
  it('routes an error result with rejected rate event to auto-resume without increasing errors', async () => {
    const { root, state } = setup();
    const auto = { ...state, auto_resume: true };
    writeLoopState(root, auto);
    const d = deps(root, auto, {
      turns: [
        {
          sessionId: 'sid',
          error: true,
          message: 'Claude rejected request',
          rateLimited: true,
          resetsAt: 101,
        },
        { sessionId: 'sid', completion: { status: 'done', marked: true } },
      ],
    });
    d.minTurnGapSec = 0;
    expect(await runLoop(d)).toMatchObject({ state: 'done', cycle: 2, error_count: 0 });
  });
  it('pauses after five successful turns without markers and applies the configured minimum gap', async () => {
    const { root, state } = setup();
    const waits: number[] = [];
    const d = deps(root, state, {
      turns: Array.from({ length: 5 }, () => ({
        sessionId: 's',
        completion: { status: 'continue', marked: false },
      })),
    });
    d.minTurnGapSec = 4;
    d.sleep = async (ms) => {
      waits.push(ms);
    };
    expect(await runLoop(d)).toMatchObject({
      state: 'paused',
      paused_reason: 'error: no progress marker',
    });
    expect(waits).toEqual([4000, 4000, 4000, 4000]);
  });
  it('stops with a localized reason when a backlog cannot be read', async () => {
    const { root, state } = setup();
    const result = await runLoop(deps(root, { ...state, goal: undefined, backlog: 'missing.md' }));
    expect(result).toMatchObject({ state: 'stopped' });
    expect(result.paused_reason).toContain('missing.md');
    expect(result.paused_reason).toMatch(/^error:/);
  });
  it('preserves stop during an error turn and retains the previous real session id', async () => {
    const { root, state } = setup();
    const prior = { ...state, session_id: 'prior-real-id' };
    writeLoopState(root, prior);
    const d = deps(root, prior, {
      turns: [{ sessionId: null, error: true, message: 'early failure' }],
    });
    d.brain.turn = async () => {
      writeLoopState(root, { ...prior, state: 'stopped', paused_reason: 'stopped' });
      return { sessionId: null, error: true, message: 'early failure' };
    };
    expect(await runLoop(d)).toMatchObject({ state: 'stopped', session_id: 'prior-real-id' });
  });
  it('does not persist a fabricated id or touch interactive brain.json before init', async () => {
    const { root, state } = setup();
    const brainPath = join(root, '.anafor', 'brain.json');
    writeFileSync(brainPath, '{"session_id":"interactive-id"}');
    const d = deps(root, state, {
      turns: [{ sessionId: null, error: true, message: 'failed before init' }],
    });
    d.sleep = async () => {
      writeLoopState(root, { ...state, state: 'stopped', paused_reason: 'stopped' });
    };
    await runLoop(d);
    expect(readLoopState(root)?.session_id).toBeNull();
    expect(readFileSync(brainPath, 'utf8')).toBe('{"session_id":"interactive-id"}');
  });
  it('backs off after turn errors and pauses after three even with auto resume', async () => {
    const { root, state } = setup();
    const auto = { ...state, auto_resume: true };
    writeLoopState(root, auto);
    const waits: number[] = [];
    const d = deps(root, auto, {
      turns: [1, 2, 3].map(() => ({ sessionId: 's', error: true, message: 'fake failure' })),
    });
    d.sleep = async (ms) => {
      waits.push(ms);
    };
    const result = await runLoop(d);
    expect(result).toMatchObject({
      state: 'paused',
      paused_reason: 'error: fake failure',
      error_count: 3,
    });
    expect(waits).toEqual([60_000, 120_000]);
  });
  it('routes usage-limit errors to the limit pause path', async () => {
    const { root, state } = setup();
    const result = await runLoop(
      deps(root, state, {
        turns: [{ sessionId: 's', error: true, message: 'usage limit reached' }],
      }),
    );
    expect(result).toMatchObject({
      state: 'paused',
      paused_reason: 'rate_limit_error: usage limit reached',
    });
  });
  it('keeps a completed backlog mark when the same turn reports a rejected limit event', async () => {
    const { root, state } = setup();
    writeFileSync(join(root, 'backlog.md'), '- [ ] one\n');
    const backlog = { ...state, goal: undefined, backlog: 'backlog.md' };
    writeLoopState(root, backlog);
    const result = await runLoop(
      deps(root, backlog, {
        turns: [{ sessionId: 's', rateLimited: true, completion: { status: 'done' } }],
      }),
    );
    expect(result).toMatchObject({ state: 'paused', completed_items: ['0'] });
  });
  it('preserves a manual pause written while a turn completes and records its backlog item', async () => {
    const { root, state } = setup();
    writeFileSync(join(root, 'backlog.md'), '- [ ] repeated\n');
    const backlogState = { ...state, goal: undefined, backlog: 'backlog.md' };
    writeLoopState(root, backlogState);
    const d = deps(root, backlogState);
    d.brain.turn = async () => {
      writeLoopState(root, { ...backlogState, state: 'paused', paused_reason: 'manual' });
      return { sessionId: 's', completion: { status: 'done' } };
    };
    expect(await runLoop(d)).toMatchObject({
      state: 'paused',
      paused_reason: 'manual',
      completed_items: ['0'],
    });
  });
  it('handles rate-limit event status without pausing allowed warnings', () => {
    const event = (status: string) =>
      parseBrainLine(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status } }))[0];
    expect(event('allowed_warning')).toMatchObject({ type: 'rate_limit_event', limited: false });
    expect(event('rejected')).toMatchObject({ type: 'rate_limit_event', limited: true });
  });
  it('resolves failed result, exit, error, and timeout from fake brain events', async () => {
    const run = (
      event: Parameters<Parameters<typeof runBrainTurn>[0]>[0] extends (e: infer E) => void
        ? E
        : never,
      timeout = 1000,
    ) =>
      runBrainTurn(
        (onEvent) => ({
          sessionId: 'fake',
          start: () => {
            onEvent({ type: 'init', sessionId: 'real-init-id', model: 'm' });
            onEvent(event);
            if (event.type === 'result') onEvent({ type: 'exit', code: 0 });
          },
          send: () => {},
          stop: () => {},
          kill: () => {},
        }),
        'prompt',
        timeout,
      );
    expect(
      await run({ type: 'result', ok: false, text: 'nope', costUsd: null, turns: null }),
    ).toMatchObject({ error: true, message: 'nope', sessionId: 'real-init-id' });
    expect(await run({ type: 'exit', code: 2 })).toMatchObject({ error: true });
    expect(await run({ type: 'error', message: 'spawn failed' })).toMatchObject({
      error: true,
      message: 'spawn failed',
    });
    expect(
      await runBrainTurn(
        (onEvent) => ({
          sessionId: 'ephemeral',
          start: () => onEvent({ type: 'error', message: 'failed before init' }),
          send: () => {},
          stop: () => {},
          kill: () => {},
        }),
        'prompt',
        1000,
      ),
    ).toMatchObject({ sessionId: null, error: true });
    const rejected = await runBrainTurn(
      (onEvent) => ({
        sessionId: 'fake',
        start: () => {
          onEvent({ type: 'init', sessionId: 'loop-real', model: 'm' });
          onEvent({ type: 'rate_limit_event', limited: true, resetsAt: 200 });
          onEvent({ type: 'result', ok: false, text: 'rejected', costUsd: null, turns: null });
          onEvent({ type: 'exit', code: 1 });
        },
        send: () => {},
        stop: () => {},
        kill: () => {},
      }),
      'prompt',
      1000,
    );
    expect(rejected).toMatchObject({
      sessionId: 'loop-real',
      rateLimited: true,
      error: true,
      resetsAt: 200,
    });
    let killed = false;
    const timed = await runBrainTurn(
      () => ({
        sessionId: 'fake',
        start: () => {},
        send: () => {},
        stop: () => {},
        kill: () => {
          killed = true;
        },
      }),
      'prompt',
      5,
      5,
    );
    expect(timed).toMatchObject({ error: true, message: 'Brain turn timeout' });
    expect(killed).toBe(true);
  });
  it('uses a short close grace after a successful result and kills a non-exiting fake process', async () => {
    let killed = false;
    let stopped = false;
    const result = await runBrainTurn(
      (onEvent) => ({
        sessionId: 'fake',
        start: () => {
          onEvent({ type: 'init', sessionId: 'init-id', model: 'm' });
          onEvent({ type: 'result', ok: true, text: 'ANAFOR_LOOP: DONE', costUsd: null, turns: 1 });
        },
        send: () => {},
        stop: () => {
          stopped = true;
        },
        kill: () => {
          killed = true;
        },
      }),
      'prompt',
      1000,
      5,
    );
    expect(result).toMatchObject({ sessionId: 'init-id', resultText: 'ANAFOR_LOOP: DONE' });
    expect(stopped).toBe(true);
    expect(killed).toBe(true);
  });
  it('reclaims ESRCH stale lock but refuses a live pid lock', () => {
    const { root } = setup();
    const lock = join(root, '.anafor', 'loop.lock');
    writeFileSync(lock, JSON.stringify({ pid: 2_000_000_000, started_at: 'old' }));
    expect(acquireLoopLock(root)).toBe(true);
    releaseLoopLock(root);
    writeFileSync(lock, JSON.stringify({ pid: process.pid, started_at: 'now' }));
    expect(acquireLoopLock(root)).toBe(false);
  });
  it('refuses to clean a dead loop lock while its recorded brain child is alive', () => {
    const { root } = setup();
    const lock = join(root, '.anafor', 'loop.lock');
    writeFileSync(
      lock,
      JSON.stringify({ pid: 2_000_000_000, brain_pid: process.pid, started_at: 'old' }),
    );
    expect(acquireLoopLock(root)).toBe(false);
    expect(JSON.parse(readFileSync(lock, 'utf8')).brain_pid).toBe(process.pid);
  });
  it('writes active brain PID into loop lock and shutdown handler kills, pauses and releases lock', () => {
    const { root, state } = setup();
    expect(acquireLoopLock(root)).toBe(true);
    setLoopBrainPid(root, process.pid);
    expect(JSON.parse(readFileSync(join(root, '.anafor', 'loop.lock'), 'utf8')).brain_pid).toBe(
      process.pid,
    );
    let killed = 0;
    const shutdown = createLoopShutdownHandler(root, () => killed++);
    shutdown('signal: SIGTERM');
    shutdown('process exit');
    expect(killed).toBe(1);
    expect(readLoopState(root)).toMatchObject({
      state: 'paused',
      paused_reason: 'signal: SIGTERM',
    });
    expect(acquireLoopLock(root)).toBe(true);
    releaseLoopLock(root);
  });
  it('does not overwrite an explicit stopped state during process cleanup', () => {
    const { root, state } = setup();
    acquireLoopLock(root);
    writeLoopState(root, { ...state, state: 'stopped', paused_reason: 'operator stop' });
    let killed = false;
    createLoopShutdownHandler(root, () => {
      killed = true;
    })('process exit');
    expect(killed).toBe(true);
    expect(readLoopState(root)).toMatchObject({ state: 'stopped', paused_reason: 'operator stop' });
    expect(acquireLoopLock(root)).toBe(true);
    releaseLoopLock(root);
  });
  it('does not replace loop.json when start cannot acquire the existing live lock', async () => {
    const { root, state } = setup();
    writeFileSync(join(root, '.anafor', 'loop.lock'), JSON.stringify({ pid: process.pid }));
    const oldWrite = JSON.stringify(readLoopState(root));
    expect(await runLoopCommand(root, ['start', 'replacement goal'])).toBe(1);
    expect(JSON.stringify(readLoopState(root))).toBe(oldWrite);
  });
  it('resumes a fake Claude session id on the second loop turn via ANAFOR_CLAUDE_BIN', async () => {
    const { root } = setup();
    const home = join(root, 'user-home');
    const log = join(root, 'fake-claude-args.jsonl');
    const fakeJs = join(root, 'fake-claude.cjs');
    const wrapper = join(root, process.platform === 'win32' ? 'fake-claude.cmd' : 'fake-claude');
    writeFileSync(
      join(root, '.anafor', 'config.json'),
      JSON.stringify({ loop: { min_turn_gap_sec: 0 } }),
    );
    writeFileSync(
      fakeJs,
      [
        "const fs = require('node:fs');",
        "fs.appendFileSync(process.env.ANAFOR_FAKE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
        "process.stdout.write(JSON.stringify({type:'system',subtype:'init',session_id:'fake-loop-session',model:'fake'})+'\\n');",
        "process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'ANAFOR_LOOP: CONTINUE'})+'\\n');",
      ].join('\n'),
    );
    if (process.platform === 'win32')
      writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${fakeJs}" %*\r\n`);
    else {
      writeFileSync(wrapper, `#!/usr/bin/env node\nrequire(${JSON.stringify(fakeJs)});\n`);
      chmodSync(wrapper, 0o755);
    }
    const oldHome = process.env.ANAFOR_HOME;
    const oldBin = process.env.ANAFOR_CLAUDE_BIN;
    const oldLog = process.env.ANAFOR_FAKE_LOG;
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      process.env.ANAFOR_HOME = home;
      process.env.ANAFOR_CLAUDE_BIN = wrapper;
      process.env.ANAFOR_FAKE_LOG = log;
      expect(await runLoopCommand(root, ['start', 'keep going', '--max-cycles', '2'])).toBe(0);
      const calls = readFileSync(log, 'utf8')
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as string[]);
      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain('--session-id');
      expect(
        calls[1]!.slice(calls[1]!.indexOf('--resume'), calls[1]!.indexOf('--resume') + 2),
      ).toEqual(['--resume', 'fake-loop-session']);
      expect(readLoopState(root)).toMatchObject({
        state: 'done',
        session_id: 'fake-loop-session',
        cycle: 2,
      });
      expect(existsSync(join(root, '.anafor', 'brain.json'))).toBe(false);
    } finally {
      if (oldHome === undefined) delete process.env.ANAFOR_HOME;
      else process.env.ANAFOR_HOME = oldHome;
      if (oldBin === undefined) delete process.env.ANAFOR_CLAUDE_BIN;
      else process.env.ANAFOR_CLAUDE_BIN = oldBin;
      if (oldLog === undefined) delete process.env.ANAFOR_FAKE_LOG;
      else process.env.ANAFOR_FAKE_LOG = oldLog;
      logSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
  it('defaults Pro accounts to economy and honors explicit profile override', () => {
    expect(defaultLoopProfile(undefined, { subscriptions: ['claude-pro'] } as never)).toBe('saver');
    expect(defaultLoopProfile('quality', { subscriptions: ['claude-pro'] } as never)).toBe(
      'quality',
    );
    expect(defaultLoopProfile('economy', null)).toBe('saver');
  });
  it('sends the selected token profile in the dispatch prompt', async () => {
    const { root, state } = setup();
    const profiled = { ...state, profile: 'saver' };
    writeLoopState(root, profiled);
    const d = deps(root, profiled);
    let prompt = '';
    d.brain.turn = async (p) => {
      prompt = p;
      return { sessionId: 's', completion: { status: 'done', marked: true } };
    };
    await runLoop(d);
    expect(prompt).toContain('token profili: saver');
    expect(prompt).toContain('deep inceleme önerme');
  });
  it('notes an active intervene expiry in a pause reason', async () => {
    const { root, state } = setup();
    createGrant(root, { reason: 'loop pause note test', paths: ['src/**'], ttlMin: 10 });
    const result = await runLoop(deps(root, state, { limits: highLimit }));
    expect(result.paused_reason).toContain('intervene permission may expire');
  });
  it('uses a bounded 15 minute probe when a rate event has no reset timestamp', async () => {
    const { root, state } = setup();
    const auto = { ...state, auto_resume: true };
    writeLoopState(root, auto);
    const d = deps(root, auto, {
      turns: [
        { sessionId: 's', rateLimited: true },
        { sessionId: 's', completion: { status: 'done' } },
      ],
    });
    let time = 100_000;
    d.now = () => time;
    d.sleep = async (ms) => {
      expect(ms).toBeLessThanOrEqual(600_000);
      time += ms;
    };
    expect((await runLoop(d)).state).toBe('done');
    expect(time).toBeGreaterThanOrEqual(1_000_000);
  });
  it('honors a stop flag and acquires/releases a single lock', async () => {
    const { root, state } = setup();
    writeLoopState(root, { ...state, state: 'stopped' });
    expect((await runLoop(deps(root, state))).state).toBe('stopped');
    expect(acquireLoopLock(root)).toBe(true);
    expect(acquireLoopLock(root)).toBe(false);
    releaseLoopLock(root);
    expect(acquireLoopLock(root)).toBe(true);
    releaseLoopLock(root);
  });
});
