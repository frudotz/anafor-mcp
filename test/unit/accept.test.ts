import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { deepReviewCompleted, onlyMissingChecks, resolveEvidence } from '../../src/core/accept.js';

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
