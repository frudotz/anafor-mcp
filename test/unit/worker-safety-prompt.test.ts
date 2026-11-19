import { describe, expect, it } from 'vitest';
import { withWorkerSafetyRules } from '../../src/adapters/codex.js';

describe('işçi güvenlik kuralları', () => {
  it('iş emrine yasak komutları ve izin gevşetmeme kuralını ekler', () => {
    const prompt = withWorkerSafetyRules('işi yap');
    expect(prompt).toContain('git push');
    expect(prompt).toContain('curl veya wget');
    expect(prompt).toContain('worktree dışına yönelik rm -rf');
    expect(prompt).toContain('Sandbox veya izinleri gevşetme');
    expect(prompt).toContain('onay isteyen bir işlemde dur ve bildir');
  });
});
