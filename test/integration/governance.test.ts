import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import { git } from '../../src/git/git.js';
import { migrateFromOrchestrator } from '../../src/governance/migrate.js';
import type { OperationInput } from '../../src/governance/operations.js';
import { policyPath } from '../../src/governance/policy.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(join(dir, 'README.md'), '# t\n');
  writeFileSync(join(dir, '.gitignore'), '.anafor/\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

describe('yönetişim (F5)', () => {
  let t: ReturnType<typeof tempDir>;
  let store: Store;
  let svc: AnaforService;
  const adapters: AdapterRegistry = new Map([['fake', new FakeAdapter()]]);

  beforeEach(() => {
    t = tempDir();
    initRepo(t.dir);
    store = new Store(t.dir);
    svc = new AnaforService(store, adapters, inProcessLauncher(adapters), 'fake');
    mkdirSync(join(t.dir, 'evidence'));
    writeFileSync(join(t.dir, 'evidence', 'tests.txt'), 'npm test → 0\n');
    writeFileSync(join(t.dir, 'evidence', 'scan.txt'), 'gitleaks: temiz\n');
  });
  afterEach(() => {
    store.close();
    t.cleanup();
  });

  const base = (
    taskId: string,
    checkpoint: string,
    over: Partial<OperationInput> = {},
  ): OperationInput => ({
    operation: 'commit',
    reason: 'test',
    task_id: taskId,
    actor: 'claude',
    checkpoint,
    test_evidence: 'evidence/tests.txt',
    sensitive_scan_evidence: 'evidence/scan.txt',
    tests_passed: true,
    user_changes_preserved: true,
    sensitive_scan_clean: true,
    branch: 'main',
    ...over,
  });

  it('checkpoint: dal, HEAD, temizlik; çalışma ağacını değiştirmez', () => {
    const task = svc.taskCreate({ title: 'c', objective: 'x' });
    const cp = svc.checkpoint('commit öncesi', task.task_id);
    expect(cp.branch).toBe('main');
    expect(cp.head).toMatch(/^[0-9a-f]{40}$/);
    expect(cp.is_clean).toBe(false); // evidence/ izlenmiyor
    expect(existsSync(join(t.dir, cp.checkpoint_path, 'tracked-changes.patch'))).toBe(true);
    expect(git(t.dir, ['status', '--porcelain']).stdout).toContain('evidence/');
  });

  it('commit: kanıt ve checkpoint ile yetkili; kanıt yoksa yetkisiz', () => {
    const task = svc.taskCreate({ title: 'c', objective: 'x' });
    const cp = svc.checkpoint('commit', task.task_id);
    expect(svc.operationAuthorize(base(task.task_id, cp.checkpoint_path)).authorized).toBe(true);
    const r = svc.operationAuthorize(
      base(task.task_id, cp.checkpoint_path, { test_evidence: 'yok.txt', tests_passed: false }),
    );
    expect(r.authorized).toBe(false);
    expect(r.reasons.length).toBeGreaterThanOrEqual(2);
  });

  it('push: boş allowlist reddeder; politikaya eklenince yetkili', () => {
    const task = svc.taskCreate({ title: 'p', objective: 'x' });
    const cp = svc.checkpoint('push', task.task_id);
    const head = cp.head;
    const push = base(task.task_id, cp.checkpoint_path, { operation: 'push', commit_hash: head });
    const denied = svc.operationAuthorize(push);
    expect(denied.authorized).toBe(false);
    expect(denied.reasons.join(' ')).toContain('allowed_push_branches');
    const p = JSON.parse(readFileSync(policyPath(store.paths.anaforDir), 'utf8'));
    p.allowed_push_branches = ['main'];
    writeFileSync(policyPath(store.paths.anaforDir), JSON.stringify(p));
    expect(svc.operationAuthorize(push).authorized).toBe(true);
  });

  it('merge: CI, inceleme, dal koruması, plan ve temiz checkpoint ister', () => {
    const task = svc.taskCreate({ title: 'm', objective: 'x' });
    const cp = svc.checkpoint('merge', task.task_id);
    const r = svc.operationAuthorize(
      base(task.task_id, cp.checkpoint_path, {
        operation: 'merge',
        base_branch: 'main',
        commit_hash: cp.head,
      }),
    );
    const all = r.reasons.join(' | ');
    for (const k of [
      'allowed_merge_branches',
      'CI',
      'inceleme',
      'Dal koruması',
      'doğrulama planı',
      'temiz',
    ])
      expect(all).toContain(k);
  });

  it('korumalı risk: onaysız reddedilir, açık onay + kanıt ile yetkili', () => {
    const task = svc.taskCreate({ title: 'db', objective: 'x' });
    const cp = svc.checkpoint('db', task.task_id);
    const db = base(task.task_id, cp.checkpoint_path, {
      operation: 'database-change',
      branch: undefined,
      protected_risk: 'production-data-loss',
    });
    expect(svc.operationAuthorize(db).authorized).toBe(false);
    expect(svc.operationAuthorize({ ...db, protected_risk: 'none' }).reasons.join(' ')).toContain(
      'korumalı risk',
    );
    expect(
      svc.operationAuthorize({
        ...db,
        explicit_user_approval: true,
        approval_evidence: 'evidence/tests.txt',
      }).authorized,
    ).toBe(true);
  });

  it('checkpoint son uygulamadan eskiyse reddedilir', async () => {
    const task = svc.taskCreate({ title: 'eski', objective: 'x' });
    const cp = svc.checkpoint('önce', task.task_id);
    await new Promise((r) => setTimeout(r, 20));
    const d = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake:ok]',
    });
    await svc.jobWait([d.job_id], 30);
    const r = svc.operationAuthorize(base(task.task_id, cp.checkpoint_path));
    expect(r.reasons.join(' ')).toContain('Checkpoint son uygulamadan eski');
  });

  it('operation_record: başarılı commit hash ister; append-only', () => {
    const task = svc.taskCreate({ title: 'r', objective: 'x' });
    const cp = svc.checkpoint('kayıt', task.task_id);
    const rec = {
      ...base(task.task_id, cp.checkpoint_path),
      outcome: 'succeeded' as const,
      result_summary: 'ok',
    };
    expect(() => svc.operationRecord(rec)).toThrow(/hash/);
    svc.operationRecord({ ...rec, commit_hash: cp.head });
    svc.operationRecord({ ...rec, outcome: 'blocked', result_summary: 'engellendi' });
    const lines = readFileSync(join(store.paths.auditDir, 'operations.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!).commit_or_artifact_hash).toBe(cp.head);
  });

  it('memory_lock: münhasır; yanlış token kilidi korur', () => {
    const a = svc.memoryLock('acquire', {});
    expect(() => svc.memoryLock('acquire', {})).toThrow(/kilitli/);
    expect(() => svc.memoryLock('release', { token: 'yanlış' })).toThrow(/uyuşmuyor/);
    expect(svc.memoryLock('release', { token: (a as { token: string }).token })).toMatchObject({
      released: true,
    });
    expect(svc.memoryLock('acquire', {})).toMatchObject({ acquired: true });
  });

  it('memory_metrics: ham prompt etiketi reddedilir', () => {
    const m = {
      task_id: null,
      method: 'lat-cli' as const,
      index_status: 'ready' as const,
      outcome: 'completed' as const,
    };
    expect(svc.memoryMetrics({ ...m, query_label: 'auth/login-flow' })).toEqual({ recorded: true });
    expect(() =>
      svc.memoryMetrics({ ...m, query_label: 'lütfen şu dosyayı düzelt ve...' }),
    ).toThrow();
  });
});

