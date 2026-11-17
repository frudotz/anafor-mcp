import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { windowLabel, type AccountCapacity } from '../capacity/capacity.js';
import { recommend, SUBSCRIPTIONS, tierLabel, type Recommendation } from '../capacity/meta.js';
import { m } from '../i18n/index.js';

const hours = (s: number | null) =>
  s === null
    ? ''
    : s >= 86400
      ? m().capacityCmd.fullInDays(Math.round(s / 86400))
      : m().capacityCmd.fullInHours(Math.max(1, Math.round(s / 3600)));

/** `anafor capacity` çıktısı (saf; test edilebilir). */
export function formatCapacity(r: {
  accounts: AccountCapacity[];
  hints: string[];
  recommendation: Recommendation | null;
  subscriptions: string[];
}): string[] {
  const t = m().capacityCmd;
  const out: string[] = [t.title];
  for (const a of r.accounts) {
    const head = `${a.account.padEnd(10)} ${!a.observed ? '?' : a.healthy ? '✔' : '⚠'} [${a.workers.join(', ')}]`;
    if (!a.observed) {
      out.push(`${head}  ${t.noObservation}`);
      continue;
    }
    const wins = a.windows
      .map(
        (w) =>
          `${windowLabel(w.name)} %${w.used} ${t.free} ${w.free}${w.pace !== null ? ` ${t.pace}×${w.pace}` : ''}${w.pace !== null && w.pace > 1 ? hours(w.eta_full_s) : ''}`,
      )
      .join(' · ');
    out.push(`${head}  ${wins}`);
    for (const [role, c] of Object.entries(a.roles)) {
      if (c.jobs_left === null) continue;
      out.push(`    ${role.padEnd(14)} ${t.roleRow(c.kp_p80, c.jobs_left, c.samples)}`);
    }
  }
  if (r.hints.length) {
    out.push('', t.hints);
    for (const h of r.hints) out.push(`  • ${h}`);
  }
  if (r.recommendation) {
    out.push('', ...formatRecommendation(r.recommendation));
  } else if (!r.subscriptions.length) {
    out.push('', t.noSubscriptions);
  }
  return out;
}

export function formatRecommendation(rec: Recommendation): string[] {
  const t = m().capacityCmd;
  const out = [t.recTitle(rec.period), `  ${t.brain.padEnd(14)} ${rec.brain}`];
  for (const [role, chain] of Object.entries(rec.routing))
    out.push(`  ${role.padEnd(14)} ${chain.length ? chain.join(' → ') : '—'}`);
  for (const r of rec.rationale) out.push(`  · ${r}`);
  for (const w of rec.warnings) out.push(`  ⚠ ${w}`);
  return out;
}

export function subscriptionsHelp(): string[] {
  return [
    m().capacityCmd.subscriptions,
    ...SUBSCRIPTIONS.map((s) => `  ${s.id.padEnd(14)} ${s.label}`),
    '',
    m().capacityCmd.tiers,
    ...Object.entries(tierLabel()).map(([k, v]) => `  ${k}  ${v}`),
  ];
}

/** `anafor capacity recommend <ids> [--apply]`: öneriyi gösterir, --apply ile config'e yazar. */
export function runRecommend(root: string, ids: string[], apply: boolean): string[] {
  if (!ids.length) return [m().capacityCmd.recUsage, '', ...subscriptionsHelp()];
  const rec = recommend(ids);
  const out = formatRecommendation(rec);
  if (apply) {
    const file = join(root, 'anafor.config.json');
    const cfg = existsSync(file)
      ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>)
      : {};
    cfg.subscriptions = ids.filter((id) => SUBSCRIPTIONS.some((s) => s.id === id));
    cfg.routing = Object.fromEntries(Object.entries(rec.routing).filter(([, c]) => c.length));
    writeFileSync(file, JSON.stringify(cfg, null, 2) + '\n');
    out.push('', m().capacityCmd.applied);
  } else {
    out.push('', m().capacityCmd.applyHint);
  }
  return out;
}
