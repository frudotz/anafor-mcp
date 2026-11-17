import { describe, expect, it } from 'vitest';
import {
  CodexAdapter,
  parseWindowsSandbox,
  windowsSandboxWarning,
} from '../../src/adapters/codex.js';

describe('Codex Windows sandbox (F16)', () => {
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
