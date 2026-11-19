import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { WorkerLimits } from '../limits/limits.js';
import { brainLimitDecision } from './decision.js';
import type { BrainLimitConfig } from './decision.js';
import { readLoopState, writeLoopState, type LoopState } from './state.js';
import { m } from '../i18n/index.js';
import { activeGrants } from '../hooks/grants.js';

export type LoopCompletion =
  | { status: 'done'; marked?: true }
  | { status: 'continue'; marked?: boolean }
  | { status: 'blocked'; reason: string; marked?: true };
export function parseLoopCompletion(text: string): LoopCompletion {
  const matches = text
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^>\s*/, '')
        .replace(/^[*_`~]+|[*_`~]+$/g, '')
        .trim(),
    )
    .map((line) =>
      line.match(/^ANAFOR_LOOP:\s*(DONE|CONTINUE|BLOCKED(?:\s+.*)?)\s*[.!?`*_~]*$/i)?.[1]?.trim(),
    )
    .filter((v): v is string => !!v);
  const final = matches.at(-1)?.trim();
  if (!final) return { status: 'continue', marked: false };
  if (final.toUpperCase() === 'CONTINUE') return { status: 'continue', marked: true };
  if (final.toUpperCase() === 'DONE') return { status: 'done', marked: true };
  return {
    status: 'blocked',
    reason: final.replace(/^BLOCKED\s*/i, '').trim() || 'unspecified',
    marked: true,
  };
}
export function parseBacklog(text: string): string[] {
  return text.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^\s*(?:-\s*\[ \]|\d+[.)])\s+(.+?)\s*$/);
    return match ? [match[1]!] : [];
  });
}
export interface LoopDeps {
  root: string;
  state: LoopState;
  brain: {
    turn(
      prompt: string,
      options: { resume: boolean; sessionId: string | null },
    ): Promise<{
      sessionId: string | null;
      rateLimited?: boolean;
      resetsAt?: number | null;
      completion?: LoopCompletion;
      lastTask?: string | null;
      error?: boolean;
      message?: string;
    }>;
  };
  now(): number;
  sleep(ms: number): Promise<void>;
  readLimits(): WorkerLimits | null;
  checkpoint(): void;
  log(message: string): void;
  limitConfig?: BrainLimitConfig;
  minTurnGapSec?: number;
}
const defaults: BrainLimitConfig = { warn_at: 75, pause_at: 90, pause_at_weekly: 95 };
const readState = (root: string, fallback: LoopState) => readLoopState(root) ?? fallback;

export async function runLoop(deps: LoopDeps): Promise<LoopState> {
  let state = deps.state;
  const persistRespectingControl = (): boolean => {
    const live = readLoopState(deps.root);
    if (
      live?.state === 'stopped' ||
      (live?.state === 'paused' && (live.paused_reason ?? '').startsWith('manual'))
    ) {
      state = {
        ...state,
        state: live.state,
        paused_reason: live.paused_reason,
        resume_at: live.resume_at,
      };
      writeLoopState(deps.root, state);
      return false;
    }
    writeLoopState(deps.root, state);
    return true;
  };
  let backlogItems: string[] = [];
  try {
    if (state.backlog)
      backlogItems = parseBacklog(readFileSync(resolve(deps.root, state.backlog), 'utf8'));
  } catch (error) {
    state = {
      ...state,
      state: 'stopped',
      paused_reason: `error: ${m().cli.loopBacklogReadError(state.backlog ?? '', (error as Error).message)}`,
      resume_at: null,
    };
    persistRespectingControl();
    return state;
  }
  let resumeContext = false;
  let unmarkedTurns = 0;
  const pauseReason = (reason: string) => {
    const expiry =
      activeGrants(deps.root, deps.now())
        .map((g) => g.expires_at)
        .sort()[0] ?? state.pending_intervene_expires_at;
    return expiry && Date.parse(expiry) > deps.now()
      ? `${reason}; intervene permission may expire at ${expiry}`
      : reason;
  };
  const pauseAndWait = async (reason: string, resetSeconds: number | null): Promise<boolean> => {
    const nextReset = deps
      .readLimits()
      ?.windows.map((w) => w.resets_at)
      .filter((v): v is number => v !== null && v * 1000 > deps.now())
      .sort((a, b) => a - b)[0];
    let resumeMs =
      resetSeconds !== null && resetSeconds * 1000 > deps.now()
        ? resetSeconds * 1000 + 60_000
        : nextReset !== undefined
          ? nextReset * 1000 + 60_000
          : deps.now() + 15 * 60_000;
    state = {
      ...state,
      state: 'paused',
      paused_reason: pauseReason(reason),
      resume_at: new Date(resumeMs).toISOString(),
    };
    if (!persistRespectingControl()) return false;
    try {
      deps.checkpoint();
    } catch {
      /* best effort */
    }
    if (!persistRespectingControl()) return false;
    if (!state.auto_resume || reason.startsWith('blocked:') || reason.startsWith('error:'))
      return false;
    while (true) {
      while (deps.now() < resumeMs) {
        state = readState(deps.root, state);
        if (state.until && deps.now() >= Date.parse(state.until)) {
          state = { ...state, state: 'done', paused_reason: null, resume_at: null };
          persistRespectingControl();
          return false;
        }
        if (
          state.state === 'stopped' ||
          (state.state === 'paused' && (state.paused_reason ?? '').startsWith('manual'))
        ) {
          persistRespectingControl();
          return false;
        }
        await deps.sleep(Math.min(600_000, Math.max(1, resumeMs - deps.now())));
      }
      if (
        brainLimitDecision(deps.readLimits(), deps.limitConfig ?? defaults, deps.now()).action !==
        'pause'
      ) {
        state = { ...state, state: 'running', paused_reason: null, resume_at: null };
        if (!persistRespectingControl()) return false;
        resumeContext = true;
        return true;
      }
      const reset = deps
        .readLimits()
        ?.windows.map((w) => w.resets_at)
        .filter((v): v is number => v !== null && v * 1000 > deps.now())
        .sort((a, b) => a - b)[0];
      resumeMs = reset === undefined ? deps.now() + 15 * 60_000 : reset * 1000 + 60_000;
      state = { ...state, resume_at: new Date(resumeMs).toISOString() };
      if (!persistRespectingControl()) return false;
    }
  };
  while (true) {
    state = readState(deps.root, state);
    if (state.state === 'stopped' || state.state === 'done') return state;
    if (state.state === 'paused' && state.paused_reason?.startsWith('manual')) return state;
    if (
      (state.max_cycles !== null && state.cycle >= state.max_cycles) ||
      (state.until && deps.now() >= Date.parse(state.until))
    ) {
      state = { ...state, state: 'done' };
      persistRespectingControl();
      return state;
    }
    const limits = deps.readLimits();
    const decision = brainLimitDecision(limits, deps.limitConfig ?? defaults, deps.now());
    if (decision.action === 'pause') {
      if (
        !(await pauseAndWait(
          `limit:${decision.window}`,
          decision.resume_at ? Date.parse(decision.resume_at) / 1000 - 60 : null,
        ))
      )
        return state;
      continue;
    }
    const itemIndex = state.backlog
      ? backlogItems.findIndex((_, i) => !state.completed_items.includes(String(i)))
      : -1;
    if (state.backlog && itemIndex < 0) {
      state = { ...state, state: 'done' };
      persistRespectingControl();
      return state;
    }
    const context = `${decision.action === 'warn' ? `${m().cli.loopWarn(limits?.windows.find((w) => w.name === decision.window)?.used_percent ?? 0)}\n` : ''}${resumeContext ? `${m().cli.loopResumePrompt}\n` : ''}${state.backlog ? `Backlog item: ${backlogItems[itemIndex]}` : `Goal: ${state.goal}`}`;
    const prompt = m().cli.loopTurnPrompt(
      context,
      !!state.accept,
      !!state.merge,
      state.profile ?? 'balanced',
    );
    resumeContext = false;
    let turn: Awaited<ReturnType<LoopDeps['brain']['turn']>>;
    try {
      turn = await deps.brain.turn(prompt, {
        resume: state.session_id !== null,
        sessionId: state.session_id,
      });
    } catch (error) {
      turn = { sessionId: null, error: true, message: (error as Error).message };
    }
    state = {
      ...state,
      cycle: state.cycle + 1,
      session_id: turn.sessionId ?? state.session_id,
      last_task: turn.lastTask ?? state.last_task,
    };
    const completion = turn.completion ?? { status: 'continue' as const, marked: false };
    if (completion.marked === false) unmarkedTurns++;
    else unmarkedTurns = 0;
    if (state.backlog && itemIndex >= 0 && completion.status === 'done') {
      state.completed_items = [...state.completed_items, String(itemIndex)];
      if (!persistRespectingControl()) return state;
    }
    if (!state.backlog && completion.status === 'done' && !turn.error) {
      state = { ...state, state: 'done', error_count: 0 };
      persistRespectingControl();
      return state;
    }
    if (turn.rateLimited) {
      if (!(await pauseAndWait('rate_limit_event', turn.resetsAt ?? null))) return state;
      continue;
    }
    if (completion.status === 'blocked') {
      state = {
        ...state,
        state: 'paused',
        paused_reason: pauseReason(`blocked: ${completion.reason}`),
        resume_at: null,
      };
      if (!persistRespectingControl()) return state;
      return state;
    }
    if (turn.error || turn.message) {
      const message = turn.message ?? 'brain turn failed';
      if (/rate\s*limit|usage\s*limit/i.test(message)) {
        if (!(await pauseAndWait(`rate_limit_error: ${message}`, turn.resetsAt ?? null)))
          return state;
        continue;
      }
      const errors = (state.error_count ?? 0) + 1;
      if (errors >= 3) {
        state = {
          ...state,
          state: 'paused',
          paused_reason: pauseReason(`error: ${message}`),
          resume_at: null,
          error_count: errors,
        };
        if (!persistRespectingControl()) return state;
        return state;
      }
      state = { ...state, error_count: errors };
      if (!persistRespectingControl()) return state;
      await deps.sleep(Math.min(30 * 60_000, 60_000 * 2 ** (errors - 1)));
      continue;
    }
    if (state.backlog && state.completed_items.length >= backlogItems.length) {
      state = { ...state, state: 'done', error_count: 0 };
      persistRespectingControl();
      return state;
    }
    if (unmarkedTurns >= 5) {
      state = {
        ...state,
        state: 'paused',
        paused_reason: 'error: no progress marker',
        resume_at: null,
      };
      if (!persistRespectingControl()) return state;
      return state;
    }
    state = { ...state, error_count: 0 };
    if (!persistRespectingControl()) return state;
    await deps.sleep(Math.max(0, deps.minTurnGapSec ?? 30) * 1000);
  }
}
