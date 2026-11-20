import { describe, expect, it } from 'vitest';
import { serverInstructions } from '../../src/server/tools.js';
import { lang, m, setLang } from '../../src/i18n/index.js';

describe('PR attribution instructions', () => {
  it.each(['tr', 'en'] as const)(
    '%s server and loop prompts use only that language line',
    (language) => {
      const previous = lang();
      setLang(language);
      const line = m().attribution.prLine;
      const other = language === 'tr' ? mFor('en') : mFor('tr');
      expect(serverInstructions()).toContain(line);
      expect(serverInstructions()).not.toContain(other);
      const loopPrompt = m().cli.loopTurnPrompt('goal', false, false, 'balanced');
      expect(loopPrompt).toContain(line);
      expect(loopPrompt).not.toContain(other);
      setLang(previous);
    },
  );
});

function mFor(language: 'tr' | 'en'): string {
  const previous = lang();
  setLang(language);
  const line = m().attribution.prLine;
  setLang(previous);
  return line;
}
