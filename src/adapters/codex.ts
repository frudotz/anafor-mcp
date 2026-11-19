import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runLineProcess } from './process.js';
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

/** Codex `exec --json` olaylarını normalize olaylara çevirir. Bkz. vault F0 bulguları. */
export function parseCodexLine(line: string): WorkerEvent[] {
  if (!line.trim().startsWith('{')) return [];
  const ev = JSON.parse(line) as Record<string, unknown>;
  const type = ev.type;
  if (type === 'thread.started' && typeof ev.thread_id === 'string') {
    return [{ type: 'session', sessionRef: ev.thread_id }];
  }
  if (type === 'item.completed' && ev.item && typeof ev.item === 'object') {
    const item = ev.item as Record<string, unknown>;
    if (item.type === 'agent_message' && typeof item.text === 'string') {
      return [{ type: 'message', text: item.text }];
    }
    if (item.type === 'command_execution') {
      return [
        {
          type: 'command',
          command: String(item.command ?? ''),
          exitCode: typeof item.exit_code === 'number' ? item.exit_code : null,
        },
      ];
    }
    if (item.type === 'file_change' && Array.isArray(item.changes)) {
      return (item.changes as Record<string, unknown>[]).map((c) => ({
        type: 'file_change' as const,
        path: String(c.path ?? ''),
        kind: String(c.kind ?? 'update'),
      }));
    }
    return [];
  }
  if (type === 'turn.completed' && ev.usage && typeof ev.usage === 'object') {
    const u = ev.usage as Record<string, unknown>;
    const n = (k: string) => (typeof u[k] === 'number' ? u[k] : undefined);
    return [
      {
        type: 'usage',
        inputTokens: n('input_tokens'),
        cachedInputTokens: n('cached_input_tokens'),
        outputTokens: n('output_tokens'),
        reasoningOutputTokens: n('reasoning_output_tokens'),
      },
    ];
  }
  if (type === 'error') {
    return [{ type: 'error', message: String(ev.message ?? 'bilinmeyen hata'), fatal: false }];
  }
  if (type === 'turn.failed') {
    const err = (ev.error ?? {}) as Record<string, unknown>;
    return [{ type: 'error', message: String(err.message ?? 'tur başarısız'), fatal: true }];
  }
  return [];
}

export type CodexWindowsSandbox = 'elevated' | 'unelevated';

/**
 * `~/.codex/config.toml` içindeki `[windows] sandbox` değeri (yalnızca bu anahtar okunur;
 * kimlik bilgisine dokunulmaz). Yoksa null.
 */
export function readCodexWindowsSandbox(
  env: NodeJS.ProcessEnv = process.env,
): CodexWindowsSandbox | null {
  try {
    const toml = readFileSync(
      join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
      'utf8',
    );
    return parseWindowsSandbox(toml);
  } catch {
    return null;
  }
}

export function parseWindowsSandbox(toml: string): CodexWindowsSandbox | null {
  return parseCodexUserConfig(toml).windowsSandbox ?? null;
}

export interface CodexUserConfig {
  model?: string;
  /** Kept only to warn: provider tables may contain secrets and are not forwarded. */
  model_provider?: string;
  model_reasoning_effort?: string;
  windowsSandbox?: CodexWindowsSandbox;
}

