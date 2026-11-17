import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isWindowsShim, runLineProcess } from './process.js';
import { m } from '../i18n/index.js';
import type {
  JobContext,
  JobSpec,
  RunHandle,
  WorkerAdapter,
  WorkerAvailability,
  WorkerCapabilities,
  WorkerEvent,
} from './types.js';

/** Dosya DEĞİŞTİREN araç mı? (read_file, view_file, list_dir vb. değil.) */
export function isWriteTool(name: string): boolean {
  if (/read|view|list|find|search|grep|glob/i.test(name)) return false;
  return /write|edit|replace|create|file/i.test(name);
}

const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

/**
 * Gemini CLI ve Antigravity CLI stream-json olayları (toleranslı).
 * Antigravity (belgelenmiş): init (conversation_id), step_update, result (status, response,
 * structured_output, usage{input_tokens, output_tokens, cache_read_tokens}).
 * Gemini CLI 0.68 (gerçek çıktıyla doğrulandı): init (session_id), message (role,
 * delta: true parçalar halinde), tool_use, result (status, stats{input_tokens, output_tokens, cached}).
 * Durumlu: `delta` mesaj parçaları birleştirilir (aksi halde yalnızca son parça alınır ve JSON bozulur).
 */
export interface GoogleParser {
  (line: string): WorkerEvent[];
  /** Akışta başarılı bir `result` olayı görüldü mü? */
  sawSuccess: () => boolean;
}

export function createGoogleParser(): GoogleParser {
  let buffer = '';
  let success = false;
  const fn = ((line: string) => {
    const evs = parseGoogleEvent(line, (text, delta) => {
      buffer = delta ? buffer + text : text;
      return buffer;
    });
    if (/"type"\s*:\s*"result"/.test(line) && /"status"\s*:\s*"(success|SUCCESS)"/.test(line)) {
      success = true;
    }
    return evs;
  }) as GoogleParser;
  fn.sawSuccess = () => success;
  return fn;
}

/**
 * Gemini CLI 0.68 Windows'ta işi başarıyla bitirdikten sonra çıkışta libuv iddia hatasıyla
 * çökebiliyor (0xC0000409, "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)").
 * Akışta başarılı `result` görüldüyse sonuç kabul edilir; zaman aşımı/iptal hariç.
 */
function runGoogle(
  opts: Parameters<typeof runLineProcess>[0] & { parseLine: GoogleParser },
): RunHandle {
  const h = runLineProcess(opts);
  return {
    ...h,
    done: h.done.then((o) =>
      o.exitCode !== 0 && !o.timedOut && !o.cancelled && opts.parseLine.sawSuccess()
        ? { ...o, exitCode: 0 }
        : o,
    ),
  };
}

/** Durumsuz kullanım (her mesaj tam kabul edilir). */
export function parseGoogleLine(line: string): WorkerEvent[] {
  return parseGoogleEvent(line, (text) => text);
}

