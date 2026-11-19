import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { recordPermissionDenied } from '../../src/hooks/permission-denied.js';
import { collectPermissionReport } from '../../src/cli/permissions-cmd.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function project() {
  const root = mkdtempSync(join(tmpdir(), 'anafor-permissions-'));
  dirs.push(root);
  mkdirSync(join(root, '.anafor'));
  return root;
}

describe('permission denial metrics', () => {
  it('masks secrets, truncates summaries, and tolerates absent fields', () => {
    const root = project();
    recordPermissionDenied({
      cwd: root,
      tool_name: 'Bash',
      tool_input: { command: `echo token=secret ${'x'.repeat(300)}` },
      reason: 'password:secret',
    });
    recordPermissionDenied({ cwd: root });
    const lines = readFileSync(join(root, '.anafor/metrics/permissions.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines[0].tool_input).toContain('token=[REDACTED]');
    expect(lines[0].tool_input.length).toBeLessThanOrEqual(200);
    expect(lines[0].reason).toContain('password:[REDACTED]');
    expect(lines[1].tool).toBe('{}');
  });

  it('masks JSON-shaped secrets, bearer headers and common token prefixes', () => {
    const root = project();
    recordPermissionDenied({
      cwd: root,
      tool_name: 'Bash',
      tool_input: {
        api_key: 'abc123',
        github_token: 'zzz',
        command:
          'curl -H "Authorization: Bearer eyJhbGci.payload.sig" ghp_abcdefghijk sk-ABCDEFGHIJ',
      },
    });
    const line = JSON.parse(
      readFileSync(join(root, '.anafor/metrics/permissions.jsonl'), 'utf8').trim(),
    );
    for (const secret of ['abc123', 'zzz', 'eyJhbGci', 'ghp_abcdefghijk', 'sk-ABCDEFGHIJ'])
      expect(line.tool_input).not.toContain(secret);
    expect(line.tool_input).toContain('[REDACTED]');
  });

  it('summarizes observations and only suggests narrow commands', () => {
    const root = project();
    const path = join(root, '.anafor/metrics');
    mkdirSync(path);
    const now = Date.now();
    const samples = [
      {
        time: new Date(now).toISOString(),
        tool: 'Bash',
        tool_input: JSON.stringify({ command: 'npm run check' }),
        reason: 'policy',
        session_id: 's1',
      },
      {
        time: new Date(now).toISOString(),
        tool: 'Bash',
        tool_input: JSON.stringify({ command: 'Bash(*)' }),
        reason: 'policy',
        session_id: 's1',
      },
      {
        time: new Date(now).toISOString(),
        tool: 'Edit',
        tool_input: '{}',
        reason: 'edit denied',
        session_id: 's2',
      },
    ];
    writeFileSync(
      join(path, 'permissions.jsonl'),
      samples.map((sample) => JSON.stringify(sample)).join('\n'),
    );
    const report = collectPermissionReport(root, 7, now);
    expect(report.total).toBe(3);
    expect(report.sessions).toContainEqual({ session: 's1', count: 2 });
    expect(report.suggestions).toEqual(['Bash(npm run check)']);
    expect(report.suggestions).not.toContain('Bash(*)');
  });
});
