import { describe, expect, it } from 'vitest';
import { parseCodexLine } from '../../src/adapters/codex.js';

// F0'da codex-cli 0.167.2 ile kaydedilen gerçek olay biçimleri.
describe('parseCodexLine', () => {
  it('thread.started → session', () => {
    expect(parseCodexLine('{"type":"thread.started","thread_id":"01a1"}')).toEqual([
      { type: 'session', sessionRef: '01a1' },
    ]);
  });
  it('agent_message → message', () => {
    const l =
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"merhaba"}}';
    expect(parseCodexLine(l)).toEqual([{ type: 'message', text: 'merhaba' }]);
  });
  it('command_execution → command', () => {
    const l =
      '{"type":"item.completed","item":{"id":"i","type":"command_execution","command":"npm test","aggregated_output":"","exit_code":0,"status":"completed"}}';
    expect(parseCodexLine(l)).toEqual([{ type: 'command', command: 'npm test', exitCode: 0 }]);
  });
  it('file_change → her değişiklik için bir olay', () => {
    const l =
      '{"type":"item.completed","item":{"id":"i","type":"file_change","changes":[{"path":"a.js","kind":"update"},{"path":"b.js","kind":"add"}],"status":"completed"}}';
    expect(parseCodexLine(l)).toHaveLength(2);
  });
  it('turn.completed → usage', () => {
    const l =
      '{"type":"turn.completed","usage":{"input_tokens":86837,"cached_input_tokens":68352,"cache_write_input_tokens":0,"output_tokens":437,"reasoning_output_tokens":10}}';
    expect(parseCodexLine(l)).toEqual([
      {
        type: 'usage',
        inputTokens: 86837,
        cachedInputTokens: 68352,
        outputTokens: 437,
        reasoningOutputTokens: 10,
      },
    ]);
  });
  it('turn.failed → fatal error', () => {
    const l = '{"type":"turn.failed","error":{"message":"model desteklenmiyor"}}';
    expect(parseCodexLine(l)).toEqual([
      { type: 'error', message: 'model desteklenmiyor', fatal: true },
    ]);
  });
  it('tanınmayan ve JSON olmayan satırlar yok sayılır', () => {
    expect(parseCodexLine('{"type":"turn.started"}')).toEqual([]);
    expect(parseCodexLine('Reading prompt from stdin...')).toEqual([]);
    expect(parseCodexLine('{"type":"item.started","item":{"type":"command_execution"}}')).toEqual(
      [],
    );
  });
});