function parseGoogleEvent(
  line: string,
  accumulate: (text: string, delta: boolean) => string,
): WorkerEvent[] {
  if (!line.trim().startsWith('{')) return [];
  const ev = JSON.parse(line) as Record<string, unknown>;
  const out: WorkerEvent[] = [];
  const sid = ev.conversation_id ?? ev.session_id ?? ev.sessionId;
  if (ev.type === 'init' && typeof sid === 'string') out.push({ type: 'session', sessionRef: sid });
  if (ev.type === 'message' && ev.role !== 'user' && typeof ev.content === 'string') {
    const text = accumulate(ev.content, ev.delta === true);
    if (text.trim()) out.push({ type: 'message', text });
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
    } else if (isWriteTool(name) && (params.file_path || params.path)) {
      out.push({ type: 'file_change', path: String(params.file_path ?? params.path), kind: name });
    }
  }
  if (ev.type === 'result') {
    const stats = (ev.stats ?? {}) as Record<string, unknown>;
    const usage = (ev.usage ?? stats.usage ?? stats) as Record<string, unknown>;
    out.push({
      type: 'usage',
      inputTokens: num(usage.input_tokens),
      cachedInputTokens: num(usage.cache_read_tokens ?? usage.cached),
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
        reason: m().adapters.geminiKey,
      };
    }
    const v = version(this.bin);
    if (!v) return { available: false, reason: m().adapters.geminiMissing };
    // Etkileşimsiz modda kimlik yöntemi ayarlardan seçilmiş olmalı; yalnızca ortam değişkeni
    // yetmiyor ("Invalid auth method selected", gerçek testte bulundu).
    if (!geminiAuthSelected()) {
      return {
        available: false,
        version: v,
        reason: m().adapters.geminiAuth,
      };
    }
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
      // Etkileşimsiz varsayılan mod onay gerektiren araçları (write_file) hiç sunmuyor (gerçek testte
      // bulundu). Yazma: auto_edit (yalnızca düzenleme onayı, yolo DEĞİL); salt okunur: plan.
      '--approval-mode',
      job.sandbox === 'read-only' ? 'plan' : 'auto_edit',
    ];
    return runGoogle({
      command: this.bin,
      args,
      cwd: job.workdir,
      env: ctx.env,
      stdin: job.prompt,
      artifactsDir: ctx.artifactsDir,
      parseLine: createGoogleParser(),
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
      /** Headless agy'nin çalıştırabileceği BİREBİR komutlar (joker yok; agy 1.5.9). */
      allowedCommands?: string[];
    } = {},
  ) {}

  private get bin() {
    return this.opts.bin ?? process.env.ANAFOR_AGY_BIN ?? 'agy';
  }

  async detect(): Promise<WorkerAvailability> {
    if (!this.opts.acknowledged) {
      return {
        available: false,
        reason: m().adapters.agyTerms,
      };
    }
    const v = version(this.bin);
    if (!v) return { available: false, reason: m().adapters.agyMissing };
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
    };
  }

  /**
   * agy 1.5.9 `--help` ile doğrulanan bayraklar: -p, --output-format stream-json,
   * --json-schema (dize veya DOSYA YOLU), --mode accept-edits|auto|plan, --print-timeout,
   * --conversation. İzin atlatma (--dangerously-skip-permissions) KULLANILMAZ.
   */
  args(job: JobSpec, ctx: JobContext): string[] {
    const raw = JSON.parse(readFileSync(job.outputSchemaPath, 'utf8')) as Record<string, unknown>;
    delete raw.$schema;
    delete raw.$id;
    const schemaFile = join(ctx.artifactsDir, 'schema.agy.json');
    writeFileSync(schemaFile, JSON.stringify(raw));
    const model = job.model ?? this.opts.model;
    const commands =
      job.sandbox === 'read-only' ? [] : [...new Set(this.opts.allowedCommands ?? [])];
    const prompt = commands.length
      ? [
          job.prompt,
          '',
          '## Terminal izinleri',
          'Headless modda yalnızca şu komutlar izinlidir ve BİREBİR bu biçimde yazılmalıdır:',
          ...commands.map((c) => `- \`${c}\``),
          'Başka bir komut reddedilir; reddedilirse tests_run alanında çalıştırılamadığını belirt.',
        ].join('\n')
      : job.prompt;
    return [
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--json-schema',
      schemaFile,
      // Yazma: yalnızca düzenleme onayı (auto/dangerously DEĞİL); salt okunur: plan.
      '--mode',
      job.sandbox === 'read-only' ? 'plan' : 'accept-edits',
      // Oturum yoksa agy giriş bekler; iş zaman aşımıyla sınırlanır, sonsuza kadar takılmaz.
      '--print-timeout',
      `${Math.max(30, Math.round(job.timeoutMs / 1000))}s`,
      ...(model ? ['--model', model] : []),
      // Oturumluk izinler (kaydedilmez): yalnızca birebir komutlar. Bkz. F16 gerçek doğrulama.
      ...(commands.length
        ? [
            '--settings',
            JSON.stringify({ permissions: { allow: commands.map((c) => `command(${c})`) } }),
          ]
        : []),
    ];
  }

  start(job: JobSpec, ctx: JobContext): RunHandle {
    return this.run(this.args(job, ctx), job, ctx);
  }

  resume(job: JobSpec, ctx: JobContext): RunHandle {
    return this.run(
      [...this.args(job, ctx), '--conversation', job.resumeSessionRef ?? ''],
      job,
      ctx,
    );
  }

  private run(args: string[], job: JobSpec, ctx: JobContext): RunHandle {
    return runLineProcess({
      command: this.bin,
      args,
      cwd: job.workdir,
      env: ctx.env,
      stdin: '',
      artifactsDir: ctx.artifactsDir,
      parseLine: parseAntigravityLine,
      finalize: ({ lastMessage, sessionRef }) => ({ finalMessage: lastMessage, sessionRef }),
    });
  }
}

