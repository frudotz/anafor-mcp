import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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
 * Gemini CLI ve Antigravity CLI stream-json olayları (toleranslı).
 * Antigravity (belgelenmiş): init (conversation_id), step_update, result (status, response,
 * structured_output, usage{input_tokens, output_tokens, cache_read_tokens}).
 * Gemini CLI: init (session_id), message, tool_use, result (stats).
 * ⚠️ Deneysel: gerçek araçlarla uyum testi henüz yapılmadı.
 */
export function parseGoogleLine(line: string): WorkerEvent[] {
  if (!line.trim().startsWith('{')) return [];
  const ev = JSON.parse(line) as Record<string, unknown>;
  const out: WorkerEvent[] = [];
  const sid = ev.conversation_id ?? ev.session_id ?? ev.sessionId;
  if (ev.type === 'init' && typeof sid === 'string') out.push({ type: 'session', sessionRef: sid });
  if (
    ev.type === 'message' &&
    ev.role !== 'user' &&
    typeof ev.content === 'string' &&
    ev.content.trim()
  ) {
    out.push({ type: 'message', text: ev.content });
  }
  if (ev.type === 'tool_use' || ev.type === 'step_update') {
    const name = String(
      ev.tool_name ?? ev.name ?? (ev.step as { tool?: string } | undefined)?.tool ?? '',
    );
    const params = (ev.parameters ??
      ev.input ??
      (ev.step as { input?: unknown } | undefined)?.input ??
      {}) as Record<string, unknown>;
    if (/shell|bash|command|terminal/i.test(name)) {
      out.push({ type: 'command', command: String(params.command ?? ''), exitCode: null });
    } else if (/write|edit|replace|file/i.test(name) && (params.file_path || params.path)) {
      out.push({ type: 'file_change', path: String(params.file_path ?? params.path), kind: name });
    }
  }
  if (ev.type === 'result') {
    const usage = (ev.usage ??
      (ev.stats as { usage?: unknown } | undefined)?.usage ??
      {}) as Record<string, unknown>;
    out.push({
      type: 'usage',
      inputTokens: num(usage.input_tokens),
      cachedInputTokens: num(usage.cache_read_tokens),
      outputTokens: num(usage.output_tokens),
    });
    const failed =
      (typeof ev.status === 'string' && ev.status !== 'SUCCESS' && ev.status !== 'success') ||
      ev.error;
    if (failed) {
      out.push({
        type: 'error',
        message: String((ev.error as { message?: string })?.message ?? ev.error ?? ev.status),
        fatal: true,
      });
    }
    if (ev.structured_output && typeof ev.structured_output === 'object') {
      out.push({ type: 'message', text: JSON.stringify(ev.structured_output) });
    } else if (typeof ev.response === 'string' && ev.response.trim()) {
      out.push({ type: 'message', text: ev.response });
    }
  }
  return out;
}

function version(bin: string): string | null {
  const v = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
    shell: isWindowsShim(bin),
  });
  return v.error || v.status !== 0 ? null : v.stdout.trim();
}

/**
 * Gemini CLI: kişisel Google hesabı girişleri 2026-06-18'de kapandı; yalnızca
 * GEMINI_API_KEY / GOOGLE_API_KEY (veya Vertex) ile kullanılabilir.
 */
export class GeminiAdapter implements WorkerAdapter {
  readonly id = 'gemini';
  constructor(
    private readonly opts: { bin?: string; model?: string; maxConcurrency?: number } = {},
  ) {}

  private get bin() {
    return this.opts.bin ?? process.env.ANAFOR_GEMINI_BIN ?? 'gemini';
  }

  async detect(): Promise<WorkerAvailability> {
    const key =
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_API_KEY ||
      process.env.GOOGLE_GENAI_USE_VERTEXAI;
    if (!key) {
      return {
        available: false,
        reason:
          'Gemini CLI yalnızca API anahtarıyla (GEMINI_API_KEY); kişisel hesap girişleri 2026-06-18’de kapandı',
      };
    }
    const v = version(this.bin);
    if (!v) return { available: false, reason: 'gemini CLI kurulu değil' };
    return { available: true, version: v, authOk: true };
  }

