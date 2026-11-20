import { describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  utimesSync,
} from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { recoveryDecision, recoverLoop, recoverTrigger } from '../../src/loop/recover.js';
import { watchdogCommand } from '../../src/loop/watchdog.js';
import {
  updateLoopHeartbeat,
  writeLoopState,
  readLoopState,
  type LoopState,
} from '../../src/loop/state.js';
import { runLoopCommand } from '../../src/cli/loop-cmd.js';

const sample = (
  state: LoopState['state'] = 'running',
  heartbeat = new Date(0).toISOString(),
): LoopState => ({
  state,
  cycle: 1,
  session_id: 'session',
  started_at: new Date(0).toISOString(),
  heartbeat_at: heartbeat,
  paused_reason: null,
  resume_at: null,
  auto_resume: false,
  max_cycles: null,
  until: null,
  last_task: null,
  completed_items: [],
});
const tempRoot = (name: string) => {
  mkdirSync(join(process.cwd(), '.anafor-tmp'), { recursive: true });
  return mkdtempSync(join(process.cwd(), '.anafor-tmp', `${name}-`));
};
const fixture = (root: string, state = sample(), lock?: object) => {
  mkdirSync(join(root, '.anafor'), { recursive: true });
  writeLoopState(root, state);
  if (lock) writeFileSync(join(root, '.anafor', 'loop.lock'), JSON.stringify(lock));
};
const child = (pid = 987) =>
  ((_: string, __: string[], options: { stdio?: unknown }) => {
    expect(options.stdio).toBeDefined();
    return { pid, unref() {} };
  }) as never;

