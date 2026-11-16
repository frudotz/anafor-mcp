import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { git } from '../git/git.js';

export interface CheckpointMeta {
  schema_version: 1;
  checkpoint_id: string;
  project_id: string;
  task_id: string | null;
  actor: string;
  created_at: string;
  reason: string;
  branch: string;
  head: string;
  is_clean: boolean;
  dirty_entry_count: number;
  untracked_count: number;
}

/**
 * Önemli bir işlemden önce git durumunun kaydı: dal, HEAD, status, izlenen patch,
 * izlenmeyen dosyaların SHA-256'ları. Çalışma ağacını DEĞİŞTİRMEZ.
 */
export function createCheckpoint(
  root: string,
  checkpointsDir: string,
  input: { projectId: string; taskId: string | null; actor: string; reason: string },
): CheckpointMeta & { checkpoint_path: string } {
  if (!input.reason.trim()) throw new Error('checkpoint gerekçesi zorunlu');
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) throw new Error('checkpoint bir git deposu gerektirir');
  if (resolve(top.stdout.trim()).toLowerCase() !== resolve(root).toLowerCase()) {
    throw new Error('checkpoint proje kökünün git deposu kökü olmasını gerektirir');
  }
  const branch = git(root, ['branch', '--show-current']).stdout.trim();
  const headR = git(root, ['rev-parse', '--verify', 'HEAD']);
  const head = headR.code === 0 ? headR.stdout.trim() : 'unborn';
  const status = git(root, ['status', '--porcelain=v1', '-uall']).stdout;
  const statusLines = status.split('\n').filter((l) => l.trim() && !l.includes('.anafor/'));
  const patch =
    head === 'unborn'
      ? git(root, ['diff', '--binary']).stdout + git(root, ['diff', '--cached', '--binary']).stdout
      : git(root, ['diff', '--binary', 'HEAD']).stdout;
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
    .stdout.split('\n')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('.anafor/'))
    .map((p) => {
      const f = join(root, p);
      const sha256 =
        existsSync(f) && statSync(f).isFile()
          ? createHash('sha256').update(readFileSync(f)).digest('hex')
          : 'non-file';
      return { path: p, sha256 };
    });
  const stamp = new Date()
    .toISOString()
    .replace(/[-:.TZ]/g, '')
    .slice(0, 17);
  const id = `${(input.taskId ?? 'UNASSIGNED').replace(/[^A-Za-z0-9._-]/g, '_')}-${stamp}-${randomBytes(4).toString('hex')}`;
  const dir = join(checkpointsDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'git-status.txt'), status);
  writeFileSync(join(dir, 'branch.txt'), branch);
  writeFileSync(join(dir, 'head.txt'), head);
  writeFileSync(join(dir, 'tracked-changes.patch'), patch);
  writeFileSync(join(dir, 'untracked-files.json'), JSON.stringify(untracked, null, 2));
  const meta: CheckpointMeta = {
    schema_version: 1,
    checkpoint_id: id,
    project_id: input.projectId,
    task_id: input.taskId,
    actor: input.actor,
    created_at: new Date().toISOString(),
    reason: input.reason,
    branch,
    head,
    is_clean: statusLines.length === 0,
    dirty_entry_count: statusLines.length,
    untracked_count: untracked.length,
  };
  writeFileSync(join(dir, 'checkpoint.json'), JSON.stringify(meta, null, 2));
  return { ...meta, checkpoint_path: relative(root, dir).replace(/\\/g, '/') };
}

/** Checkpoint yolunu doğrular ve meta verisini okur (yalnızca proje içi checkpoint'ler). */
export function readCheckpoint(root: string, checkpointsDir: string, ref: string): CheckpointMeta {
  const abs = isAbsolute(ref) ? ref : resolve(root, ref);
  const rel = relative(checkpointsDir, abs);
  const file = join(abs, 'checkpoint.json');
  if (rel.startsWith('..') || isAbsolute(rel) || !existsSync(file)) {
    throw new Error('checkpoint, proje içi geçerli bir Anafor checkpoint dizini olmalı');
  }
  return JSON.parse(readFileSync(file, 'utf8')) as CheckpointMeta;
}
