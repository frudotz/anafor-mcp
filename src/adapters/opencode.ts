import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isWindowsShim, runLineProcess } from './process.js';
import type {
  JobContext,
  JobSpec,
  RunHandle,
  WorkerAdapter,
  WorkerAvailability,
  WorkerCapabilities,
  WorkerEvent,
} from './types.js';

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

/**
 * `opencode run --format json` NDJSON olayları (belgelenmiş alanlar: type, timestamp,
 * sessionID, part). Biçim sürümler arasında değişebildiği için ayrıştırıcı toleranslıdır.
 * ⚠️ Deneysel: gerçek OpenCode ile uyum testi henüz yapılmadı.
 */
export function parseOpenCodeLine(line: string): WorkerEvent[] {
  if (!line.trim().startsWith('{')) return [];
  const ev = JSON.parse(line) as Record<string, unknown>;
  const out: WorkerEvent[] = [];
  const sid = ev.sessionID ?? ev.sessionId ?? ev.session_id;
  if (
    typeof sid === 'string' &&
    (ev.type === 'session' || ev.type === 'step_start' || ev.type === 'step-start')
  ) {
    out.push({ type: 'session', sessionRef: sid });
  }
  const part = (ev.part ?? {}) as Record<string, unknown>;
  const ptype = String(part.type ?? ev.type ?? '');
  if ((ptype === 'text' || ev.type === 'text') && typeof (part.text ?? ev.text) === 'string') {
    const text = String(part.text ?? ev.text);
    if (text.trim()) out.push({ type: 'message', text });
  }
  if (ptype === 'tool' || ev.type === 'tool_use') {
    const tool = String(part.tool ?? (ev as { name?: string }).name ?? '');
    const state = (part.state ?? {}) as Record<string, unknown>;
    const input = (state.input ?? part.input ?? {}) as Record<string, unknown>;
    if (/bash|shell|command/i.test(tool)) {
      const meta = (state.metadata ?? {}) as Record<string, unknown>;
      out.push({
        type: 'command',
        command: String(input.command ?? ''),
        exitCode: num(meta.exit) ?? null,
      });
    } else if (/edit|write|patch/i.test(tool)) {
      out.push({
        type: 'file_change',
        path: String(input.filePath ?? input.path ?? ''),
        kind: tool,
      });
    }
  }
  if (ptype === 'step-finish' || ptype === 'step_finish' || ev.type === 'step_finish') {
    const tokens = (part.tokens ?? {}) as Record<string, unknown>;
    const cache = (tokens.cache ?? {}) as Record<string, unknown>;
    if (tokens.input !== undefined || tokens.output !== undefined) {
      out.push({
        type: 'usage',
        inputTokens: num(tokens.input),
        cachedInputTokens: num(cache.read),
        outputTokens: num(tokens.output),
      });
    }
  }
  if (ev.type === 'error') {
    const err = (ev.error ?? {}) as Record<string, unknown>;
    out.push({
      type: 'error',
      message: String(err.message ?? ev.message ?? 'opencode hatası'),
      fatal: true,
    });
  }
  return out;
}

export interface OpenCodeOptions {
  bin?: string;
  /** provider/model, ör. "openai/gpt-5.1-codex", "ollama/qwen3-coder" */
  model?: string;
  maxConcurrency?: number;
  /** Anthropic sağlayıcısına izin (yalnızca kendi API anahtarınızla; abonelik yasak). */
  allowAnthropicApi?: boolean;
}

/**
 * OpenCode işçisi: API anahtarları, ChatGPT planı (OpenAI ortaklığı) veya yerel modeller
 * (Ollama/LM Studio) ile. Claude aboneliği OpenCode üzerinden KULLANILAMAZ (Anthropic koşulları).
 */
export class OpenCodeAdapter implements WorkerAdapter {
  readonly id = 'opencode';
  private readonly bin: string;
  private readonly model: string | undefined;
  private readonly maxConcurrency: number;
  private readonly allowAnthropicApi: boolean;

  constructor(opts: OpenCodeOptions = {}) {
    this.bin = opts.bin ?? process.env.ANAFOR_OPENCODE_BIN ?? 'opencode';
    this.model = opts.model;
    this.maxConcurrency = opts.maxConcurrency ?? 2;
    this.allowAnthropicApi = opts.allowAnthropicApi ?? false;
  }

  async detect(): Promise<WorkerAvailability> {
    // Önce politika ve yapılandırma, sonra kurulum kontrolü.
    if (!this.model)
      return { available: false, reason: 'workers.opencode.model ayarlanmalı (provider/model)' };
    if (this.model.startsWith('anthropic/') && !this.allowAnthropicApi) {
      return {
        available: false,
        reason:
          'anthropic/* modelleri OpenCode üzerinden yalnızca API anahtarıyla (allow_anthropic_api); Claude aboneliği için claude-lite kullanın',
      };
    }
    const v = spawnSync(this.bin, ['--version'], {
      encoding: 'utf8',
      windowsHide: true,
      shell: isWindowsShim(this.bin),
    });
    if (v.error || v.status !== 0) return { available: false, reason: 'opencode kurulu değil' };
    return { available: true, version: v.stdout.trim(), authOk: true };
  }

  capabilities(): WorkerCapabilities {
    return {
      roles: ['implementation', 'review', 'analysis', 'test'],
      structuredOutput: 'prompted',
      resume: true,
      sandbox: 'none',
      writesFiles: true,
      costTier: 'low',
      maxConcurrency: this.maxConcurrency,
    };
  }

  start(job: JobSpec, ctx: JobContext): RunHandle {
    return this.run([], job, ctx);
  }

  resume(job: JobSpec, ctx: JobContext): RunHandle {
    return this.run(['--session', job.resumeSessionRef ?? ''], job, ctx);
  }

  private run(extra: string[], job: JobSpec, ctx: JobContext): RunHandle {
    // İzin atlatma bayrağı (--auto vb.) kullanılmaz; OpenCode izinleri kullanıcı yapılandırmasındadır.
    // Uzun prompt dosya eki olarak verilir (Windows .cmd sarmalayıcısında çok satırlı argüman olmaz).
    const promptFile = join(ctx.artifactsDir, 'prompt-input.md');
    writeFileSync(promptFile, job.prompt);
    const args = [
      'run',
      '--format',
      'json',
      '-m',
      job.model ?? this.model!,
      ...extra,
      // Mesaj önce: `-f/--file` dizi seçeneği olduğundan ardından gelen konumsal argümanı da
      // dosya sanar (opencode 1.19.5 ile gerçek testte bulundu).
      'Ekli iş emri dosyasını oku ve uygula. Son mesajın iş emrindeki şemaya uyan tek JSON olmalı.',
      `--file=${promptFile}`,
    ];
    return runLineProcess({
      command: this.bin,
      args,
      cwd: job.workdir,
      env: ctx.env,
      stdin: '',
      artifactsDir: ctx.artifactsDir,
      parseLine: parseOpenCodeLine,
      finalize: ({ lastMessage, sessionRef }) => ({ finalMessage: lastMessage, sessionRef }),
    });
  }
}
