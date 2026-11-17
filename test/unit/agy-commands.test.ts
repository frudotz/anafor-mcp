import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AntigravityAdapter, parseAntigravityLine } from '../../src/adapters/google.js';
import type { JobSpec } from '../../src/adapters/types.js';

// agy 1.5.9'dan GERÇEK yakalanan satırlar (F16, 2026-11-17).
const CID = 'c58dec79-2336-468b-8c79-11e732eba34e';
const step = (state: string, extra: Record<string, unknown>) =>
  JSON.stringify({
    event: 'step_update',
    step_update: {
      conversation_id: CID,
      step_index: 2,
      state,
      step_type: 'tool',
      tool_name: 'run_command',
      tool_info: { name: 'run_command', parameters: { CommandLine: 'node -v' }, ...extra },
    },
  });

describe('agy komut olayları (gerçek biçim)', () => {
  it('izinli komut: DONE + çıktıdaki çıkış kodu', () => {
    const line = step('DONE', {
      output:
        'Created At: 2026-11-17T18:48:59+03:00\nCompleted At: 2026-11-17T18:49:01+03:00\nCommand exited with code 0.\n\nCommand output:\nv24.19.0\r\n',
    });
    expect(parseAntigravityLine(line)).toEqual([
      { type: 'command', command: 'node -v', exitCode: 0 },
    ]);
  });

  it('ACTIVE adım yok sayılır', () => {
    expect(parseAntigravityLine(step('ACTIVE', {}))).toEqual([]);
  });

  it('reddedilen komut: ERROR → komut (kodsuz) + ölümcül olmayan hata', () => {
    const line = step('ERROR', {
      error: {
        type: 'TOOL_ERROR',
        message:
          'permission check failed for unsandboxed "node -v": user denied permission to run command:\nnode -v\nDo not attempt…',
      },
    });
    const ev = parseAntigravityLine(line);
    expect(ev[0]).toEqual({ type: 'command', command: 'node -v', exitCode: null });
    expect(ev[1]).toMatchObject({
      type: 'error',
      fatal: false,
      message: /permission check failed/,
    });
  });

  it('result.denied_actions → yönlendirici hata', () => {
    const line = JSON.stringify({
      event: 'result',
      result: {
        conversation_id: CID,
        status: 'SUCCESS',
        response: '',
        usage: { input_tokens: 8753, output_tokens: 61, thinking_tokens: 15, cache_read_tokens: 0 },
        denied_actions: [{ action: 'command', display_name: 'Bash' }],
      },
    });
    const errs = parseAntigravityLine(line).filter((e) => e.type === 'error');
    expect(errs).toEqual([
      expect.objectContaining({ fatal: false, message: expect.stringMatching(/allowed_commands/) }),
    ]);
  });
});

describe('agy oturumluk komut izinleri', () => {
  const dir = mkdtempSync(join(tmpdir(), 'anafor-agy-'));
  const schema = join(dir, 's.json');
  writeFileSync(schema, JSON.stringify({ $schema: 'x', type: 'object' }));
  const job = (sandbox: JobSpec['sandbox']) =>
    ({ prompt: 'İŞ', outputSchemaPath: schema, sandbox, timeoutMs: 60_000 }) as JobSpec;
  const ctx = { artifactsDir: dir } as Parameters<AntigravityAdapter['args']>[1];
  const a = new AntigravityAdapter({
    acknowledged: true,
    allowedCommands: ['npm test', 'npm test'],
  });

  it('yazma işinde --settings birebir komut kuralları ve prompt notu', () => {
    const args = a.args(job('workspace-write'), ctx);
    const i = args.indexOf('--settings');
    expect(JSON.parse(args[i + 1]!)).toEqual({ permissions: { allow: ['command(npm test)'] } });
    expect(args[args.indexOf('-p') + 1]).toMatch(/Terminal izinleri[\s\S]*- `npm test`/);
    expect(args).not.toContain('--dangerously-skip-permissions');
  });

  it('salt okunur işte komut izni verilmez', () => {
    const args = a.args(job('read-only'), ctx);
    expect(args).not.toContain('--settings');
    expect(args[args.indexOf('-p') + 1]).toBe('İŞ');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('dosya değiştiren araç ayrımı', () => {
  it('read_file değişiklik sayılmaz, edit_file sayılır', async () => {
    const { isWriteTool } = await import('../../src/adapters/google.js');
    expect(isWriteTool('read_file')).toBe(false);
    expect(isWriteTool('view_file')).toBe(false);
    expect(isWriteTool('list_dir')).toBe(false);
    expect(isWriteTool('edit_file')).toBe(true);
    expect(isWriteTool('write_file')).toBe(true);
    expect(isWriteTool('replace')).toBe(true);
  });
});
