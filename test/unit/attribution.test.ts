import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { maybeConfigureSetupAttribution } from '../../src/cli/setup-cmd.js';
import {
  anaforAttributionLine,
  applyPrAttribution,
  shouldEnablePrAttribution,
} from '../../src/core/attribution.js';

describe('PR attribution', () => {
  it('adds/removes only Anafor text and preserves Claude text and settings idempotently', () => {
    const initial = {
      permissions: { allow: ['Read'] },
      attribution: {
        commit: 'keep',
        pr: '🤖 Generated with [Claude Code](https://claude.com/claude-code)',
      },
    };
    const added = applyPrAttribution(initial, true, 'tr');
    expect(added.attribution).toEqual({
      commit: 'keep',
      pr: `🤖 Generated with [Claude Code](https://claude.com/claude-code)\n\n${anaforAttributionLine('tr')}`,
    });
    expect(applyPrAttribution(added, true, 'tr')).toEqual(added);
    expect(applyPrAttribution(added, false, 'tr')).toEqual({
      permissions: initial.permissions,
      attribution: { commit: 'keep' },
    });
    expect(added.permissions).toBe(initial.permissions);
  });
  it('provides English text', () =>
    expect(anaforAttributionLine('en')).toContain('Built with Anafor'));

  it('uses the Claude default only when pr is unset and removes it on disable', () => {
    const defaultLine = '🤖 Generated with [Claude Code](https://claude.com/claude-code)';
    const enabled = applyPrAttribution({ permissions: { allow: ['Read'] } }, true, 'en');
    expect((enabled.attribution as { pr: string }).pr).toBe(
      `${defaultLine}\n\n${anaforAttributionLine('en')}`,
    );
    const disabled = applyPrAttribution(enabled, false, 'en');
    expect(disabled.attribution).toBeUndefined();
    expect(disabled.permissions).toEqual({ allow: ['Read'] });
  });

  it('retains custom PR attribution and respects explicit opt-outs', () => {
    const custom = {
      attribution: { commit: 'custom commit', pr: 'Custom signature' },
      permissions: { deny: ['Bash'] },
    };
    const enabled = applyPrAttribution(custom, true, 'en');
    expect((enabled.attribution as { pr: string }).pr).toBe(
      `Custom signature\n\n${anaforAttributionLine('en')}`,
    );
    expect(applyPrAttribution(enabled, true, 'en')).toEqual(enabled);
    expect(applyPrAttribution(enabled, false, 'en')).toEqual(custom);
    expect(applyPrAttribution({ attribution: { pr: '' } }, true)).toEqual({
      attribution: { pr: '' },
    });
    expect(applyPrAttribution({ attribution: false }, true)).toEqual({ attribution: false });
  });

  it('only opts in on --yes or an interactive setup', () => {
    expect(shouldEnablePrAttribution(true, false)).toBe(true);
    expect(shouldEnablePrAttribution(false, false)).toBe(false);
    expect(shouldEnablePrAttribution(false, true)).toBe(true);
  });

  it('setup writes on --yes and leaves noninteractive projects untouched', async () => {
    const base = resolve('.anafor-tmp');
    mkdirSync(base, { recursive: true });
    const yesDir = mkdtempSync(join(base, 'setup-yes-'));
    const quietDir = mkdtempSync(join(base, 'setup-quiet-'));
    try {
      expect(
        await maybeConfigureSetupAttribution(yesDir, true, false, 'en', async () => false),
      ).toBe(true);
      expect(existsSync(join(yesDir, '.claude', 'settings.json'))).toBe(true);
      expect(
        await maybeConfigureSetupAttribution(quietDir, false, false, 'en', async () => true),
      ).toBe(false);
      expect(existsSync(join(quietDir, '.claude', 'settings.json'))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(yesDir, '.claude', 'settings.json'), 'utf8')).attribution.pr,
      ).toContain('Built with Anafor');
    } finally {
      rmSync(yesDir, { recursive: true, force: true });
      rmSync(quietDir, { recursive: true, force: true });
    }
  });

  it('normalizes language changes and removes empty attribution objects', () => {
    const tr = applyPrAttribution({}, true, 'tr');
    const en = applyPrAttribution(tr, true, 'en');
    expect((en.attribution as { pr: string }).pr.match(/Built with Anafor/g)).toHaveLength(1);
    expect((en.attribution as { pr: string }).pr).not.toContain('ile geliştirildi');
    expect(
      applyPrAttribution({ attribution: { pr: anaforAttributionLine('en') } }, false, 'en'),
    ).toEqual({});
  });
});