describe('loop crash recovery', () => {
  it('updates only the heartbeat with an atomic state replacement', () => {
    const root = tempRoot('heartbeat');
    try {
      fixture(root);
      updateLoopHeartbeat(root, 123_000);
      expect(readLoopState(root)?.heartbeat_at).toBe(new Date(123_000).toISOString());
      expect({ ...readLoopState(root), heartbeat_at: new Date(0).toISOString() }).toEqual(sample());
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers only for a dead owner and old heartbeat; skips live, fresh, stopped and done', () => {
    expect(recoveryDecision(sample(), 42, 181_000, () => false)).toBe('recover');
    expect(recoveryDecision(sample(), 42, 181_000, () => true)).toBe('ignore');
    expect(
      recoveryDecision(
        sample('running', new Date(100_000).toISOString()),
        42,
        181_000,
        () => false,
      ),
    ).toBe('ignore');
    expect(recoveryDecision(sample('stopped'), 42, 181_000, () => false)).toBe('ignore');
    expect(recoveryDecision(sample('done'), 42, 181_000, () => false)).toBe('ignore');
  });

  it('serializes recover calls from two independent Node processes', async () => {
    const root = tempRoot('concurrent');
    try {
      fixture(root, sample(), { pid: 99999999, brain_pid: null });
      const moduleUrl = pathToFileURL(join(process.cwd(), 'dist', 'loop', 'recover.js')).href;
      const script = `import { recoverLoop } from ${JSON.stringify(moduleUrl)}; const ok = await recoverLoop(process.argv[1], { spawnChild: () => ({ unref() {} }) }); console.log(ok ? 'takeover' : 'skip');`;
      const run = () =>
        new Promise<string>((resolve, reject) => {
          const proc = spawn(process.execPath, ['-e', script, root], {
            cwd: homedir(),
            env: { ...process.env, ANAFOR_DISABLE_BACKGROUND: '1' },
            windowsHide: true,
          });
          let output = '';
          proc.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()));
          proc.on('error', reject);
          proc.on('close', (code) =>
            code === 0
              ? resolve(output.trim())
              : reject(new Error(`child exited ${code}: ${output}`)),
          );
        });
      const results = await Promise.all([run(), run()]);
      expect(results.filter((result) => result === 'takeover')).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('skips a live brain process and reclaims an old dead guard', async () => {
    const root = tempRoot('guards');
    try {
      fixture(root, sample(), { pid: 42, brain_pid: 88 });
      expect(await recoverLoop(root, { now: 181_000, isAlive: (pid) => pid === 88 })).toBe(false);
      const guard = join(root, '.anafor', 'loop.recover.lock');
      writeFileSync(guard, JSON.stringify({ pid: 44, started_at: new Date(0).toISOString() }));
      expect(
        await recoverLoop(root, { now: 181_000, isAlive: () => false, spawnChild: child() }),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reclaims an empty guard only after its mtime is older than ten minutes', async () => {
    const root = tempRoot('empty-guard');
    try {
      fixture(root);
      const guard = join(root, '.anafor', 'loop.recover.lock');
      writeFileSync(guard, '');
      const old = new Date(Date.now() - 11 * 60_000);
      utimesSync(guard, old, old);
      expect(await recoverLoop(root, { isAlive: () => false, spawnChild: child() })).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('recovers a stale running loop even when loop.lock is missing', async () => {
    const root = tempRoot('missing-lock');
    try {
      fixture(root);
      expect(
        await recoverLoop(root, { now: 181_000, isAlive: () => false, spawnChild: child() }),
      ).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('starts recovery children from home with the project root in env and arguments', async () => {
    const root = tempRoot('detached-root');
    try {
      fixture(root);
      let received:
        { args: string[]; options: { cwd?: string; env?: NodeJS.ProcessEnv } } | undefined;
      const spawnChild = ((
        _: string,
        args: string[],
        options: { cwd?: string; env?: NodeJS.ProcessEnv },
      ) => {
        received = { args, options };
        return { pid: 987, unref() {} };
      }) as never;
      expect(await recoverLoop(root, { now: 181_000, isAlive: () => false, spawnChild })).toBe(
        true,
      );
      expect(received?.options.cwd).toBe(homedir());
      expect(received?.options.env?.ANAFOR_PROJECT_ROOT).toBe(root);
      expect(received?.args).toContain('--project-root');
      expect(received?.args).toContain(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('lets stop win before the detached recovery child resumes', async () => {
    const root = tempRoot('stop');
    try {
      fixture(root, sample(), { pid: 42 });
      expect(
        await recoverLoop(root, { now: 181_000, isAlive: () => false, spawnChild: child() }),
      ).toBe(true);
      writeLoopState(root, sample('stopped'));
      expect(await runLoopCommand(root, ['_recover-resume'])).toBe(0);
      expect(readLoopState(root)?.state).toBe('stopped');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('throttles triggers and does not launch outside initialized running projects', () => {
    const root = tempRoot('trigger');
    try {
      let starts = 0;
      const enabledEnv = { ...process.env };
      delete enabledEnv.ANAFOR_DISABLE_BACKGROUND;
      const spawnChild = ((
        _: string,
        args: string[],
        options: { cwd?: string; env?: NodeJS.ProcessEnv },
      ) => {
        starts++;
        expect(options.cwd).toBe(homedir());
        expect(options.env?.ANAFOR_PROJECT_ROOT).toBe(root);
        expect(args).toContain(root);
        return { unref() {} };
      }) as never;
      fixture(root, sample('running', new Date(440_000).toISOString()));
      expect(recoverTrigger(root, { now: 500_000, spawnChild, env: enabledEnv })).toBe(false);
      expect(existsSync(join(root, '.anafor', 'loop.recover-trigger'))).toBe(false);
      fixture(root, sample('paused'));
      expect(recoverTrigger(root, { now: 500_000, spawnChild, env: enabledEnv })).toBe(false);
      fixture(root);
      expect(
        recoverTrigger(root, {
          now: 500_000,
          spawnChild,
          env: { ...enabledEnv, ANAFOR_DISABLE_BACKGROUND: '1' },
        }),
      ).toBe(false);
      expect(recoverTrigger(root, { now: 500_000, spawnChild, env: enabledEnv })).toBe(true);
      expect(recoverTrigger(root, { now: 600_000, spawnChild, env: enabledEnv })).toBe(false);
      expect(recoverTrigger(root, { now: 800_001, spawnChild, env: enabledEnv })).toBe(true);
      expect(starts).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses hidden Windows watchdog wrapper with correctly quoted spaced paths and reports failures', () => {
    const root = join(tempRoot('watchdog'), 'Project With Spaces ÇığÖşü');
    mkdirSync(root, { recursive: true });
    try {
      let received: string[] = [];
      const runner = (_: string, args: string[]) => {
        received = args;
        return { status: 0 };
      };
      expect(watchdogCommand('install', 'win32', runner, root).code).toBe(0);
      expect(received).toContain('/SC');
      expect(received).toContain('MINUTE');
      expect(received).toContain('/MO');
      expect(received).toContain('5');
      expect(received).toContain('/RL');
      expect(received).toContain('LIMITED');
      const taskCommand = received[received.indexOf('/TR') + 1]!;
      expect(taskCommand).toContain('wscript.exe');
      expect(taskCommand).toContain('Project With Spaces');
      expect(taskCommand.length).toBeLessThanOrEqual(261);
      const scriptBuffer = readFileSync(join(root, '.anafor', 'loop-recover.vbs'));
      expect(scriptBuffer.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
      const script = scriptBuffer.subarray(2).toString('utf16le');
      expect(script).toContain('Chr(34)');
      expect(script).toContain(process.execPath);
      expect(script).toContain('Project With Spaces ÇığÖşü');
      watchdogCommand('uninstall', 'win32', runner, root);
      const taskName = `AnaforLoopRecover-${createHash('sha256').update(root).digest('hex').slice(0, 8)}`;
      expect(received).toEqual(['/Delete', '/TN', taskName, '/F']);
      expect(existsSync(join(root, '.anafor', 'loop-recover.vbs'))).toBe(false);
      watchdogCommand('status', 'win32', runner, root);
      expect(received).toEqual(['/Query', '/TN', taskName]);
      const failure = watchdogCommand('install', 'win32', () => ({ status: 5 }), root);
      expect(failure.code).toBe(1);
      let called = false;
      const tooLong = watchdogCommand(
        'install',
        'win32',
        () => {
          called = true;
          return { status: 0 };
        },
        `C:\\${'x'.repeat(280)}`,
      );
      expect(tooLong.code).toBe(1);
      expect(called).toBe(false);
      const guidance = watchdogCommand('install', 'linux', runner, root).lines.join('\n');
      expect(guidance).toContain('*/5 * * * *');
      expect(guidance).toContain('<integer>300</integer>');
      expect(watchdogCommand('uninstall', 'linux', runner, root).lines.join(' ')).toContain(
        'kaldırın',
      );
      expect(watchdogCommand('status', 'linux', runner, root).lines.join(' ')).toContain(
        'denetleyin',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
