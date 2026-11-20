import { describe, expect, it } from 'vitest';
import { buildGoalPrompt } from '../../src/cli/run.js';
import { setLang } from '../../src/i18n/index.js';

describe('headless hedef prompt', () => {
  it('varsayılan: kabul ve birleştirme yok', () => {
    const p = buildGoalPrompt({ goal: 'X ekle', accept: false, merge: false });
    expect(p).toContain('Hedef: X ekle');
    expect(p).toContain('task_accept ÇAĞIRMA');
    expect(p).toContain('task_merge ÇAĞIRMA');
  });
  it('--accept --merge: yönetişim zinciri', () => {
    const p = buildGoalPrompt({
      goal: 'X',
      accept: true,
      merge: true,
      worker: 'codex',
      reviewLevel: 'deep',
    });
    expect(p).toContain('worker=codex');
    expect(p).toContain('review_level=deep');
    expect(p).toContain('evidence_generate → checkpoint → operation_authorize');
  });
  it('--merge tek başına birleştirmez', () => {
    expect(buildGoalPrompt({ goal: 'X', accept: false, merge: true })).toContain(
      'task_merge ÇAĞIRMA',
    );
  });
  it('atıf satırını seçili dilde içerir', () => {
    setLang('tr');
    expect(buildGoalPrompt({ goal: 'x', accept: false, merge: false })).toContain(
      'ile geliştirildi',
    );
    setLang('en');
    expect(buildGoalPrompt({ goal: 'x', accept: false, merge: false })).toContain(
      'Built with [Anafor]',
    );
    setLang('tr');
  });
});
