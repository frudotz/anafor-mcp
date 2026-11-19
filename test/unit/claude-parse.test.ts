import { describe, expect, it } from 'vitest';
import { parseClaudeLine } from '../../src/adapters/cirak.js';

// claude 2.1.325 `-p --output-format stream-json --verbose --json-schema` ile kaydedilen biçimler.
describe('parseClaudeLine', () => {
  it('system/init → session', () => {
    expect(
      parseClaudeLine('{"type":"system","subtype":"init","session_id":"s-1","cwd":"x"}'),
    ).toEqual([{ type: 'session', sessionRef: 's-1' }]);
  });
  it('assistant tool_use: Bash/PowerShell → command, Write → file_change, text → message', () => {
    const l = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '' },
          { type: 'text', text: 'başlıyorum' },
          { type: 'tool_use', name: 'PowerShell', input: { command: 'npm test' } },
          { type: 'tool_use', name: 'Write', input: { file_path: 'a.ts', content: 'x' } },
          { type: 'tool_use', name: 'StructuredOutput', input: {} },
        ],
      },
    });
    expect(parseClaudeLine(l)).toEqual([
      { type: 'message', text: 'başlıyorum' },
      { type: 'command', command: 'npm test', exitCode: null },
      { type: 'file_change', path: 'a.ts', kind: 'write' },
    ]);
  });
  it('permission_denied → fatal olmayan hata', () => {
    expect(
      parseClaudeLine('{"type":"system","subtype":"permission_denied","tool_name":"Bash"}'),
    ).toEqual([{ type: 'error', message: 'izin reddedildi: Bash', fatal: false }]);
  });
  it('result: usage + structured_output son mesaj olur', () => {
    const l = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 100,
        cache_read_input_tokens: 1000,
        output_tokens: 50,
      },
      structured_output: { a: 1 },
      result: '',
    });
    expect(parseClaudeLine(l)).toEqual([
      { type: 'usage', inputTokens: 1110, cachedInputTokens: 1000, outputTokens: 50 },
      { type: 'message', text: '{"a":1}' },
    ]);
  });
  it('result is_error → fatal hata', () => {
    const evs = parseClaudeLine('{"type":"result","is_error":true,"result":"limit","usage":{}}');
    expect(evs).toContainEqual({ type: 'error', message: 'limit', fatal: true });
  });
  it('diğerleri yok sayılır', () => {
    expect(parseClaudeLine('{"type":"rate_limit_event"}')).toEqual([]);
    expect(parseClaudeLine('{"type":"user","message":{"content":[]}}')).toEqual([]);
  });
});

describe('subscriptionEnv', () => {
  it('ANTHROPIC_API_KEY çıkarılır, açık tercihle korunur', async () => {
    const { subscriptionEnv } = await import('../../src/adapters/cirak.js');
    expect(subscriptionEnv({ ANTHROPIC_API_KEY: 'x', A: '1' })).toEqual({ A: '1' });
    expect(
      subscriptionEnv({ ANTHROPIC_API_KEY: 'x', ANAFOR_CLAUDE_USE_API_KEY: '1' }).ANTHROPIC_API_KEY,
    ).toBe('x');
  });
});