describe('anafor migrate', () => {
  it('.orchestrator → .anafor: politika, görevler, audit, checkpoint, metrikler; kaynak değişmez', () => {
    const t = tempDir();
    const src = join(t.dir, '.orchestrator');
    mkdirSync(join(src, 'audit'), { recursive: true });
    mkdirSync(join(src, 'checkpoints', 'CP-1'), { recursive: true });
    mkdirSync(join(src, 'memory'), { recursive: true });
    writeFileSync(
      join(src, 'OPERATION_POLICY.json'),
      '﻿' +
        JSON.stringify({
          project_id: 'eski',
          allowed_push_branches: ['feat/x'],
          allow_autonomous_commit: true,
        }),
    );
    writeFileSync(
      join(src, 'TASK_QUEUE.json'),
      JSON.stringify({
        tasks: [
          { task_id: 'TASK-1', objective: 'eski iş', status: 'completed' },
          { task_id: 'TASK-2', objective: 'yarım iş', status: 'active' },
        ],
      }),
    );
    writeFileSync(join(src, 'audit', 'operations.jsonl'), '{"operation":"commit"}\n');
    writeFileSync(join(src, 'checkpoints', 'CP-1', 'checkpoint.json'), '{}');
    writeFileSync(join(src, 'memory', 'context-metrics.jsonl'), '{"query_label":"x"}\n');
    const before = readFileSync(join(src, 'TASK_QUEUE.json'), 'utf8');
    const store = new Store(t.dir);
    try {
      const r = migrateFromOrchestrator(store);
      expect(r).toMatchObject({
        policy: 'migrated',
        tasks_imported: 2,
        audit_records: 1,
        checkpoints_copied: 1,
        metrics_records: 1,
      });
      const pol = JSON.parse(readFileSync(policyPath(store.paths.anaforDir), 'utf8'));
      expect(pol.project_id).toBe(store.paths.projectId);
      expect(pol.allowed_push_branches).toEqual(['feat/x']);
      const states = store
        .listTasks({ includeClosed: true })
        .map((x) => x.state)
        .sort();
      expect(states).toEqual(['accepted', 'open']);
      expect(readFileSync(join(src, 'TASK_QUEUE.json'), 'utf8')).toBe(before);
      expect(() => migrateFromOrchestrator(store)).toThrow(/zaten/);
    } finally {
      store.close();
      t.cleanup();
    }
  });
});
