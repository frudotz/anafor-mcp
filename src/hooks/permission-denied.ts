import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { resolveProjectRoot } from '../core/config.js';

export interface PermissionDeniedInput {
  cwd?: string;
  tool_name?: unknown;
  tool_input?: unknown;
  reason?: unknown;
  session_id?: unknown;
}

const SECRET_KEY = String.raw`(?:[\w-]*(?:token|secret|password|passwd|pwd)|(?:api[_-]?)?key|authorization)`;
const mask = (value: string): string =>
  value
    // Önce Bearer/Basic başlıkları (yoksa "Authorization:" kuralı yalnız şema adını gizler)
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 [REDACTED]')
    // key=value, key: value, "key":"value" (JSON) biçimleri
    .replace(
      new RegExp(String.raw`(${SECRET_KEY}["']?\s*[:=]\s*["']?)([^"'\s,;}]+)`, 'gi'),
      '$1[REDACTED]',
    )
    // Yaygın token önekleri
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[abprs]-[A-Za-z0-9-]{8,})/g,
      '[REDACTED]',
    );

function summarize(value: unknown): string {
  let text: string;
  try {
    text = typeof value === 'string' ? value : JSON.stringify(value ?? {});
  } catch {
    text = '[unavailable]';
  }
  return mask(text.replace(/\s+/g, ' ')).slice(0, 200);
}

/** Records denials passively; all failures are intentionally swallowed by callers too. */
export function recordPermissionDenied(
  input: PermissionDeniedInput,
  env: NodeJS.ProcessEnv = process.env,
): void {
  try {
    const resolved = resolveProjectRoot(env, input.cwd ?? process.cwd());
    if (!resolved.initialized) return;
    const dir = join(resolved.root, '.anafor', 'metrics');
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, 'permissions.jsonl'),
      JSON.stringify({
        time: new Date().toISOString(),
        tool: summarize(input.tool_name).slice(0, 80),
        tool_input: summarize(input.tool_input),
        reason: summarize(input.reason),
        session_id: typeof input.session_id === 'string' ? input.session_id : null,
      }) + '\n',
      { encoding: 'utf8', mode: 0o600 },
    );
  } catch {
    // Metrics must never affect the permission decision or session.
  }
}
