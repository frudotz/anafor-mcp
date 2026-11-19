import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { m } from '../i18n/index.js';

interface Denial {
  time?: string;
  tool?: string;
  tool_input?: string;
  reason?: string;
  session_id?: string | null;
}
export interface PermissionReport {
  total: number;
  sessions: { session: string; count: number }[];
  days: { day: string; count: number }[];
  tools: { tool: string; count: number }[];
  reasons: { reason: string; count: number }[];
  suggestions: string[];
}

const top = (values: string[]) => {
  const counts = new Map<string, number>();
  for (const v of values) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
};

export function collectPermissionReport(
  root: string,
  days = 7,
  now = Date.now(),
): PermissionReport {
  let rows: Denial[] = [];
  try {
    rows = readFileSync(join(root, '.anafor', 'metrics', 'permissions.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const parsed = JSON.parse(line) as Denial;
          return parsed && typeof parsed === 'object' ? [parsed] : [];
        } catch {
          return [];
        }
      });
  } catch {
    /* no observations */
  }
  const cutoff = now - Math.max(1, days) * 86_400_000;
  const filtered = rows.filter(
    (r) => typeof r.time === 'string' && Date.parse(r.time) >= cutoff && Date.parse(r.time) <= now,
  );
  const sessions = top(filtered.map((r) => r.session_id || (r.time ?? '').slice(0, 10)));
  const daysTop = top(filtered.map((r) => (r.time ?? '').slice(0, 10)));
  const tools = top(filtered.map((r) => r.tool ?? 'unknown'));
  const reasons = top(filtered.map((r) => r.reason ?? 'unknown'));
  const candidates = top(
    filtered.flatMap((r) => {
      if (r.tool !== 'Bash' || !r.tool_input) return [];
      try {
        const parsed = JSON.parse(r.tool_input) as { command?: unknown };
        if (typeof parsed.command !== 'string') return [];
        const command = parsed.command
          .trim()
          .split(/[\r\n;]/, 1)[0]!
          .trim();
        if (
          !command ||
          command.length > 100 ||
          /[*?]|\$\(|`|\||&&|\b(rm|sudo|curl|wget)\b/i.test(command)
        )
          return [];
        return [`Bash(${command})`];
      } catch {
        return [];
      }
    }),
  );
  return {
    total: filtered.length,
    sessions: sessions.map((x) => ({ session: x.name, count: x.count })),
    days: daysTop.map((x) => ({ day: x.name, count: x.count })),
    tools: tools.map((x) => ({ tool: x.name, count: x.count })),
    reasons: reasons.map((x) => ({ reason: x.name, count: x.count })),
    suggestions: candidates.slice(0, 10).map((x) => x.name),
  };
}

export function formatPermissionReport(report: PermissionReport): string[] {
  const t = m().permissions;
  return [
    t.total(report.total),
    t.sessions,
    ...report.sessions.map((x) => `  ${x.session}: ${x.count}`),
    t.days,
    ...report.days.map((x) => `  ${x.day}: ${x.count}`),
    t.tools,
    ...report.tools.map((x) => `  ${x.tool}: ${x.count}`),
    t.reasons,
    ...report.reasons.map((x) => `  ${x.reason}: ${x.count}`),
    t.suggestions,
    ...(report.suggestions.length
      ? report.suggestions.map((x) => `  ${x}`)
      : [`  ${t.noSuggestions}`]),
  ];
}
