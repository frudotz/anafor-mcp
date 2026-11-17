/**
 * Dönemsel meta profili: rol → model kademesi ve abonelik kombinasyonlarına göre önerilen dağılım.
 * Kaynak: vault `20 Araştırma/Rol Dağılımı Araştırması` + `Abonelik Limitleri ve Kapasite` (F19).
 * Uzaktan çekilmez; release ile güncellenir (güvenlik ve tekrarlanabilirlik).
 */
import { m } from '../i18n/index.js';

export const META_PERIOD = '2026-Q4';

export type Tier = 'K1' | 'K2' | 'K3' | 'K4' | 'K5';
/** Kademe etiketleri (geçerli dilde). */
export const tierLabel = (): Record<Tier, string> => m().meta.tiers;

export type WindowKind = 'five_hour' | 'weekly' | 'daily' | 'monthly' | 'budget';

export interface SubscriptionProfile {
  id: string;
  label: string;
  /** Anafor işçileri (bu abonelikle çalışabilenler) ve kademeleri. */
  workers: { id: string; tier: Tier }[];
  /** Pencere türleri (yayımlanmış kapasite yoksa göreli ölçek). */
  windows: WindowKind[];
  /** Pro'ya göre göreli kapasite (aynı sağlayıcı içinde başlangıç tahmini için). */
  relative?: number;
  /** Anafor limitleri doğrudan okuyabiliyor mu? */
  observable: boolean;
  /** Etkileşimsiz (headless) kullanım koşullarda sorun mu? */
  headless: 'ok' | 'gri' | 'yasak';
  note?: string;
}

export const SUBSCRIPTIONS: SubscriptionProfile[] = [
  {
    id: 'claude-pro',
    label: 'Claude Pro',
    workers: [{ id: 'claude-lite', tier: 'K4' }],
    windows: ['five_hour', 'weekly'],
    relative: 1,
    observable: true,
    headless: 'ok',
  },
  {
    id: 'claude-max',
    label: 'Claude Max (5x)',
    workers: [{ id: 'claude-lite', tier: 'K2' }],
    get note() {
      return m().meta.notes.claudeMax;
    },
    windows: ['five_hour', 'weekly'],
    relative: 5,
    observable: true,
    headless: 'ok',
  },
  {
    id: 'claude-ultra',
    get label() {
      return m().meta.labels.claudeUltra;
    },
    workers: [{ id: 'claude-lite', tier: 'K2' }],
    windows: ['weekly'],
    relative: 10,
    observable: true,
    headless: 'ok',
  },
  {
    id: 'chatgpt-plus',
    label: 'ChatGPT Plus / Business (Codex)',
    workers: [{ id: 'codex', tier: 'K2' }],
    windows: ['five_hour', 'weekly'],
    relative: 1,
    observable: true,
    headless: 'ok',
  },
  {
    id: 'chatgpt-pro',
    get label() {
      return m().meta.labels.chatgptPro;
    },
    workers: [{ id: 'codex', tier: 'K1' }],
    windows: ['weekly'],
    relative: 6,
    observable: true,
    headless: 'ok',
  },
  {
    id: 'gemini-api',
    get label() {
      return m().meta.labels.geminiApi;
    },
    workers: [{ id: 'gemini', tier: 'K2' }],
    windows: ['budget'],
    observable: false,
    headless: 'ok',
    get note() {
      return m().meta.notes.geminiApi;
    },
  },
  {
    id: 'antigravity',
    label: 'Google AI Pro/Ultra (Antigravity)',
    workers: [{ id: 'antigravity', tier: 'K2' }],
    windows: ['five_hour', 'weekly'],
    observable: false,
    headless: 'gri',
    get note() {
      return m().meta.notes.antigravity;
    },
  },
  {
    id: 'opencode-api',
    label: 'OpenCode + API (DeepSeek, GLM, Kimi, Qwen)',
    workers: [{ id: 'opencode', tier: 'K3' }],
    windows: ['budget'],
    observable: false,
    headless: 'ok',
    get note() {
      return m().meta.notes.opencodeApi;
    },
  },
  {
    id: 'opencode-go',
    label: 'OpenCode Go',
    workers: [{ id: 'opencode', tier: 'K3' }],
    windows: ['five_hour', 'weekly', 'monthly'],
    observable: false,
    headless: 'ok',
  },
  {
    id: 'local-gpu',
    get label() {
      return m().meta.labels.localGpu;
    },
    workers: [{ id: 'local', tier: 'K5' }],
    windows: [],
    observable: true,
    headless: 'ok',
    get note() {
      return m().meta.notes.localGpu;
    },
  },
];

/** Anafor rolleri (beyin ayrı). */
export type AnaforRole = 'implementation' | 'review' | 'analysis' | 'test';

export interface RoleRule {
  preferred: Tier[];
  fallback: Tier[];
  never?: Tier[];
  /** Kademe düşürülmemesi gereken durumlar (ipucunda gösterilir). */
  keep_if: string[];
}