  capabilities(): WorkerCapabilities {
    return {
      roles: ['implementation', 'review', 'analysis', 'test'],
      structuredOutput: 'prompted',
      resume: false,
      sandbox: 'none',
      writesFiles: true,
      costTier: 'medium',
      maxConcurrency: this.opts.maxConcurrency ?? 2,
      experimental: true,
    };
  }

  start(job: JobSpec, ctx: JobContext): RunHandle {
    // Gemini CLI: -p ile birlikte stdin içeriği prompt'a eklenir; uzun iş emri stdin'den.
    const model = job.model ?? this.opts.model;
    const args = [
      '-p',
      'Is emri stdin uzerinden verildi; uygula.',
      '--output-format',
      'stream-json',
      ...(model ? ['-m', model] : []),
    ];
    return runLineProcess({
      command: this.bin,
      args,
      cwd: job.workdir,
      env: ctx.env,
      stdin: job.prompt,
      artifactsDir: ctx.artifactsDir,
      parseLine: parseGoogleLine,
      finalize: ({ lastMessage, sessionRef }) => ({ finalMessage: lastMessage, sessionRef }),
    });
  }
}

/**
 * Antigravity CLI (`agy`). ⚠️ Koşullar gri alan: abonelikle üçüncü taraf araçlardan erişim
 * ihlal sayılabiliyor. Bu yüzden varsayılan KAPALI; `workers.antigravity.enabled: true` ve
 * `acknowledge_terms: true` ile açılır. İzin atlatma bayrağı kullanılmaz.
 */
export class AntigravityAdapter implements WorkerAdapter {
  readonly id = 'antigravity';
  constructor(
    private readonly opts: {
      bin?: string;
      model?: string;
      maxConcurrency?: number;
      acknowledged?: boolean;
    } = {},
  ) {}

  private get bin() {
    return this.opts.bin ?? process.env.ANAFOR_AGY_BIN ?? 'agy';
  }

  async detect(): Promise<WorkerAvailability> {
    if (!this.opts.acknowledged) {
      return {
        available: false,
        reason:
          'Antigravity koşulları gri alan: workers.antigravity.acknowledge_terms=true gerekli (API anahtarı önerilir)',
      };
    }
    const v = version(this.bin);
    if (!v) return { available: false, reason: 'agy kurulu değil' };
    return { available: true, version: v, authOk: true };
  }

  capabilities(): WorkerCapabilities {
    return {
      roles: ['implementation', 'review', 'analysis', 'test'],
      structuredOutput: 'native',
      resume: true,
      sandbox: 'native',
      writesFiles: true,
      costTier: 'medium',
      maxConcurrency: this.opts.maxConcurrency ?? 1,
      experimental: true,
    };
  }

  private args(job: JobSpec): string[] {
    const raw = JSON.parse(readFileSync(job.outputSchemaPath, 'utf8')) as Record<string, unknown>;
    delete raw.$schema;
    delete raw.$id;
    const model = job.model ?? this.opts.model;
    // ⚠️ agy'nin stdin davranışı doğrulanmadı; prompt argüman olarak (agy yerel bir .exe ise sorun yok).
    return [
      '-p',
      job.prompt,
      '--output-format',
      'stream-json',
      '--json-schema',
      JSON.stringify(raw),
      ...(model ? ['--model', model] : []),
      ...(job.sandbox === 'read-only' ? ['--sandbox'] : []),
    ];
  }

  start(job: JobSpec, ctx: JobContext): RunHandle {
    return this.run(this.args(job), job, ctx);
  }

  resume(job: JobSpec, ctx: JobContext): RunHandle {
    return this.run([...this.args(job), '--conversation', job.resumeSessionRef ?? ''], job, ctx);
  }

  private run(args: string[], job: JobSpec, ctx: JobContext): RunHandle {
    return runLineProcess({
      command: this.bin,
      args,
      cwd: job.workdir,
      env: ctx.env,
      stdin: '',
      artifactsDir: ctx.artifactsDir,
      parseLine: parseGoogleLine,
      finalize: ({ lastMessage, sessionRef }) => ({ finalMessage: lastMessage, sessionRef }),
    });
  }
}
