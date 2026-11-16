import type { Role } from '../contracts/worker-result.js';

/** Yeni bir işçi eklemek = bu arayüzü uygulayan bir modül + config girdisi. */

export interface WorkerAvailability {
  available: boolean;
  version?: string;
  authOk?: boolean;
  reason?: string;
}

export interface WorkerCapabilities {
  roles: Role[];
  /** native: işçi şemayı kendisi zorlar (Codex --output-schema); prompted: prompt + çıkarma. */
  structuredOutput: 'native' | 'prompted';
  resume: boolean;
  sandbox: 'native' | 'none';
  writesFiles: boolean;
  costTier: 'low' | 'medium' | 'high';
  maxConcurrency: number;
}

export interface JobSpec {
  jobId: string;
  taskId: string;
  role: Role;
  model?: string | undefined;
  prompt: string;
  outputSchemaPath: string;
  workdir: string;
  sandbox: 'read-only' | 'workspace-write';
  timeoutMs: number;
  resumeSessionRef?: string | undefined;
}

export interface JobContext {
  artifactsDir: string;
  env: NodeJS.ProcessEnv;
}

export type WorkerEvent =
  | { type: 'session'; sessionRef: string }
  | { type: 'message'; text: string }
  | { type: 'command'; command: string; exitCode: number | null }
  | { type: 'file_change'; path: string; kind: string }
  | {
      type: 'usage';
      inputTokens?: number;
      cachedInputTokens?: number;
      outputTokens?: number;
      reasoningOutputTokens?: number;
    }
  | { type: 'error'; message: string; fatal: boolean };

export interface RawOutcome {
  exitCode: number | null;
  /** İşçinin son mesajı (yapılandırılmış sonuç bunun içinde). */
  finalMessage: string | null;
  sessionRef: string | null;
  timedOut: boolean;
  cancelled: boolean;
}

export interface RunHandle {
  pid: number | undefined;
  events: AsyncIterable<WorkerEvent>;
  done: Promise<RawOutcome>;
  cancel(reason: 'timeout' | 'cancel'): Promise<void>;
}

export interface WorkerAdapter {
  readonly id: string;
  detect(): Promise<WorkerAvailability>;
  capabilities(): WorkerCapabilities;
  start(job: JobSpec, ctx: JobContext): RunHandle;
  resume?(job: JobSpec, ctx: JobContext): RunHandle;
}