export const ROLE_RULES: Record<'brain' | AnaforRole, RoleRule> = {
  brain: {
    preferred: ['K1'],
    fallback: ['K2'],
    never: ['K3', 'K4', 'K5'],
    keep_if: ['beyin hatası tüm işçi turunu boşa çıkarır; tasarruf işçi kademelerinden yapılır'],
  },
  implementation: {
    preferred: ['K2', 'K1'],
    fallback: ['K3', 'K4'],
    keep_if: ['3+ dosya', 'belirsiz tanım', 'eşzamanlılık/güvenlik', 'önceki deneme reddedildi'],
  },
  review: {
    preferred: ['K1', 'K2'],
    fallback: ['K3', 'K4'],
    never: ['K5'],
    keep_if: ['güvenlik', 'son kapı', 'büyük diff', 'uygulayıcıdan farklı model ailesi olmalı'],
  },
  analysis: {
    preferred: ['K2', 'K1'],
    fallback: ['K3', 'K4'],
    keep_if: ['karar girdisi olacaksa K1 doğrulasın'],
  },
  test: {
    preferred: ['K2', 'K4'],
    fallback: ['K3', 'K5'],
    keep_if: ['belirsiz test kahini', 'kararsız (flaky) test teşhisi'],
  },
};

export interface Recommendation {
  period: string;
  brain: string;
  routing: Record<AnaforRole, string[]>;
  rationale: string[];
  warnings: string[];
}

const FAMILY: Record<string, string> = {
  'claude-lite': 'anthropic',
  codex: 'openai',
  gemini: 'google',
  antigravity: 'google',
  opencode: 'open',
  local: 'local',
};

/**
 * Kullanıcının seçtiği aboneliklere göre en verimli rol dağılımı önerisi.
 * Sıralama: her rol için tercih edilen kademeler önce, sonra yedekler; inceleme için
 * uygulayıcıdan farklı model ailesi öne alınır.
 */
export function recommend(subscriptionIds: string[]): Recommendation {
  const subs = SUBSCRIPTIONS.filter((s) => subscriptionIds.includes(s.id));
  const unknown = subscriptionIds.filter((id) => !SUBSCRIPTIONS.some((s) => s.id === id));
  const t = m().meta;
  const warnings: string[] = unknown.length
    ? [t.unknownSub(unknown.join(', '), SUBSCRIPTIONS.map((s) => s.id).join(', '))]
    : [];
  const rationale: string[] = [];

  // İşçi → en iyi kademe (aynı işçi birden çok abonelikte olabilir).
  const tierOf = new Map<string, Tier>();
  for (const s of subs) {
    for (const w of s.workers) {
      const cur = tierOf.get(w.id);
      if (!cur || w.tier < cur) tierOf.set(w.id, w.tier);
    }
    if (s.headless !== 'ok')
      warnings.push(t.terms(s.label, t.headless[s.headless], s.note ?? '').trim());
    else if (s.note) rationale.push(`${s.label}: ${s.note}`);
  }
  const claude = subs.find((s) => s.id.startsWith('claude-'));
  if (!claude) warnings.push(t.needClaude);
  const brain = claude?.id === 'claude-pro' ? t.brainPro : claude ? t.brainMax : '—';
  rationale.push(t.brainFrontier);

  const brainShare = (w: string) => (FAMILY[w] === 'anthropic' ? 1 : 0);
  const order = (role: AnaforRole): string[] => {
    const r = ROLE_RULES[role];
    const rank = (t: Tier) => {
      const p = r.preferred.indexOf(t);
      if (p >= 0) return p;
      const f = r.fallback.indexOf(t);
      return f >= 0 ? 10 + f : 100;
    };
    return (
      [...tierOf.entries()]
        .filter(([, t]) => !r.never?.includes(t) && rank(t) < 100)
        // Eşit kademede beynin hesabını paylaşmayan işçi öne (beyin kapasitesi korunur).
        .sort((a, b) => rank(a[1]) - rank(b[1]) || brainShare(a[0]) - brainShare(b[0]))
        .map(([id]) => id)
    );
  };

  const routing = {
    implementation: order('implementation'),
    analysis: order('analysis'),
    test: order('test'),
    review: [] as string[],
  };
  // Çapraz aile incelemesi: uygulayıcıyla aynı aileden olmayan işçi öne.
  const impl = routing.implementation[0];
  const rev = order('review');
  routing.review = [
    ...rev.filter((w) => FAMILY[w] !== FAMILY[impl ?? '']),
    ...rev.filter((w) => FAMILY[w] === FAMILY[impl ?? '']),
  ];
  if (impl && routing.review[0] && FAMILY[routing.review[0]] !== FAMILY[impl]) {
    rationale.push(t.crossFamily(impl, routing.review[0]));
  } else if (impl) {
    warnings.push(t.singleFamily);
  }
  if (tierOf.get('local')) {
    routing.implementation = routing.implementation.filter((w) => w !== 'local');
    rationale.push(t.localOnly);
  }
  for (const role of Object.keys(routing) as AnaforRole[]) {
    if (!routing[role].length) warnings.push(t.noWorker(role));
  }
  return { period: META_PERIOD, brain, routing, rationale, warnings };
}
