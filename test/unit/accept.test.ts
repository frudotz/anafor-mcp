import { describe, expect, it } from 'vitest';
import { resolve, win32 } from 'node:path';
import { deepReviewCompleted, onlyMissingChecks, resolveEvidence } from '../../src/core/accept.js';
import { tempDir } from '../helpers.js';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';

describe('deep review partial sonucu', () => {
  it('satır aralığı ve worktree göreli kanıtını çözer, dış yolu reddeder', () => {
    const root = 'C:/repo';
    const worktree = 'C:/repo/.anafor/worktrees/job';
    expect(resolveEvidence(root, worktree, 'lat.md/tasks.md:148-150')).toBe(
      resolve(worktree, 'lat.md/tasks.md'),
    );
    expect(resolveEvidence(root, worktree, '.anafor/evidence/T-tests.txt:1')).toBe(
      resolve(root, '.anafor/evidence/T-tests.txt'),
    );
    expect(resolveEvidence(root, worktree, '../../../../outside.txt')).toBeNull();
  });
  it.each([
    ['src/a.ts:42', 'src/a.ts'],
    ['src/a.ts:42:7', 'src/a.ts'],
    ['src/a.ts#L10', 'src/a.ts'],
    ['src/a.ts#L10-L20', 'src/a.ts'],
    ['src/a.ts: açıklama', 'src/a.ts'],
    ['src/a.ts (açıklama)', 'src/a.ts'],
  ])('kanıt yolundaki açıklama konumunu kaldırır: %s', (input, expected) => {
    const root = 'C:/repo';
    const worktree = 'C:/repo/worktree';
    expect(resolveEvidence(root, worktree, input)).toBe(resolve(worktree, expected));
  });
  it('Windows mutlak yolundaki sürücü harfini korur ve dış yolu reddeder', () => {
    const root = 'C:/x';
    expect(resolveEvidence(root, root, 'C:\\x\\src\\a.ts:3')).toBe(win32.resolve(root, 'src/a.ts'));
  });
  it('Windows dışı mutlak kanıt yolunu reddeder', () => {
    expect(resolveEvidence('C:/x', 'C:/x', 'C:\\outside\\a.ts:3')).toBeNull();
  });
  it('parantezli açıklamayı ancak tam yol bulunamazsa kaldırır', () => {
    const root = process.cwd();
    expect(resolveEvidence(root, root, 'package.json (açıklama)')).toBe(
      resolve(root, 'package.json'),
    );
    const temp = tempDir();
    try {
      writeFileSync(join(temp.dir, 'foo (1).ts'), '');
      expect(resolveEvidence(temp.dir, temp.dir, 'foo (1).ts')).toBe(join(temp.dir, 'foo (1).ts'));
    } finally {
      temp.cleanup();
    }
  });
  it('boşluksuz fonksiyon açıklamasını kaldırır', () => {
    const root = process.cwd();
    expect(resolveEvidence(root, root, 'package.json:parseJson')).toBe(
      resolve(root, 'package.json'),
    );
  });
  it.each([
    'npm run check çalıştırılamadı (onay gerektirdi)',
    'vitest could not run: approval required',
    'testler çalıştırılmadı',
  ])('çalıştırma eksikliğini tanır: %s', (missing) => {
    expect(onlyMissingChecks([missing])).toBe(true);
  });

  it.each([
    "Güvenlik check'i yapılmadı",
    'run-job zaman aşımı incelenmedi',
    'Test kapsamı eksik: X için test yok',
  ])('gerçek eksikliği çalıştırma eksikliği saymaz: %s', (missing) => {
    expect(onlyMissingChecks([missing])).toBe(false);
  });

  it('partial yalnızca çalıştırma eksiği ve kritik bulgu yoksa tamamlanır', () => {
    expect(deepReviewCompleted('needs_review', 'partial', ['testler çalıştırılmadı'], 0)).toBe(
      true,
    );
    expect(deepReviewCompleted('needs_review', 'partial', ['güvenlik açığı incelenmedi'], 0)).toBe(
      false,
    );
    expect(deepReviewCompleted('needs_review', 'partial', ['testler çalıştırılmadı'], 1)).toBe(
      false,
    );
  });
});
