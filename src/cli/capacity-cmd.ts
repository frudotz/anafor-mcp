import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { windowLabel, type AccountCapacity } from '../capacity/capacity.js';
import { recommend, SUBSCRIPTIONS, TIER_LABEL, type Recommendation } from '../capacity/meta.js';

const hours = (s: number | null) =>
  s === null
    ? ''
    : s >= 86400
      ? ` ~${Math.round(s / 86400)}g'de dolar`
      : ` ~${Math.max(1, Math.round(s / 3600))}sa'de dolar`;

/** `anafor capacity` çıktısı (saf; test edilebilir). */
export function formatCapacity(r: {
  accounts: AccountCapacity[];
  hints: string[];
  recommendation: Recommendation | null;
  subscriptions: string[];
}): string[] {
  const out: string[] = ['Kapasite (KP = pencerenin %1’i; boş = 100 − kullanım − rezerv)'];
  for (const a of r.accounts) {
    const head = `${a.account.padEnd(10)} ${a.healthy ? '✔' : a.observed ? '⚠' : '?'} [${a.workers.join(', ')}]`;
    if (!a.observed) {
      out.push(`${head}  gözlem yok`);
      continue;
    }
    const wins = a.windows
      .map(
        (w) =>
          `${windowLabel(w.name)} %${w.used} boş ${w.free}${w.pace !== null ? ` tempo×${w.pace}` : ''}${w.pace !== null && w.pace > 1 ? hours(w.eta_full_s) : ''}`,
      )
      .join(' · ');
    out.push(`${head}  ${wins}`);
    for (const [role, c] of Object.entries(a.roles)) {
      if (c.jobs_left === null) continue;
      out.push(
        `    ${role.padEnd(14)} iş başı ~${c.kp_p80} KP → ~${c.jobs_left} iş (${c.samples} ölçüm)`,
      );
    }
  }
  if (r.hints.length) {
    out.push('', 'İpuçları:');
    for (const h of r.hints) out.push(`  • ${h}`);
  }
  if (r.recommendation) {
    out.push('', ...formatRecommendation(r.recommendation));
  } else if (!r.subscriptions.length) {
    out.push(
      '',
      'Abonelik seçilmemiş: önerilen rol dağılımı için `anafor capacity recommend <abonelik1,abonelik2>`',
    );
  }
  return out;
}

export function formatRecommendation(rec: Recommendation): string[] {
  const out = [`Önerilen rol dağılımı (meta ${rec.period}):`, `  beyin          ${rec.brain}`];
  for (const [role, chain] of Object.entries(rec.routing))
    out.push(`  ${role.padEnd(14)} ${chain.length ? chain.join(' → ') : '—'}`);
  for (const r of rec.rationale) out.push(`  · ${r}`);
  for (const w of rec.warnings) out.push(`  ⚠ ${w}`);
  return out;
}

export function subscriptionsHelp(): string[] {
  return [
    'Abonelikler:',
    ...SUBSCRIPTIONS.map((s) => `  ${s.id.padEnd(14)} ${s.label}`),
    '',
    'Kademeler:',
    ...Object.entries(TIER_LABEL).map(([k, v]) => `  ${k}  ${v}`),
  ];
}

/** `anafor capacity recommend <ids> [--apply]`: öneriyi gösterir, --apply ile config'e yazar. */
export function runRecommend(root: string, ids: string[], apply: boolean): string[] {
  if (!ids.length)
    return [
      'kullanım: anafor capacity recommend <abonelik1,abonelik2> [--apply]',
      '',
      ...subscriptionsHelp(),
    ];
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
    out.push('', `anafor.config.json güncellendi: subscriptions + routing.`);
  } else {
    out.push('', 'Uygulamak için: --apply (anafor.config.json → subscriptions + routing)');
  }
  return out;
}
