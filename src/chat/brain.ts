import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { subscriptionEnv } from '../adapters/claude-lite.js';
import { parseClaudeRateLimitInfo, recordLimits, statusFrom } from '../limits/limits.js';

/** Beyin oturumundan gelen, ekranda gösterilecek olaylar. */
export type BrainEvent =
  | { type: 'init'; sessionId: string; model: string }
  | { type: 'text'; text: string }
  | { type: 'tool'; name: string; brief: string }
  | { type: 'result'; ok: boolean; costUsd: number | null; turns: number | null; text: string }
  | { type: 'error'; message: string }
  | { type: 'exit'; code: number | null };

/** Araç girdisinden kısa, tek satırlık özet. */
export function briefInput(name: string, input: Record<string, unknown>): string {
  const pick =
    input.command ??
    input.file_path ??
    input.pattern ??
    input.task_id ??
    input.job_id ??
    input.title ??
    input.job_ids;
  const s = typeof pick === 'string' ? pick : pick !== undefined ? JSON.stringify(pick) : '';
  return s.length > 100 ? s.slice(0, 97) + '…' : s;
}

/** Claude Code stream-json çıktı satırı → BrainEvent'ler. */
export function parseBrainLine(line: string): BrainEvent[] {
  if (!line.trim().startsWith('{')) return [];
  const ev = JSON.parse(line) as Record<string, unknown>;
  if (ev.type === 'system' && ev.subtype === 'init') {
    return [
      { type: 'init', sessionId: String(ev.session_id ?? ''), model: String(ev.model ?? '') },
    ];
  }
  if (
    ev.type === 'rate_limit_event' &&
    ev.rate_limit_info &&
    typeof ev.rate_limit_info === 'object'
  ) {
    const windows = parseClaudeRateLimitInfo(ev.rate_limit_info as Record<string, unknown>);
    if (windows.length) {
      recordLimits({
        worker: 'claude',
        source: 'beyin oturumu',
        observed_at: new Date().toISOString(),
        status: statusFrom(windows),
        windows,
      });
    }
    return [];
  }
  if (ev.type === 'assistant' && ev.message && typeof ev.message === 'object') {
    const out: BrainEvent[] = [];
    for (const c of ((ev.message as { content?: unknown[] }).content ?? []) as Record<
      string,
      unknown
    >[]) {
      if (c.type === 'text' && typeof c.text === 'string' && c.text.trim())
        out.push({ type: 'text', text: c.text });
      if (c.type === 'tool_use') {
        const name = String(c.name ?? '').replace(
          /^mcp__plugin_anafor_anafor__|^mcp__anafor__/,
          'anafor:',
        );
        out.push({
          type: 'tool',
          name,
          brief: briefInput(name, (c.input ?? {}) as Record<string, unknown>),
        });
      }
    }
    return out;
  }
  if (ev.type === 'result') {
    return [
      {
        type: 'result',
        ok: ev.is_error !== true,
        costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : null,
        turns: typeof ev.num_turns === 'number' ? ev.num_turns : null,
        text: typeof ev.result === 'string' ? ev.result : '',
      },
    ];
  }
  return [];
}

export interface BrainOptions {
  root: string;
  pluginDir?: string;
  bin?: string;
  model?: string;
  allowedTools?: string[];
  newSession?: boolean;
  /** Claude Code izin modu (varsayılan: kullanıcının kendi ayarı). */
  permissionMode?: string;
}

/** Yönetici beyin için önceden izinli araçlar: Anafor MCP ve salt okuma. Diğerleri sorulur. */
export const DEFAULT_BRAIN_TOOLS = [
  'mcp__plugin_anafor_anafor',
  'Read',
  'Grep',
  'Glob',
  'TodoWrite',
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
];

export function defaultPluginDir(): string {
  return fileURLToPath(new URL('../../plugin', import.meta.url));
}

const brainFile = (root: string) => join(root, '.anafor', 'brain.json');

/**
 * Resmi `claude` ikilisini çok turlu stream-json modunda, Anafor plugin'iyle başlatır.
 * Kimlik bilgilerine dokunulmaz; kullanıcının kendi Claude Code oturumu kullanılır.
 * İzin gereken araçlar `permission_prompt` MCP aracı üzerinden `anafor chat`'e sorulur.
 */
export class BrainSession {
  private child: ChildProcess | null = null;
  sessionId: string;
  private readonly resume: boolean;

  constructor(
    private readonly opts: BrainOptions,
    private readonly onEvent: (e: BrainEvent) => void,
  ) {
    const saved =
      !opts.newSession && existsSync(brainFile(opts.root))
        ? (JSON.parse(readFileSync(brainFile(opts.root), 'utf8')) as { session_id?: string })
            .session_id
        : undefined;
    this.sessionId = saved ?? randomUUID();
    this.resume = !!saved;
  }

  args(): string[] {
    return [
      '-p',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--verbose',
      '--plugin-dir',
      this.opts.pluginDir ?? defaultPluginDir(),
      '--permission-prompts',
      'host',
      '--permission-prompt-tool',
      'mcp__plugin_anafor_anafor__permission_prompt',
      '--allowedTools',
      ...(this.opts.allowedTools ?? DEFAULT_BRAIN_TOOLS),
      ...(this.opts.model ? ['--model', this.opts.model] : []),
      ...(this.opts.permissionMode ? ['--permission-mode', this.opts.permissionMode] : []),
      ...(this.resume ? ['--resume', this.sessionId] : ['--session-id', this.sessionId]),
    ];
  }

  start(): void {
    writeFileSync(brainFile(this.opts.root), JSON.stringify({ session_id: this.sessionId }));
    const child = spawn(this.opts.bin ?? process.env.ANAFOR_CLAUDE_BIN ?? 'claude', this.args(), {
      cwd: this.opts.root,
      env: subscriptionEnv({ ...process.env, CLAUDE_PROJECT_DIR: this.opts.root }),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    createInterface({ input: child.stdout! }).on('line', (l) => {
      try {
        for (const e of parseBrainLine(l)) {
          if (e.type === 'init' && e.sessionId) this.sessionId = e.sessionId;
          this.onEvent(e);
        }
      } catch {
        /* JSON olmayan satır */
      }
    });
    let err = '';
    child.stderr?.on('data', (d) => (err += String(d)));
    child.on('error', (e) =>
      this.onEvent({ type: 'error', message: `claude başlatılamadı: ${e.message}` }),
    );
    child.on('close', (code) => {
      if (code && err.trim())
        this.onEvent({ type: 'error', message: err.trim().split('\n').slice(-3).join(' ') });
      this.onEvent({ type: 'exit', code });
    });
  }

  send(text: string): void {
    if (!this.child?.stdin?.writable) throw new Error('Beyin oturumu çalışmıyor');
    this.child.stdin.write(
      JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n',
    );
  }

  stop(): void {
    this.child?.stdin?.end();
  }

  kill(): void {
    this.child?.kill();
  }
}