/** Read only Codex settings explicitly safe to pass into an isolated worker. */
export function parseCodexUserConfig(toml: string): CodexUserConfig {
  const result: CodexUserConfig = {};
  let section = '';
  let multilineQuote: '"""' | "'''" | null = null;
  let arrayDepth = 0;
  for (const raw of toml.split(/\r?\n/)) {
    if (multilineQuote) {
      if (raw.includes(multilineQuote)) multilineQuote = null;
      continue;
    }
    const line = stripTomlComment(raw).trim();
    if (arrayDepth > 0) {
      arrayDepth += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
      continue;
    }
    const sectionMatch = /^\[([^\]]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      continue;
    }
    if (/^\[\[.*\]\]$/.test(line)) {
      section = '\0array-table';
      continue;
    }
    if (line.startsWith('[')) {
      section = '\0invalid-table';
      continue;
    }
    const pair = /^("(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = parseTomlKey(pair[1]!);
    const source = pair[2]!;
    if (section === '' && key === 'windows') {
      const inlineSandbox = /^\{\s*sandbox\s*=\s*("(?:\\.|[^"\\])*"|'[^']*')\s*\}\s*$/.exec(source);
      const inlineValue = inlineSandbox ? parseTomlString(inlineSandbox[1]!) : null;
      if (inlineValue === 'elevated' || inlineValue === 'unelevated')
        result.windowsSandbox = inlineValue;
      continue;
    }
    if (source.trimStart().startsWith('[')) {
      arrayDepth = (source.match(/\[/g) ?? []).length - (source.match(/\]/g) ?? []).length;
      continue;
    }
    if (source.startsWith('"""') || source.startsWith("'''")) {
      const quote = source.slice(0, 3) as '"""' | "'''";
      if (source.indexOf(quote, 3) === -1) multilineQuote = quote;
      continue;
    }
    const value = parseTomlString(source);
    if (value === null) continue;
    if (section === '' && ['model', 'model_provider', 'model_reasoning_effort'].includes(key)) {
      result[key as 'model' | 'model_provider' | 'model_reasoning_effort'] = value;
    } else if (
      (section === 'windows' && key === 'sandbox') ||
      (section === '' && key === 'windows.sandbox')
    ) {
      if (value === 'elevated' || value === 'unelevated') result.windowsSandbox = value;
    }
  }
  return result;
}

function parseTomlKey(source: string): string {
  if (source.startsWith('"')) {
    try {
      return JSON.parse(source) as string;
    } catch {
      return '';
    }
  }
  return source.startsWith("'") ? source.slice(1, -1) : source;
}

function stripTomlComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if ((c === '"' || c === "'") && (i === 0 || line[i - 1] !== '\\'))
      quote = quote === c ? '' : quote || c;
    if (c === '#' && !quote) return line.slice(0, i);
  }
  return line;
}

function parseTomlString(source: string): string | null {
  const s = source.trim();
  if (s.startsWith('"')) {
    const match = /^"((?:\\.|[^"\\])*)"\s*$/.exec(s);
    if (!match) return null;
    try {
      return JSON.parse(`"${match[1]}"`) as string;
    } catch {
      return null;
    }
  }
  const single = /^'([^']*)'\s*$/.exec(s);
  return single?.[1] ?? null;
}

export function readCodexUserConfig(env: NodeJS.ProcessEnv = process.env): CodexUserConfig {
  try {
    const text = readFileSync(
      join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml'),
      'utf8',
    );
    return parseCodexUserConfig(text);
  } catch {
    return {};
  }
}

/**
 * Windows'ta Codex'in "unelevated" (restricted token) sandbox'ı isimli pipe oluşturmaya izin
 * vermez: pipe'lı stdio ile her alt süreç `spawn EPERM` verir (vitest forks, npm betikleri,
 * test koşucuları). "elevated" sandbox (ayrı CodexSandbox* hesapları) bunu engellemez. Bkz. F16.
 */
export function windowsSandboxWarning(effective: CodexWindowsSandbox | null): string | null {
  if (effective === 'elevated') return null;
  const t = m().adapters;
  return t.windowsSandbox(effective ?? t.sandboxDefault);
}

export function codexProviderWarning(config: CodexUserConfig, userConfig: string): string | null {
  return userConfig !== 'inherit' && config.model_provider && config.model_provider !== 'openai'
    ? m().adapters.codexProviderNeedsInherit
    : null;
}

export interface CodexAdapterOptions {
  /** codex çalıştırılabilir dosyası; varsayılan ANAFOR_CODEX_BIN veya PATH'teki `codex`. */
  bin?: string;
  maxConcurrency?: number;
  /** Yalnızca Windows: Codex `windows.sandbox` ayarını Anafor işleri için ezer. */
  windowsSandbox?: CodexWindowsSandbox;
  userConfig?: 'isolate' | 'inherit';
  /** Test için platform ezmesi. */
  platform?: NodeJS.Platform;
  probeRunner?: (
    bin: string,
    args: string[],
    workdir: string,
  ) => { status: number | null; stdout: string };
}

export interface EnvironmentProbe {
  at: string;
  tools: Record<string, { ok: boolean; preferred?: string }>;
}

export class CodexAdapter implements WorkerAdapter {
  readonly id = 'codex';
  private readonly bin: string;
  private readonly maxConcurrency: number;
  private readonly windowsSandbox: CodexWindowsSandbox | undefined;
  private readonly platform: NodeJS.Platform;
  private readonly userConfig: 'isolate' | 'inherit';
  private readonly probeRunner: NonNullable<CodexAdapterOptions['probeRunner']>;

