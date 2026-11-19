import type { BrainEvent } from '../chat/brain.js';
import type { LoopCompletion } from './run.js';

export interface BrainTurnResult {
  sessionId: string | null;
  rateLimited?: boolean;
  resetsAt?: number | null;
  completion?: LoopCompletion;
  error?: boolean;
  message?: string;
  resultText?: string;
}
export interface BrainSessionHandle {
  sessionId: string;
  pid?: number | null;
  start(): void;
  send(text: string): void;
  stop(): void;
  kill(): void;
}
export function runBrainTurn(
  create: (onEvent: (event: BrainEvent) => void) => BrainSessionHandle,
  prompt: string,
  timeoutMs: number,
  closeTimeoutMs = 10_000,
  onStarted?: (pid: number | null) => void,
): Promise<BrainTurnResult> {
  return new Promise((resolve) => {
    let settled = false;
    let rateLimited = false;
    let resetsAt: number | null = null;
    let initializedSessionId: string | null = null;
    let result: BrainTurnResult | null = null;
    let session: BrainSessionHandle;
    let turnTimer: ReturnType<typeof setTimeout>;
    let closeTimer: ReturnType<typeof setTimeout>;
    const finish = (result: BrainTurnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(turnTimer);
      clearTimeout(closeTimer);
      resolve(result);
    };
    session = create((event) => {
      if (event.type === 'init' && event.sessionId) initializedSessionId = event.sessionId;
      if (event.type === 'rate_limit_event') {
        rateLimited = event.limited;
        resetsAt = event.resetsAt;
      }
      if (event.type === 'result') {
        session.stop();
        result = {
          sessionId: initializedSessionId,
          rateLimited,
          resetsAt,
          ...(event.ok ? {} : { error: true, message: event.text || 'Claude returned an error' }),
          ...(event.ok ? { resultText: event.text } : {}),
        };
        clearTimeout(turnTimer);
        closeTimer = setTimeout(
          () => {
            session.kill();
            finish(result!);
          },
          Math.max(1, Math.min(10_000, closeTimeoutMs)),
        );
      }
      if (event.type === 'error')
        if (!result)
          finish({ sessionId: initializedSessionId, error: true, message: event.message });
      if (event.type === 'exit')
        result
          ? finish(result)
          : finish({
              sessionId: initializedSessionId,
              error: true,
              message: `Claude exited without a result (${event.code ?? 'unknown'})`,
            });
    });
    turnTimer = setTimeout(() => {
      session.kill();
      finish({ sessionId: initializedSessionId, error: true, message: 'Brain turn timeout' });
    }, timeoutMs);
    try {
      session.start();
      onStarted?.(session.pid ?? null);
      session.send(prompt);
    } catch (error) {
      finish({ sessionId: session.sessionId, error: true, message: (error as Error).message });
    }
  });
}
