import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOKEN_PROFILES } from '../../src/core/token-profile.js';
import { BrainSession, briefInput, parseBrainLine } from '../../src/chat/brain.js';
import {
  awaitDecision,
  decidePermission,
  pendingRequests,
  rememberedAllow,
  resetRemembered,
  respond,
  submitRequest,
} from '../../src/chat/permissions.js';
import { renderBrainEvent } from '../../src/cli/chat.js';
import { tempDir } from '../helpers.js';

describe('beyin akışı ayrıştırma', () => {
  it('init, metin, araç (anafor öneki kısaltılır), sonuç', () => {
    expect(
      parseBrainLine('{"type":"system","subtype":"init","session_id":"s1","model":"m"}'),
    ).toEqual([{ type: 'init', sessionId: 's1', model: 'm' }]);
    const a = parseBrainLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'tamam' },
            {
              type: 'tool_use',
              name: 'mcp__plugin_anafor_anafor__job_dispatch',
              input: { task_id: 'T-1' },
            },
          ],
        },
      }),
    );
    expect(a).toEqual([
      { type: 'text', text: 'tamam' },
      { type: 'tool', name: 'anafor:job_dispatch', brief: 'T-1' },
    ]);
    expect(
      parseBrainLine(
        '{"type":"result","is_error":false,"total_cost_usd":0.1,"num_turns":3,"result":"x"}',
      ),
    ).toEqual([{ type: 'result', ok: true, costUsd: 0.1, turns: 3, text: 'x' }]);
    expect(parseBrainLine('düz metin')).toEqual([]);
  });

  it('kısa girdi özeti', () => {
    expect(briefInput('Bash', { command: 'npm test' })).toBe('npm test');
    expect(briefInput('x', { command: 'a'.repeat(200) }).length).toBe(98);
  });

  it('çıktı satırları', () => {
    expect(renderBrainEvent({ type: 'text', text: 'merhaba' })).toContain('merhaba');
    expect(
      renderBrainEvent({ type: 'result', ok: true, costUsd: 0.12, turns: 2, text: '' }),
    ).toContain('API eşdeğeri');
    expect(
      renderBrainEvent({ type: 'rate_limit_event', limited: false, resetsAt: null }),
    ).toBeNull();
    expect(renderBrainEvent({ type: 'rate_limit_event', limited: true, resetsAt: null })).toContain(
      'rate limit',
    );
  });

  it('beyin süreci argümanları: plugin, izin aracı, yeni oturum kimliği; izin atlatma yok', () => {
    const t = tempDir();
    try {
      const b = new BrainSession(
        { root: t.dir, newSession: true, pluginDir: 'P' },
        () => undefined,
      );
      const args = b.args();
      expect(args).toContain('--input-format');
      expect(args[args.indexOf('--plugin-dir') + 1]).toBe('P');
      expect(args[args.indexOf('--permission-prompt-tool') + 1]).toBe(
        'mcp__plugin_anafor_anafor__permission_prompt',
      );
      expect(args).toContain('--session-id');
      expect(args.join(' ')).not.toMatch(/bypass|dangerously/);
    } finally {
      t.cleanup();
    }
  });

  it('isolated loop session uses explicit resume id and effort without interactive brain.json', () => {
    const t = tempDir();
    try {
      mkdirSync(join(t.dir, '.anafor'), { recursive: true });
      writeFileSync(
        join(t.dir, '.anafor', 'brain.json'),
        JSON.stringify({ session_id: 'interactive' }),
      );
      const b = new BrainSession(
        {
          root: t.dir,
          isolated: true,
          sessionId: 'loop-id',
          resumeSessionId: 'loop-id',
          effort: TOKEN_PROFILES.saver.implementation,
        },
        () => {},
      );
      const args = b.args();
      expect(args.slice(args.indexOf('--resume'), args.indexOf('--resume') + 2)).toEqual([
        '--resume',
        'loop-id',
      ]);
      expect(args.slice(args.indexOf('--effort'), args.indexOf('--effort') + 2)).toEqual([
        '--effort',
        'medium',
      ]);
      expect(args).not.toContain('interactive');
    } finally {
      t.cleanup();
    }
  });
});

describe('izin aracısı (broker)', () => {
  it('istek → yanıt → karar; "daima" hatırlanır', async () => {
    const t = tempDir();
    try {
      resetRemembered(t.dir);
      const p = decidePermission(t.dir, 'Bash', { command: 'npm test' }, 5000);
      await new Promise((r) => setTimeout(r, 100));
      const [req] = pendingRequests(t.dir);
      expect(req?.tool_name).toBe('Bash');
      respond(t.dir, req!.id, { behavior: 'allow', remember: true });
      expect(await p).toEqual({ behavior: 'allow', updatedInput: { command: 'npm test' } });
      expect(rememberedAllow(t.dir)).toEqual(['Bash']);
      // hatırlanan araç artık sorulmadan izinli
      expect(await decidePermission(t.dir, 'Bash', { command: 'x' }, 100)).toMatchObject({
        behavior: 'allow',
      });
      expect(pendingRequests(t.dir)).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });

  it('red ve zaman aşımında ret', async () => {
    const t = tempDir();
    try {
      const req = submitRequest(t.dir, 'Write', {});
      respond(t.dir, req.id, { behavior: 'deny', message: 'hayır' });
      expect(await awaitDecision(t.dir, req, 1000)).toMatchObject({ behavior: 'deny' });
      const late = await decidePermission(t.dir, 'Edit', {}, 300);
      expect(late).toMatchObject({ behavior: 'deny' });
      expect(pendingRequests(t.dir)).toHaveLength(0);
    } finally {
      t.cleanup();
    }
  });
});
