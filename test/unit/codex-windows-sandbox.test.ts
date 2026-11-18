import { describe, expect, it, vi } from 'vitest';
import { ClaudeLiteAdapter } from '../../src/adapters/claude-lite.js';
import { writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CodexAdapter,
  codexProviderWarning,
  parseWindowsSandbox,
  parseCodexUserConfig,
  windowsSandboxWarning,
} from '../../src/adapters/codex.js';
import { DEFAULT_CONFIG, loadConfig } from '../../src/core/config.js';

describe('Codex Windows sandbox (F16)', () => {
  it('isolate forwards only safe top-level settings and windows sandbox', () => {
    const config = parseCodexUserConfig(
      `model = "user # model" # comment\nmodel_provider='vendor'\nmodel_reasoning_effort = "high"\nmcp_servers = { private = true }\nplugins = ["personal"]\n[windows]\nsandbox = "elevated" # safe\n[projects]\nfoo = "bar"`,
    );
    expect(config).toEqual({
      model: 'user # model',
      model_provider: 'vendor',
      model_reasoning_effort: 'high',
      windowsSandbox: 'elevated',
    });
  });

  it('isolate args apply job values over user settings for start and resume', () => {
    const job = {
      jobId: 'j',
      taskId: 't',
      role: 'implementation' as const,
      prompt: '',
      outputSchemaPath: 's',
      workdir: '.',
      sandbox: 'workspace-write' as const,
      timeoutMs: 1,
      model: 'job-model',
      effort: 'low' as const,
      resumeSessionRef: 'session',
    };
    const home = mkdtempSync(join(tmpdir(), 'anafor-codex-test-'));
    try {
      writeFileSync(
        join(home, 'config.toml'),
        'model = "user-model"\nmodel_provider = "vendor"\nmodel_reasoning_effort = "high"\nmcp_servers = { private = true }\nplugins = ["private"]\n[windows]\nsandbox = "elevated"',
      );
      const ctx = { artifactsDir: '.', env: { CODEX_HOME: home } };
      const adapter = new CodexAdapter({ platform: 'win32', windowsSandbox: 'unelevated' });
      const start = adapter.startArgs(job, ctx);
      const resume = adapter.resumeArgs(job, ctx);
      expect(start).toContain('--ignore-user-config');
      expect(resume).toContain('--ignore-user-config');
      for (const args of [start, resume]) {
        expect(args).toContain('features.apps=false');
        expect(args).toContain('features.image_generation=false');
        expect(args).toContain('web_search="disabled"');
      }
      expect(start).toContain('-m');
      expect(start).toContain('job-model');
      expect(start).toContain('model_reasoning_effort="low"');
      expect(start).toContain('windows.sandbox="unelevated"');
      expect(start.filter((arg) => arg.startsWith('model_reasoning_effort=')).length).toBe(1);
      expect(start.filter((arg) => arg.startsWith('windows.sandbox=')).length).toBe(1);
      expect(
        start.filter((arg) => arg === 'job-model' || arg === 'model="user-model"').length,
      ).toBe(1);
      expect(start).not.toContain('mcp_servers');
      expect(start).not.toContain('plugins');
      expect(start).not.toContain('model_provider="vendor"');
      expect(start).not.toContain('model="user-model"');
      expect(resume).toContain('session');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('inherit leaves Codex user configuration enabled', () => {
    const job = {
      jobId: 'j',
      taskId: 't',
      role: 'implementation' as const,
      prompt: '',
      outputSchemaPath: 's',
      workdir: '.',
      sandbox: 'workspace-write' as const,
      timeoutMs: 1,
    };
    const args = new CodexAdapter({ userConfig: 'inherit' }).startArgs(job, {
      artifactsDir: '.',
      env: {},
    });
    expect(args).not.toContain('--ignore-user-config');
    expect(args).not.toContain('model_provider');
    const resumeArgs = new CodexAdapter({ userConfig: 'inherit' }).resumeArgs(
      { ...job, resumeSessionRef: 'session' },
      { artifactsDir: '.', env: {} },
    );
    expect(resumeArgs).not.toContain('--ignore-user-config');
    expect(resumeArgs).not.toContain('features.apps=false');
  });

  it('unknown runtime user_config values fail closed to isolation', () => {
    const job = {
      jobId: 'j',
      taskId: 't',
      role: 'implementation' as const,
      prompt: '',
      outputSchemaPath: 's',
      workdir: '.',
      sandbox: 'workspace-write' as const,
      timeoutMs: 1,
    };
    const args = new CodexAdapter({ userConfig: 'unexpected' as never }).startArgs(job, {
      artifactsDir: '.',
      env: {},
    });
    expect(args).toContain('--ignore-user-config');
    const dir = mkdtempSync(join(tmpdir(), 'anafor-invalid-config-'));
    try {
      writeFileSync(join(dir, 'schema.json'), '{"type":"object"}');
      const claudeArgs = new ClaudeLiteAdapter({ userConfig: 'unexpected' as never }).args({
        ...job,
        outputSchemaPath: join(dir, 'schema.json'),
        workdir: dir,
      });
      expect(claudeArgs).toContain('--disable-slash-commands');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns when isolate would drop a custom provider', () => {
    expect(codexProviderWarning({ model_provider: 'local-provider' }, 'isolate')).toMatch(
      /inherit/,
    );
    expect(codexProviderWarning({ model_provider: 'openai' }, 'isolate')).toBeNull();
    expect(codexProviderWarning({ model_provider: 'local-provider' }, 'inherit')).toBeNull();
  });

  it('does not forward a user model name when its custom provider is not inherited', () => {
    const home = mkdtempSync(join(tmpdir(), 'anafor-provider-config-'));
    try {
      writeFileSync(
        join(home, 'config.toml'),
        'model = "private-model"\nmodel_provider = "private-provider"',
      );
      const args = new CodexAdapter().startArgs(
        {
          jobId: 'j',
          taskId: 't',
          role: 'implementation',
          prompt: '',
          outputSchemaPath: 's',
          workdir: '.',
          sandbox: 'workspace-write',
          timeoutMs: 1,
        },
        { artifactsDir: '.', env: { CODEX_HOME: home } },
      );
      expect(args).not.toContain('model="private-model"');
      expect(args).not.toContain('private-model');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('ignores array tables, nested sections, dotted keys, and multiline string contents', () => {
    const config = parseCodexUserConfig(
      `[[profiles]]\nmodel = "array-table-model"\nmodel.x = "dotted-model"\n[windows.x]\nsandbox = "elevated"\nscript = """\nmodel = "evil"\n"""`,
    );
    expect(config.model).toBeUndefined();
    expect(config.windowsSandbox).toBeUndefined();
    expect(parseCodexUserConfig('"model" = "quoted-safe-model"').model).toBe('quoted-safe-model');
    expect(parseCodexUserConfig('[profiles."a]b"]\nmodel = "hidden-model"').model).toBeUndefined();
  });

  it('loadConfig reports invalid user_config through localized validation', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anafor-invalid-config-'));
    try {
      writeFileSync(
        join(dir, 'anafor.config.json'),
        JSON.stringify({ workers: { codex: { user_config: 'nope' } } }),
      );
      expect(() => loadConfig(dir)).toThrow(/workers\.codex\.user_config/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadConfig does not mutate default workers across repeated loads', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anafor-default-workers-'));
    const before = structuredClone(DEFAULT_CONFIG.workers);
    try {
      const first = loadConfig(dir);
      const second = loadConfig(dir);
      expect(DEFAULT_CONFIG.workers).toEqual(before);
      expect(first.workers).not.toBe(DEFAULT_CONFIG.workers);
      expect(second.workers).not.toBe(DEFAULT_CONFIG.workers);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('merges worker settings from local and project config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anafor-merge-workers-'));
    const localDir = join(dir, '.anafor');
    try {
      mkdirSync(localDir);
      writeFileSync(
        join(localDir, 'config.json'),
        JSON.stringify({ workers: { codex: { model: 'local-model' } } }),
      );
      writeFileSync(
        join(dir, 'anafor.config.json'),
        JSON.stringify({
          workers: { codex: { enabled: true }, custom: { model: 'custom-model' } },
        }),
      );
      const workers = loadConfig(dir).workers;
      expect(workers.codex?.model).toBe('local-model');
      expect(workers.codex?.enabled).toBe(true);
      expect(Object.hasOwn(workers.custom!, 'user_config')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores project-level inherit with a warning but honors local inherit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anafor-project-inherit-'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      writeFileSync(
        join(dir, 'anafor.config.json'),
        JSON.stringify({ workers: { codex: { user_config: 'inherit' } } }),
      );
      expect(loadConfig(dir).workers.codex?.user_config).toBe('isolate');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('anafor.config.json'));
      const localDir = join(dir, '.anafor');
      mkdirSync(localDir);
      writeFileSync(
        join(localDir, 'config.json'),
        JSON.stringify({ workers: { codex: { user_config: 'inherit' } } }),
      );
      expect(loadConfig(dir).workers.codex?.user_config).toBe('inherit');
    } finally {
      warn.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('claude-lite disables slash commands by default and allows inherit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anafor-config-test-'));
    try {
      const schema = join(dir, 'schema.json');
      writeFileSync(schema, '{"type":"object"}');
      const job = {
        jobId: 'j',
        taskId: 't',
        role: 'implementation' as const,
        prompt: '',
        outputSchemaPath: schema,
        workdir: dir,
        sandbox: 'workspace-write' as const,
        timeoutMs: 1,
      };
      expect(new ClaudeLiteAdapter().args(job)).toContain('--disable-slash-commands');
      expect(new ClaudeLiteAdapter({ userConfig: 'inherit' }).args(job)).not.toContain(
        '--disable-slash-commands',
      );
      expect(new ClaudeLiteAdapter().args(job)).toContain('--strict-mcp-config');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('config.toml [windows] sandbox okunur', () => {
    const toml = '[desktop]\nsandbox = "x"\n\n[windows]\r\nsandbox = "unelevated"\n\n[tui]\n';
    expect(parseWindowsSandbox(toml)).toBe('unelevated');
    expect(parseWindowsSandbox('windows.sandbox = "elevated"\n')).toBe('elevated');
    expect(parseWindowsSandbox('[sandbox_workspace_write]\nnetwork_access = true\n')).toBeNull();
    expect(parseWindowsSandbox('[desktop]\nsandbox = "elevated"\n')).toBeNull();
  });

  it('elevated dışındaki her durumda uyarı verir', () => {
    expect(windowsSandboxWarning('elevated')).toBeNull();
    expect(windowsSandboxWarning('unelevated')).toMatch(/EPERM.*windows_sandbox/s);
    expect(windowsSandboxWarning(null)).toMatch(/varsayılan/);
  });

  it("ezme yalnızca Windows'ta argümana eklenir", () => {
    expect(
      new CodexAdapter({ windowsSandbox: 'elevated', platform: 'win32' }).sandboxArgs(),
    ).toEqual(['-c', 'windows.sandbox="elevated"']);
    expect(
      new CodexAdapter({ windowsSandbox: 'elevated', platform: 'linux' }).sandboxArgs(),
    ).toEqual([]);
    expect(new CodexAdapter({ platform: 'win32' }).sandboxArgs()).toEqual([]);
  });
});
