import { CodexAdapter } from './codex.js';
import { FakeAdapter } from './fake.js';
import type { WorkerAdapter } from './types.js';

export type AdapterRegistry = ReadonlyMap<string, WorkerAdapter>;

/** Varsayılan adaptör kümesi. Yeni işçi eklemek için buraya kayıt eklenir. */
export function defaultAdapters(): AdapterRegistry {
  const list: WorkerAdapter[] = [new CodexAdapter(), new FakeAdapter()];
  return new Map(list.map((a) => [a.id, a]));
}
