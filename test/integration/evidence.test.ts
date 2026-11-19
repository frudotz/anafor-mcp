import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeAdapter } from '../../src/adapters/fake.js';
import type { AdapterRegistry } from '../../src/adapters/registry.js';
import { git } from '../../src/git/git.js';
import { scanDiffForSecrets } from '../../src/governance/evidence.js';
import { AnaforService, inProcessLauncher } from '../../src/server/service.js';
import { Store } from '../../src/store/store.js';
import { tempDir } from '../helpers.js';

function initRepo(dir: string): void {
  git(dir, ['init', '-q', '-b', 'main']);
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
  );
  writeFileSync(join(dir, '.gitignore'), '.anafor/\n');
  git(dir, ['add', '-A']);
  git(dir, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);
}

// Desenleri tetikleyen ama gerçek olmayan örnek değerler (kaynakta düz yazılmaz).
const FAKE_AWS = ['AKIA', 'ABCDEFGHIJKLMNOP'].join('');
const FAKE_GH = ['ghp', '_', 'a'.repeat(36)].join('');

describe('gizli bilgi taraması', () => {
  it('yalnızca eklenen satırlarda, dosya ve satırla; değer döndürülmez', () => {
    const patch = [
      'diff --git a/a.ts b/a.ts',
      '+++ b/a.ts',
      '@@ -0,0 +1,3 @@',
      '+const ok = 1;',
      `+const key = "${FAKE_AWS}";`,
      `+const t = '${FAKE_GH}';`,
      '+++ b/b.ts',
      '@@ -5,0 +6,1 @@',
      '-const old = "eski";',
      '+password = "supersecret123"',
    ].join('\n');
    const f = scanDiffForSecrets(patch);
    expect(f).toEqual([
      { rule: 'aws-access-key', file: 'a.ts', line: 2 },
      { rule: 'github-token', file: 'a.ts', line: 3 },
      { rule: 'generic-secret', file: 'b.ts', line: 6 },
    ]);
    expect(JSON.stringify(f)).not.toContain(FAKE_AWS);
  });

  it('temiz diff', () => {
    expect(scanDiffForSecrets('+++ b/x.ts\n@@ -0,0 +1 @@\n+export const x = 1;')).toEqual([]);
  });
});

describe('evidence_generate', () => {
  let t: ReturnType<typeof tempDir>;
  let store: Store;
  let svc: AnaforService;
  const adapters: AdapterRegistry = new Map([['fake', new FakeAdapter()]]);
  beforeEach(() => {
    t = tempDir();
    initRepo(t.dir);
    store = new Store(t.dir);
    svc = new AnaforService(store, adapters, inProcessLauncher(adapters), 'fake');
  });
  afterEach(() => {
    store.close();
    t.cleanup();
  });

  it('kabul edilmiş görev: test + tarama kanıtı → operation_authorize commit yetkili', async () => {
    const task = svc.taskCreate({ title: 'k', objective: 'x' });
    const d = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake-file:k.txt]',
    });
    await svc.jobWait([d.job_id], 30);
    expect(svc.taskAccept(task.task_id, d.job_id).accepted).toBe(true);
    const ev = svc.evidenceGenerate(task.task_id);
    expect(ev.tests?.passed).toBe(true);
    expect(ev.scan.clean).toBe(true);
    expect(readFileSync(join(t.dir, ev.scan.evidence), 'utf8')).toContain('sonuç: temiz');
    const cp = svc.checkpoint('commit', task.task_id);
    const auth = svc.operationAuthorize({
      operation: 'commit',
      reason: 'kanıtlı',
      task_id: task.task_id,
      actor: 'claude',
      checkpoint: cp.checkpoint_path,
      test_evidence: ev.tests!.evidence,
      sensitive_scan_evidence: ev.scan.evidence,
      tests_passed: ev.tests!.passed,
      user_changes_preserved: true,
      sensitive_scan_clean: ev.scan.clean,
      branch: 'main',
    });
    expect(auth.reasons).toEqual([]);
  });

  it('görev dalında gizli bilgi varsa tarama kirli', async () => {
    const task = svc.taskCreate({ title: 's', objective: 'x' });
    const d = await svc.jobDispatch({
      taskId: task.task_id,
      role: 'implementation',
      instructions: '[fake-file:k.txt]',
    });
    await svc.jobWait([d.job_id], 30);
    writeFileSync(
      join(store.mustGetJob(d.job_id).workdir, 'cfg.ts'),
      `export const k = "${FAKE_AWS}";\n`,
    );
    expect(svc.taskAccept(task.task_id, d.job_id).accepted).toBe(true);
    const ev = svc.evidenceGenerate(task.task_id, { skipTests: true });
    expect(ev.tests).toBeNull();
    expect(ev.scan.clean).toBe(false);
    expect(ev.scan.findings[0]).toMatchObject({ rule: 'aws-access-key', file: 'cfg.ts' });
  });

  it('başarısız test komutu kanıtta görünür', () => {
    const task = svc.taskCreate({ title: 'f', objective: 'x' });
    const ev = svc.evidenceGenerate(task.task_id, { testCommand: 'node -e "process.exit(3)"' });
    expect(ev.tests?.passed).toBe(false);
    expect(readFileSync(join(t.dir, ev.tests!.evidence), 'utf8')).toContain('çıkış kodu: 3');
  });

  it('project_status son kapanan görevleri gösterir (N3)', async () => {
    const task = svc.taskCreate({ title: 'kapanan', objective: 'x' });
    svc.taskClose(task.task_id, 'abandoned', 'test');
    expect(svc.projectStatus().recently_closed.map((x) => x.task_id)).toContain(task.task_id);
  });
});

