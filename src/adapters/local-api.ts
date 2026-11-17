import { readFileSync } from 'node:fs';
import { git } from '../git/git.js';
import { EventQueue } from './process.js';
import type {
  JobContext,
  JobSpec,
  RawOutcome,
  RunHandle,
  WorkerAdapter,
  WorkerAvailability,
  WorkerCapabilities,
  WorkerEvent,
} from './types.js';

export interface LocalApiOptions {
  /** Adaptör kimliği (birden fazla yerel uç nokta için). */
  id?: string;
  /** OpenAI uyumlu taban URL: Ollama http://127.0.0.1:11434/v1, LM Studio http://127.0.0.1:1234/v1 */
  baseUrl?: string;
  model: string;
  /** API anahtarının okunacağı ortam değişkeni adı (yerel sunucularda genelde gerekmez). */
  apiKeyEnv?: string;
  maxConcurrency?: number;
  /** Bağlama eklenecek en fazla diff karakteri. */
  maxContextChars?: number;
}

const SYSTEM = `Sen bir kod inceleme ve analiz işçisisin. Dosya düzenleyemez, komut çalıştıramazsın.
Yalnızca verilen iş emrini ve bağlamı (git diff, dosyalar) okuyup değerlendirirsin.
Yanıtın YALNIZCA istenen JSON nesnesi olmalı.`;

/**
 * OpenAI uyumlu HTTP API üzerinden yerel (veya uzak) model. Ajan döngüsü yoktur: salt okunur
 * analysis/review işleri için tek seferlik çağrı. Kodlama için OpenCode adaptörünü yerel
 * sağlayıcıyla kullanın.
 */
export class LocalApiAdapter implements WorkerAdapter {
  readonly id: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKeyEnv: string | undefined;
  private readonly maxConcurrency: number;
  private readonly maxContextChars: number;

  constructor(opts: LocalApiOptions) {
    this.id = opts.id ?? 'local';
    this.baseUrl = (opts.baseUrl ?? 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
    this.model = opts.model;
    this.apiKeyEnv = opts.apiKeyEnv;
    this.maxConcurrency = opts.maxConcurrency ?? 1;
    this.maxContextChars = opts.maxContextChars ?? 60_000;
  }

  private headers(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    const key = this.apiKeyEnv ? env[this.apiKeyEnv] : undefined;
    if (key) h.authorization = `Bearer ${key}`;
    return h;
  }

  async detect(): Promise<WorkerAvailability> {
    try {
      const r = await fetch(`${this.baseUrl}/models`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
      });
      if (!r.ok) return { available: false, reason: `${this.baseUrl}/models → HTTP ${r.status}` };
      const j = (await r.json()) as { data?: { id: string }[] };
      const ids = (j.data ?? []).map((m) => m.id);
      if (ids.length && !ids.includes(this.model)) {
        return {
          available: false,
          reason: `model yok: ${this.model} (mevcut: ${ids.slice(0, 5).join(', ')})`,
        };
      }
      return { available: true, version: this.model, authOk: true };
    } catch (e) {
      return { available: false, reason: `${this.baseUrl} erişilemiyor: ${(e as Error).message}` };
    }
  }

  capabilities(): WorkerCapabilities {
    return {
      roles: ['analysis', 'review'],
      structuredOutput: 'native',
      resume: false,
      sandbox: 'none',
      writesFiles: false,
      costTier: 'low',
      maxConcurrency: this.maxConcurrency,
    };
  }

  /** İş emrine çalışma dizininin git durumu ve diff'i eklenir (salt okunur bağlam). */
  private context(job: JobSpec): string {
    const status = git(job.workdir, ['status', '--short']).stdout;
    let diff = git(job.workdir, ['diff', 'HEAD']).stdout;
    if (diff.length > this.maxContextChars)
      diff = diff.slice(0, this.maxContextChars) + '\n…(kısaltıldı)';
    return `\n\n## Çalışma alanı bağlamı\n### git status\n\`\`\`\n${status || '(temiz)'}\n\`\`\`\n### git diff HEAD\n\`\`\`diff\n${diff || '(fark yok)'}\n\`\`\``;
  }

  start(job: JobSpec, ctx: JobContext): RunHandle {
    const queue = new EventQueue<WorkerEvent>();
    const ac = new AbortController();
    let stop: 'timeout' | 'cancel' | null = null;
    const schema = JSON.parse(readFileSync(job.outputSchemaPath, 'utf8')) as Record<
      string,
      unknown
    >;
    delete schema.$schema;
    delete schema.$id;
    const body = (withSchema: boolean) =>
      JSON.stringify({
        model: job.model ?? this.model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: job.prompt + this.context(job) },
        ],
        ...(withSchema
          ? {
              response_format: {
                type: 'json_schema',
                json_schema: { name: 'worker_result', schema, strict: true },
              },
            }
          : { response_format: { type: 'json_object' } }),
      });

    const call = async (withSchema: boolean) =>
      fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: this.headers(ctx.env),
        body: body(withSchema),
        signal: ac.signal,
      });

    const done: Promise<RawOutcome> = (async () => {
      queue.push({ type: 'session', sessionRef: `${this.id}-${job.jobId}` });
      try {
        let r = await call(true);
        // Bazı sunucular json_schema desteklemez: json_object ile bir kez daha dene.
        if (r.status === 400 || r.status === 422) r = await call(false);
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
        const j = (await r.json()) as {
          choices?: { message?: { content?: string } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const text = j.choices?.[0]?.message?.content ?? '';
        if (j.usage) {
          queue.push({
            type: 'usage',
            inputTokens: j.usage.prompt_tokens ?? 0,
            outputTokens: j.usage.completion_tokens ?? 0,
          });
        }
        queue.push({ type: 'message', text });
        queue.close();
        return {
          exitCode: 0,
          finalMessage: text,
          sessionRef: null,
          timedOut: false,
          cancelled: false,
        };
      } catch (e) {
        queue.push({ type: 'error', message: (e as Error).message, fatal: true });
        queue.close();
        return {
          exitCode: stop ? null : 1,
          finalMessage: null,
          sessionRef: null,
          timedOut: stop === 'timeout',
          cancelled: stop === 'cancel',
        };
      }
    })();

    return {
      pid: undefined,
      events: queue,
      done,
      cancel: async (reason) => {
        stop = reason;
        ac.abort();
        await done.catch(() => undefined);
      },
    };
  }
}
