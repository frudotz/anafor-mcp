import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { newId, nowIso } from '../core/ids.js';

/** Yöneticinin bir pürüz nedeniyle süreli ve yol kısıtlı düzenleme izni. */
export interface Grant {
  grant_id: string;
  reason: string;
  paths: string[];
  task_id: string | null;
  created_at: string;
  expires_at: string;
}

export const MAX_GRANT_MINUTES = 30;

const grantsDir = (root: string) => join(root, '.anafor', 'grants');
const auditFile = (root: string) => join(root, '.anafor', 'audit', 'interventions.jsonl');

function audit(root: string, record: object): void {
  mkdirSync(join(root, '.anafor', 'audit'), { recursive: true });
  appendFileSync(auditFile(root), JSON.stringify({ ts: nowIso(), ...record }) + '\n');
}

export function createGrant(
  root: string,
  input: { reason: string; paths: string[]; ttlMin: number; taskId?: string | null },
): Grant {
  if (!input.reason.trim()) throw new Error('Müdahale gerekçesi zorunlu');
  if (input.paths.length === 0) throw new Error('En az bir yol (glob) gerekli');
  const ttl = Math.min(Math.max(input.ttlMin, 1), MAX_GRANT_MINUTES);
  const now = Date.now();
  const grant: Grant = {
    grant_id: newId('G'),
    reason: input.reason,
    paths: input.paths.map((p) => p.replace(/\\/g, '/')),
    task_id: input.taskId ?? null,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + ttl * 60_000).toISOString(),
  };
  mkdirSync(grantsDir(root), { recursive: true });
  writeFileSync(join(grantsDir(root), `${grant.grant_id}.json`), JSON.stringify(grant, null, 2));
  audit(root, { event: 'intervene_start', ...grant });
  return grant;
}

export function endGrant(root: string, grantId: string, summary: string): Grant {
  const file = join(grantsDir(root), `${grantId}.json`);
  if (!existsSync(file)) throw new Error(`Müdahale izni bulunamadı: ${grantId}`);
  const grant = JSON.parse(readFileSync(file, 'utf8')) as Grant;
  rmSync(file);
  audit(root, { event: 'intervene_end', grant_id: grantId, summary });
  return grant;
}

/** Süresi dolmamış izinler; süresi dolanlar temizlenir ve audit'e yazılır. */
export function activeGrants(root: string, now = Date.now()): Grant[] {
  const dir = grantsDir(root);
  if (!existsSync(dir)) return [];
  const out: Grant[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    try {
      const g = JSON.parse(readFileSync(join(dir, f), 'utf8')) as Grant;
      if (Date.parse(g.expires_at) > now) out.push(g);
      else {
        rmSync(join(dir, f), { force: true });
        audit(root, { event: 'intervene_expired', grant_id: g.grant_id });
      }
    } catch {
      // bozuk dosya yok sayılır
    }
  }
  return out;
}

export function recordViolation(root: string, record: object): void {
  audit(root, { event: 'director_violation', ...record });
}