  constructor(opts: CodexAdapterOptions = {}) {
    this.bin = opts.bin ?? process.env.ANAFOR_CODEX_BIN ?? 'codex';
    this.maxConcurrency = opts.maxConcurrency ?? 2;
    this.windowsSandbox = opts.windowsSandbox;
    this.platform = opts.platform ?? process.platform;
    this.userConfig = opts.userConfig ?? 'isolate';
    this.probeRunner =
      opts.probeRunner ??
      ((bin, args, cwd) => {
        const r = spawnSync(bin, args, {
          cwd,
          encoding: 'utf8',
          windowsHide: true,
          timeout: 120_000,
        });
        return { status: r.status, stdout: r.stdout ?? '' };
      });
  }

  async probeEnvironment(
    workdir: string,
    tools: string[],
    cacheDir: string,
  ): Promise<EnvironmentProbe | null> {
    const file = join(cacheDir, 'env-probe.json');
    try {
      const cached = JSON.parse(readFileSync(file, 'utf8')) as EnvironmentProbe;
      if (
        Date.now() - Date.parse(cached.at) < 24 * 60 * 60_000 &&
        tools.every((t) => cached.tools[t])
      )
        return cached;
    } catch {
      /* cache miss */
    }
    const requested = [...new Set(tools)];
    const script = `$r=@{}; ${requested
      .map(
        (tool, i) =>
          `$b${i}=${JSON.stringify(tool)}; $n${i}=$b${i}; $p${i}=Get-Command $n${i} -ErrorAction SilentlyContinue; if ($p${i} -and $p${i}.Source -like '*.ps1' -and (Get-Command ($n${i}+'.cmd') -ErrorAction SilentlyContinue)) { $n${i}=$n${i}+'.cmd' }; try { & $n${i} --version *> $null; $ok${i}=($LASTEXITCODE -eq 0) } catch { $ok${i}=$false }; $r[$b${i}]=@{ok=$ok${i};preferred=$n${i}}`,
      )
      .join('; ')}; ConvertTo-Json -Compress -Depth 3`;
    const prompt = `Run this harmless PowerShell tool availability probe in the current sandbox and return only JSON map tool => {ok,preferred?}: ${script}`;
    const args = [
      'exec',
      '--json',
      '-s',
      'read-only',
      '--skip-git-repo-check',
      ...(this.userConfig !== 'inherit' ? ['--ignore-user-config', ...this.isolationArgs()] : []),
      ...this.sandboxArgs(),
      '-',
    ];
    let result: EnvironmentProbe = {
      at: new Date().toISOString(),
      tools: Object.fromEntries(requested.map((name) => [name, { ok: false }])),
    };
    try {
      const run = this.probeRunner(this.bin, args, workdir);
      const message = run.stdout
        .split(/\r?\n/)
        .reverse()
        .map((line) => {
          try {
            const event = JSON.parse(line) as {
              type?: string;
              item?: { type?: string; text?: string };
            };
            return event.type === 'item.completed' && event.item?.type === 'agent_message'
              ? event.item.text
              : undefined;
          } catch {
            return undefined;
          }
        })
        .find(Boolean);
      if (run.status !== 0 || !message) return null;
      const parsed = JSON.parse(message) as Record<string, { ok?: boolean; preferred?: string }>;
      if (!requested.every((name) => parsed[name] && typeof parsed[name]!.ok === 'boolean'))
        return null;
      for (const name of requested)
        result.tools[name] = {
          ok: parsed[name]!.ok!,
          ...(parsed[name]!.preferred ? { preferred: parsed[name]!.preferred } : {}),
        };
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(file, JSON.stringify(result, null, 2));
    } catch {
      return null;
    }
    return result;
  }

  get configuredWindowsSandbox(): CodexWindowsSandbox | undefined {
    return this.windowsSandbox;
  }

  /** Windows'ta Anafor ezmesi varsa `-c windows.sandbox=...`. */
  sandboxArgs(): string[] {
    return this.platform === 'win32' && this.windowsSandbox
      ? ['-c', `windows.sandbox="${this.windowsSandbox}"`]
      : [];
  }

  /** Effort (token profili) ve telemetri kapatma; resmi config anahtarları. */
  tuningArgs(job: JobSpec): string[] {
    return [
      '-c',
      'analytics.enabled=false',
      ...(job.effort ? ['-c', `model_reasoning_effort="${job.effort}"`] : []),
    ];
  }

