import {
  appendFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Store } from '../store/store.js';
import { defaultPolicy, loadPolicy, policyPath, type OperationPolicy } from './policy.js';

export interface MigrationReport {
  source: string;
  policy: 'migrated' | 'kept-existing' | 'none';
  tasks_imported: number;
  audit_records: number;
  checkpoints_copied: number;
  metrics_records: number;
  notes: string[];
}

const readJson = <T>(p: string): T | null => {
  try {
    return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8').replace(/^﻿/, '')) as T) : null;
  } catch {
    return null;
  }
};

const isDefaultPolicy = (p: OperationPolicy, projectId: string) =>
  JSON.stringify(p) === JSON.stringify(defaultPolicy(projectId));

function appendLines(from: string, to: string, extra: object): number {
  if (!existsSync(from)) return 0;
  const lines = readFileSync(from, 'utf8')
    .replace(/^﻿/, '')
    .split('\n')
    .filter((l) => l.trim());
  for (const l of lines) {
    let rec: object;
    try {
      rec = JSON.parse(l) as object;
    } catch {
      continue;
    }
    appendFileSync(to, JSON.stringify({ ...rec, ...extra }) + '\n');
  }
  return lines.length;
}

/**
 * Eski software-orchestrator `.orchestrator/` durumunu `.anafor/`'a taşır (kopyalar).
 * Kaynak salt okunur; hiçbir şey silinmez. Tekrar çalıştırmaya karşı işaret dosyası tutulur.
 */
/** Anafor'da karşılığı olmayan, yerinde bırakılan eski içerik (raporda listelenir). */
const LEGACY_ONLY = [
  'implementation',
  'reviews',
  'history',
  'logs',
  'prompts',
  'sessions.json',
  'DECISIONS.md',
  'PROJECT_STATE.md',
];

function nonEmpty(p: string): boolean {
  if (!existsSync(p)) return false;
  const s = statSync(p);
  return s.isDirectory() ? readdirSync(p).length > 0 : s.size > 0;
}

export function migrateFromOrchestrator(store: Store): MigrationReport {
  const root = store.paths.root;
  const src = join(root, '.orchestrator');
  const marker = join(store.paths.anaforDir, 'migrated-from-orchestrator.json');
  const report: MigrationReport = {
    source: src,
    policy: 'none',
    tasks_imported: 0,
    audit_records: 0,
    checkpoints_copied: 0,
    metrics_records: 0,
    notes: [],
  };
  if (!existsSync(src)) throw new Error(`.orchestrator bulunamadı: ${src}`);
  if (existsSync(marker)) throw new Error(`Göç zaten yapılmış: ${marker}`);
  const projectId = store.paths.projectId;

  // Politika: proje kimliği yeni köke bağlanır; mevcut özelleştirilmiş politika ezilmez.
  const old = readJson<OperationPolicy>(join(src, 'OPERATION_POLICY.json'));
  if (old) {
    const cur = loadPolicy(store.paths.anaforDir);
    if (!cur || isDefaultPolicy(cur, projectId)) {
      writeFileSync(
        policyPath(store.paths.anaforDir),
        JSON.stringify({ ...defaultPolicy(projectId), ...old, project_id: projectId }, null, 2) +
          '\n',
      );
      report.policy = 'migrated';
    } else {
      report.policy = 'kept-existing';
      report.notes.push('Mevcut .anafor/policy.json özelleştirilmiş; eski politika yazılmadı.');
    }
  }

  // Görevler: tarihçe olarak içe aktarılır (iş/oturum taşınmaz).
  const queue = readJson<{ tasks?: { task_id: string; objective?: string; status?: string }[] }>(
    join(src, 'TASK_QUEUE.json'),
  );
  const current = readJson<{ task_id?: string; acceptance_criteria?: string[]; priority?: string }>(
    join(src, 'current-task.json'),
  );
  for (const q of queue?.tasks ?? []) {
    const state =
      q.status === 'completed' ? 'accepted' : q.status === 'superseded' ? 'superseded' : 'open';
    const t = store.createTask({
      title: `[orchestrator] ${q.task_id}`,
      objective: q.objective ?? '(eski görev)',
      acceptanceCriteria: current?.task_id === q.task_id ? (current.acceptance_criteria ?? []) : [],
    });
    store.updateTask(t.id, {
      state,
      note: `Eski görev ${q.task_id} (${q.status ?? '?'}) göç ile aktarıldı.`,
    });
    report.tasks_imported++;
  }
  if ((queue?.tasks ?? []).some((q) => q.status === 'active')) {
    report.notes.push(
      'Aktif eski görevler "open" olarak aktarıldı; işçi oturumları taşınmadı, yeni işle devam edin.',
    );
  }

  mkdirSync(store.paths.auditDir, { recursive: true });
  report.audit_records = appendLines(
    join(src, 'audit', 'operations.jsonl'),
    join(store.paths.auditDir, 'operations.jsonl'),
    { migrated_from: 'orchestrator' },
  );

  const cpSrc = join(src, 'checkpoints');
  if (existsSync(cpSrc)) {
    const dest = join(store.paths.anaforDir, 'checkpoints');
    mkdirSync(dest, { recursive: true });
    for (const d of readdirSync(cpSrc)) {
      if (existsSync(join(dest, d))) continue;
      cpSync(join(cpSrc, d), join(dest, d), { recursive: true });
      report.checkpoints_copied++;
    }
  }

  const memDest = join(store.paths.anaforDir, 'memory');
  mkdirSync(memDest, { recursive: true });
  report.metrics_records = appendLines(
    join(src, 'memory', 'context-metrics.jsonl'),
    join(memDest, 'context-metrics.jsonl'),
    { migrated_from: 'orchestrator' },
  );
  if (existsSync(join(src, 'memory', 'write.lock.json'))) {
    report.notes.push('⚠️ Eski hafıza yazma kilidi var; taşınmadı. İnceleyip elle kaldırın.');
  }
  if (existsSync(join(src, 'orchestrator.lock'))) {
    report.notes.push(
      '⚠️ Eski orchestrator.lock var: eski orkestratör artık kullanılmıyorsa .orchestrator/ ile birlikte silinebilir.',
    );
  }
  const kept = LEGACY_ONLY.filter((n) => nonEmpty(join(src, n)));
  if (kept.length) {
    report.notes.push(
      `Taşınmayan eski artefaktlar .orchestrator/ içinde yerinde kalır (silinmez): ${kept.join(', ')}`,
    );
  }

  writeFileSync(marker, JSON.stringify({ at: new Date().toISOString(), report }, null, 2));
  return report;
}
