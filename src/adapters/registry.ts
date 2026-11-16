import type { AnaforConfig } from '../core/config.js';
import { ClaudeLiteAdapter } from './claude-lite.js';
import { CodexAdapter } from './codex.js';
import { FakeAdapter } from './fake.js';
import type { WorkerAdapter } from './types.js';

export type AdapterRegistry = ReadonlyMap<string, WorkerAdapter>;

/**
 * Varsayılan adaptör kümesi. Yeni bir işçi eklemek = WorkerAdapter uygulayan bir sınıf
 * ve buraya bir satır; ayarlar config `workers.<id>` altından gelir.
 */
export function defaultAdapters(config?: Pick<AnaforConfig, 'workers'>): AdapterRegistry {
  const w = config?.workers ?? {};
  const opt = <T extends object>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  const list: WorkerAdapter[] = [
    new CodexAdapter(opt({ bin: w.codex?.bin, maxConcurrency: w.codex?.max_concurrency })),
    new ClaudeLiteAdapter(
      opt({
        bin: w['claude-lite']?.bin,
        model: w['claude-lite']?.model,
        maxConcurrency: w['claude-lite']?.max_concurrency,
        allowedTools: w['claude-lite']?.allowed_tools,
      }),
    ),
    new FakeAdapter(),
  ];
  return new Map(list.filter((a) => w[a.id]?.enabled !== false).map((a) => [a.id, a]));
}
