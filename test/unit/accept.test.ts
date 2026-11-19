import { describe, expect, it } from 'vitest';
import { deepReviewCompleted, onlyMissingChecks } from '../../src/core/accept.js';

describe('deep review partial sonucu', () => {
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