  async detect(): Promise<WorkerAvailability> {
    const v = spawnSync(this.bin, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (v.error || v.status !== 0) {
      return { available: false, reason: v.error?.message ?? `codex --version: ${v.status}` };
    }
    const auth = spawnSync(this.bin, ['login', 'status'], { encoding: 'utf8', windowsHide: true });
    const warn =
      this.platform === 'win32'
        ? windowsSandboxWarning(this.windowsSandbox ?? readCodexWindowsSandbox())
        : null;
    const providerWarning = codexProviderWarning(readCodexUserConfig(process.env), this.userConfig);
    const reasons = [auth.status === 0 ? null : m().adapters.codexLogin, warn, providerWarning];
    const reason = reasons.filter(Boolean).join(' · ');
    return {
      available: true,
      version: v.stdout.trim(),
      authOk: auth.status === 0,
      ...(reason ? { reason } : {}),
    };
  }

  capabilities(): WorkerCapabilities {
    return {
      roles: ['implementation', 'review', 'analysis', 'test'],
      structuredOutput: 'native',
      resume: true,
      sandbox: 'native',
      writesFiles: true,
      costTier: 'medium',
      maxConcurrency: this.maxConcurrency,
    };
  }

  start(job: JobSpec, ctx: JobContext): RunHandle {
    return this.run(this.startArgs(job, ctx), job, ctx);
  }

  startArgs(job: JobSpec, ctx: JobContext): string[] {
    const args = [
      'exec',
      '--json',
      '--output-schema',
      job.outputSchemaPath,
      '-o',
      this.lastMessagePath(ctx),
      '-s',
      job.sandbox,
      '--skip-git-repo-check',
      ...(this.userConfig !== 'inherit' ? ['--ignore-user-config'] : []),
      ...(this.userConfig !== 'inherit' ? this.isolationArgs() : []),
      ...this.inheritedSafeConfigArgs(job, ctx),
      ...this.sandboxArgs(),
      ...this.tuningArgs(job),
      ...(job.model ? ['-m', job.model] : []),
      '-',
    ];
    return args;
  }

  resume(job: JobSpec, ctx: JobContext): RunHandle {
    return this.run(this.resumeArgs(job, ctx), job, ctx);
  }

  resumeArgs(job: JobSpec, ctx: JobContext): string[] {
    if (!job.resumeSessionRef) throw new Error('resume için oturum gerekli');
    // F0: `exec resume` -s/-C almaz; sandbox config ile, dizin cwd ile verilir.
    const args = [
      'exec',
      'resume',
      job.resumeSessionRef,
      ...(this.userConfig !== 'inherit' ? ['--ignore-user-config'] : []),
      ...(this.userConfig !== 'inherit' ? this.isolationArgs() : []),
      ...this.inheritedSafeConfigArgs(job, ctx),
      '--json',
      '--output-schema',
      job.outputSchemaPath,
      '-o',
      this.lastMessagePath(ctx),
      '-c',
      `sandbox_mode="${job.sandbox}"`,
      ...this.sandboxArgs(),
      ...this.tuningArgs(job),
      ...(job.model ? ['-m', job.model] : []),
      '-',
    ];
    return args;
  }

  private inheritedSafeConfigArgs(job: JobSpec, ctx: JobContext): string[] {
    if (this.userConfig === 'inherit') return [];
    const cfg = readCodexUserConfig(ctx.env);
    const args: string[] = [];
    const hasCustomProvider = Boolean(cfg.model_provider && cfg.model_provider !== 'openai');
    const model = job.model || hasCustomProvider ? undefined : cfg.model;
    const effort = job.effort ? undefined : cfg.model_reasoning_effort;
    const sandbox = this.windowsSandbox ? undefined : cfg.windowsSandbox;
    if (model) args.push('-c', `model=${JSON.stringify(model)}`);
    if (effort) args.push('-c', `model_reasoning_effort=${JSON.stringify(effort)}`);
    if (this.platform === 'win32' && sandbox)
      args.push('-c', `windows.sandbox=${JSON.stringify(sandbox)}`);
    return args;
  }

  private isolationArgs(): string[] {
    return [
      '-c',
      'features.apps=false',
      '-c',
      'features.image_generation=false',
      '-c',
      'web_search="disabled"',
    ];
  }

  private lastMessagePath(ctx: JobContext): string {
    return join(ctx.artifactsDir, 'last-message.json');
  }

  private run(args: string[], job: JobSpec, ctx: JobContext): RunHandle {
    const lastPath = this.lastMessagePath(ctx);
    return runLineProcess({
      command: this.bin,
      args,
      cwd: job.workdir,
      env: ctx.env,
      stdin: job.prompt,
      artifactsDir: ctx.artifactsDir,
      parseLine: parseCodexLine,
      finalize: ({ lastMessage, sessionRef }) => ({
        finalMessage: existsSync(lastPath) ? readFileSync(lastPath, 'utf8') : lastMessage,
        sessionRef,
      }),
    });
  }
}