/**
 * agy 1.5.9 `--output-format stream-json` (GERÇEK çıktıyla doğrulandı; belgelerden farklı):
 * olay adı `event` alanında, veri iç içe:
 *   {event:"init", conversation_id, init:{cwd, tools}}
 *   {event:"step_update", step_update:{state, step_type, tool_name, tool_info:{parameters}, text_delta, usage}}
 *   {event:"result", result:{status, response, structured_output, usage}}
 * Kullanım yalnızca `result.usage`'tan alınır (adım kullanımları toplamla çift sayılmasın).
 */
export function parseAntigravityLine(line: string): WorkerEvent[] {
  if (!line.trim().startsWith('{')) return [];
  const ev = JSON.parse(line) as Record<string, unknown>;
  const out: WorkerEvent[] = [];
  if (ev.event === 'init' && typeof ev.conversation_id === 'string') {
    out.push({ type: 'session', sessionRef: ev.conversation_id });
  }
  if (ev.event === 'step_update' && ev.step_update && typeof ev.step_update === 'object') {
    const s = ev.step_update as Record<string, unknown>;
    if (s.state !== 'DONE' && s.state !== 'ERROR') return out;
    const failed = s.state === 'ERROR';
    if (failed && s.step_type !== 'tool') return out;
    if (
      s.step_type === 'agent_response' &&
      typeof s.text_delta === 'string' &&
      s.text_delta.trim()
    ) {
      out.push({ type: 'message', text: s.text_delta });
    }
    if (s.step_type === 'tool') {
      const name = String(s.tool_name ?? '');
      const info = (s.tool_info ?? {}) as {
        parameters?: unknown;
        output?: unknown;
        error?: { message?: unknown };
      };
      const params = (info.parameters ?? {}) as Record<string, unknown>;
      const path = params.Path ?? params.path ?? params.file_path ?? params.TargetFile;
      const command = params.CommandLine ?? params.Command ?? params.command;
      if (/command|shell|terminal|bash/i.test(name) && command !== undefined) {
        // Gerçek çıktı: tool_info.output = "...Command exited with code N. ... Command output: ..."
        const exit =
          typeof info.output === 'string' ? /exited with code (-?\d+)/.exec(info.output) : null;
        out.push({
          type: 'command',
          command: String(command),
          exitCode: exit ? Number(exit[1]) : (num(params.ExitCode ?? params.exit_code) ?? null),
        });
        if (failed) {
          out.push({
            type: 'error',
            message: `agy komutu başarısız: ${String(info.error?.message ?? 'bilinmeyen').split('\n')[0]}`,
            fatal: false,
          });
        }
      } else if (!failed && isWriteTool(name) && typeof path === 'string') {
        out.push({ type: 'file_change', path, kind: name });
      }
    }
  }
  if (ev.event === 'result' && ev.result && typeof ev.result === 'object') {
    const r = ev.result as Record<string, unknown>;
    const u = (r.usage ?? {}) as Record<string, unknown>;
    out.push({
      type: 'usage',
      inputTokens: num(u.input_tokens),
      cachedInputTokens: num(u.cache_read_tokens),
      outputTokens: num(u.output_tokens),
      reasoningOutputTokens: num(u.thinking_tokens),
    });
    if (r.status !== 'SUCCESS' || r.error) {
      out.push({
        type: 'error',
        message: String(r.error ?? r.status ?? 'agy hatası'),
        fatal: true,
      });
    }
    const denied = Array.isArray(r.denied_actions)
      ? (r.denied_actions as Record<string, unknown>[])
      : [];
    if (denied.length) {
      out.push({
        type: 'error',
        message:
          `agy izin reddi (headless): ${denied.map((d) => String(d.action ?? '?')).join(', ')}. ` +
          'Komutlar için anafor.config.json → test_command veya workers.antigravity.allowed_commands (birebir).',
        fatal: false,
      });
    }
    if (r.structured_output && typeof r.structured_output === 'object') {
      out.push({ type: 'message', text: JSON.stringify(r.structured_output) });
    } else if (typeof r.response === 'string' && r.response.trim()) {
      out.push({ type: 'message', text: r.response });
    }
  }
  return out;
}

/** Gemini CLI ayarlarında (GEMINI_CLI_HOME veya ev dizini) kimlik yöntemi seçili mi? */
export function geminiAuthSelected(env: NodeJS.ProcessEnv = process.env): boolean {
  const home = env.GEMINI_CLI_HOME ?? homedir();
  try {
    const s = JSON.parse(readFileSync(join(home, '.gemini', 'settings.json'), 'utf8')) as {
      selectedAuthType?: string;
      security?: { auth?: { selectedType?: string } };
    };
    return Boolean(s.security?.auth?.selectedType ?? s.selectedAuthType);
  } catch {
    return false;
  }
}
