import { describe, expect, it } from 'vitest';
import { withWorkerSafetyRules } from '../../src/adapters/codex.js';
import { setLang } from '../../src/i18n/index.js';

describe('işçi güvenlik kuralları', () => {
  it.each([
    [
      'tr',
      'İŞÇİ GÜVENLİK KURALLARI (zorunlu)',
      'curl veya wget',
      'onay isteyen bir işlemde dur ve bildir',
    ],
    [
      'en',
      'WORKER SAFETY RULES (required)',
      'Do not run curl or wget',
      'stop and report if an operation requires approval',
    ],
  ] as const)('%s diliyle kuralları ekler', (language, heading, curlRule, approvalRule) => {
    setLang(language);
    const prompt = withWorkerSafetyRules('işi yap');
    expect(prompt).toContain('işi yap');
    expect(prompt).toContain(heading);
    expect(prompt).toContain('git push');
    expect(prompt).toContain(curlRule);
    expect(prompt).toContain('rm -rf');
    expect(prompt).toContain(approvalRule);
  });
});
