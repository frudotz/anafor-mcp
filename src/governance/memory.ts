import { randomBytes } from 'node:crypto';
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

/**
 * Lat.md hafıza grafiği için münhasır yazma kirası. Asla kendiliğinden süresi dolmaz;
 * yalnızca doğru token ile bırakılır. Çökmede kilit korunur, inceleme sonrası elle kaldırılır.
 */
export interface MemoryLease {
  schema_version: 1;
  project_id: string;
  task_id: string | null;
  actor: string;
  acquired_at_utc: string;
  token: string;
}

const lockFile = (memoryDir: string) => join(memoryDir, 'write.lock.json');

export function acquireMemoryLock(
  memoryDir: string,
  input: { projectId: string; taskId: string | null; actor: string },
): MemoryLease {
  mkdirSync(memoryDir, { recursive: true });
  const lease: MemoryLease = {
    schema_version: 1,
    project_id: input.projectId,
    task_id: input.taskId,
    actor: input.actor,
    acquired_at_utc: new Date().toISOString(),
    token: randomBytes(16).toString('hex'),
  };
  let fd: number;
  try {
    fd = openSync(lockFile(memoryDir), 'wx'); // münhasır oluşturma
  } catch {
    const cur = existsSync(lockFile(memoryDir)) ? readFileSync(lockFile(memoryDir), 'utf8') : '';
    throw new Error(`Hafıza zaten kilitli; kilidi inceleyin, zorla kaldırmayın: ${cur}`);
  }
  try {
    writeSync(fd, JSON.stringify(lease));
  } finally {
    closeSync(fd);
  }
  return lease;
}

export function releaseMemoryLock(
  memoryDir: string,
  projectId: string,
  token: string,
): MemoryLease {
  const f = lockFile(memoryDir);
  if (!existsSync(f)) throw new Error('Hafıza kilidi yok');
  const lease = JSON.parse(readFileSync(f, 'utf8')) as MemoryLease;
  if (lease.project_id !== projectId || lease.token !== token) {
    throw new Error('Kilit token/proje uyuşmuyor; mevcut kilit korunuyor');
  }
  rmSync(f);
  return lease;
}

export interface MemoryMetric {
  task_id: string | null;
  query_label: string;
  method: 'lat-cli' | 'lat-mcp' | 'hook' | 'manual';
  index_status: 'ready' | 'missing' | 'stale' | 'unknown';
  query_count?: number | undefined;
  sections_retrieved?: number | undefined;
  content_characters?: number | undefined;
  files_loaded?: number | undefined;
  input_tokens?: number | undefined;
  output_tokens?: number | undefined;
  cache_tokens?: number | undefined;
  outcome: 'completed' | 'empty' | 'stale' | 'error' | 'manual-fallback';
}

/** Bağlam/erişim ölçümü. Ham prompt kabul edilmez; yalnızca kısa etiket. Token sayıları yalnızca gerçekse. */
export function recordMemoryMetric(memoryDir: string, projectId: string, m: MemoryMetric): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,79}$/.test(m.query_label)) {
    throw new Error(
      'query_label kısa ve maskelenmiş bir etiket olmalı (1–80: harf, rakam, . _ / -)',
    );
  }
  for (const k of ['input_tokens', 'output_tokens', 'cache_tokens'] as const) {
    if (m[k] !== undefined && m[k]! < 0) throw new Error(`${k} negatif olamaz`);
  }
  mkdirSync(memoryDir, { recursive: true });
  appendFileSync(
    join(memoryDir, 'context-metrics.jsonl'),
    JSON.stringify({
      schema_version: 1,
      project_id: projectId,
      timestamp_utc: new Date().toISOString(),
      ...m,
    }) + '\n',
  );
}