describe('Anafor kanıtıyla doğrulanmış kabul', () => {
  it('işçi testleri çalıştıramadı (partial): kanıtsız red, taze kanıt + gerekçe ile kabul', async () => {
    const t = tempDir();
    initRepo(t.dir);
    mkdirSync(join(t.dir, '.anafor'), { recursive: true });
    writeFileSync(join(t.dir, '.anafor', 'config.json'), JSON.stringify({ auto_check: false }));
    const store = new Store(t.dir);
    const adapters: AdapterRegistry = new Map([['fake', new FakeAdapter()]]);
    const svc = new AnaforService(store, adapters, inProcessLauncher(adapters), 'fake');
    try {
      const task = svc.taskCreate({ title: 'p', objective: 'x' });
      const d = await svc.jobDispatch({
        taskId: task.task_id,
        role: 'implementation',
        instructions: '[fake:partial] [fake-file:p.txt]',
      });
      await svc.jobWait([d.job_id], 30);
      const plain = svc.taskAccept(task.task_id, d.job_id);
      expect(plain.failed_gates.map((g) => g.gate)).toEqual(
        expect.arrayContaining(['status_completed', 'requirements_complete', 'tests_pass']),
      );
      // kanıt yokken gerekçe yetmez
      const noEv = svc.taskAccept(task.task_id, d.job_id, undefined, { reason: 'diff incelendi' });
      expect(noEv.failed_gates.map((g) => g.gate)).toContain('verified_by_evidence');
      // Anafor kendi kanıtını üretir (görev dalı yok, çalışma ağacı taranır)
      const ev = svc.evidenceGenerate(task.task_id);
      expect(ev.tests?.passed).toBe(true);
      const ok = svc.taskAccept(task.task_id, d.job_id, undefined, {
        reason: 'diff incelendi; işçi sandbox’ı test çalıştıramadı',
      });
      expect(ok.failed_gates).toEqual([]);
      expect(ok.accepted).toBe(true);
      expect(readFileSync(join(store.paths.auditDir, 'tasks.jsonl'), 'utf8')).toContain(
        'accept_verified_by_evidence',
      );
    } finally {
      store.close();
      t.cleanup();
    }
  });
});

describe('gitleaks raporu', () => {
  it('kural, dosya, satır alınır; gizli değer alınmaz', async () => {
    const { parseGitleaksReport } = await import('../../src/governance/evidence.js');
    const report = JSON.stringify([
      {
        RuleID: 'generic-api-key',
        File: 'cfg\\creds.ini',
        StartLine: 2,
        Secret: 'REDACTED',
        Match: 'x',
      },
    ]);
    const f = parseGitleaksReport(report);
    expect(f).toEqual([{ rule: 'gitleaks:generic-api-key', file: 'cfg/creds.ini', line: 2 }]);
    expect(JSON.stringify(f)).not.toContain('REDACTED');
    expect(parseGitleaksReport('bozuk')).toEqual([]);
  });
});
