import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildUserPlugin,
  enableAntigravity,
  installStatusline,
  readSetupState,
  writeSetupState,
} from '../../src/setup/setup.js';
import { tempDir } from '../helpers.js';

describe('kurulum', () => {
  it('does not create local config without a project root', () => {
    expect(enableAntigravity()).toBe(false);
  });
  it('Antigravity onayını yalnızca yerel config dosyasına yazar ve diğer ayarları korur', () => {
    const t = tempDir();
    try {
      writeFileSync(
        join(t.dir, 'anafor.config.json'),
        JSON.stringify({ workers: { antigravity: { enabled: false } } }),
      );
      mkdirSync(join(t.dir, '.anafor'));
      writeFileSync(
        join(t.dir, '.anafor', 'config.json'),
        JSON.stringify({ workers: { codex: { enabled: true } } }),
      );
      enableAntigravity(t.dir);
      expect(JSON.parse(readFileSync(join(t.dir, '.anafor', 'config.json'), 'utf8'))).toMatchObject(
        {
          workers: {
            codex: { enabled: true },
            antigravity: { enabled: true, accept_terms_risk: true },
          },
        },
      );
      expect(
        JSON.parse(readFileSync(join(t.dir, 'anafor.config.json'), 'utf8')).workers.antigravity
          .enabled,
      ).toBe(false);
    } finally {
      t.cleanup();
    }
  });
  it('kullanıcı düzeyi plugin + yerel marketplace: mutlak yollar, komutlar, manifest', () => {
    const t = tempDir();
    try {
      const env = { ANAFOR_HOME: t.dir };
      const { pluginDir, marketplaceDir } = buildUserPlugin(env);
      const mcp = JSON.parse(readFileSync(join(pluginDir, '.mcp.json'), 'utf8'));
      expect(isAbsolute(mcp.mcpServers.anafor.command)).toBe(true);
      expect(isAbsolute(mcp.mcpServers.anafor.args[0])).toBe(true);
      const hooks = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
      expect(hooks.hooks.PreToolUse[0].hooks[0].command).toMatch(/hook pre-tool-use$/);
      expect(hooks.hooks.SessionStart[0].hooks[0].command).toMatch(/hook session-start$/);
      expect(existsSync(join(pluginDir, 'commands', 'plan.md'))).toBe(true);
      const mp = JSON.parse(
        readFileSync(join(marketplaceDir, '.claude-plugin', 'marketplace.json'), 'utf8'),
      );
      expect(mp.name).toBe('anafor-local');
      expect(mp.plugins[0]).toMatchObject({ name: 'anafor', source: './plugins/anafor' });
      expect(
        JSON.parse(readFileSync(join(pluginDir, '.claude-plugin', 'plugin.json'), 'utf8')).name,
      ).toBe('anafor');
    } finally {
      t.cleanup();
    }
  });

  it('statusline: yoksa eklenir ve diğer ayarlar korunur (yedekli); varsa dokunulmaz', () => {
    const t = tempDir();
    try {
      const f = join(t.dir, 'settings.json');
      writeFileSync(f, JSON.stringify({ permissions: { defaultMode: 'auto' } }));
      expect(installStatusline(f).changed).toBe(true);
      const s = JSON.parse(readFileSync(f, 'utf8'));
      expect(s.permissions.defaultMode).toBe('auto');
      expect(s.statusLine.command).toMatch(/statusline$/);
      expect(existsSync(`${f}.anafor-backup`)).toBe(true);
      // ikinci kez: Anafor'un kendi statusLine'ı → zaten kurulu (✔), değişiklik yok
      const r = installStatusline(f);
      expect(r).toMatchObject({ changed: false, ok: true });
      expect(r.reason).toContain('zaten kurulu');
      // Anafor'un eski kurulum yolu → güncellenir
      const old = JSON.parse(readFileSync(f, 'utf8'));
      old.statusLine.command = '"node" "C:\\eski\\anafor-mcp\\dist\\cli\\main.js" statusline';
      writeFileSync(f, JSON.stringify(old));
      expect(installStatusline(f)).toMatchObject({ changed: true, reason: /güncellendi/ });
      // başkasının statusLine'ı korunur (✘)
      writeFileSync(
        f,
        JSON.stringify({ statusLine: { type: 'command', command: 'ccusage line' } }),
      );
      expect(installStatusline(f)).toMatchObject({
        changed: false,
        ok: false,
        reason: /korunuyor/,
      });
      expect(JSON.parse(readFileSync(f, 'utf8')).statusLine.command).toBe('ccusage line');
      // hiç dosya yoksa oluşturulur
      expect(installStatusline(join(t.dir, 'yeni', 'settings.json')).changed).toBe(true);
      // geçersiz JSON'a dokunulmaz
      writeFileSync(join(t.dir, 'bozuk.json'), '{bozuk');
      expect(installStatusline(join(t.dir, 'bozuk.json')).changed).toBe(false);
    } finally {
      t.cleanup();
    }
  });

  it('kurulum durumu', () => {
    const t = tempDir();
    try {
      const env = { ANAFOR_HOME: t.dir };
      expect(readSetupState(env)).toBeNull();
      writeSetupState(
        {
          version: '0',
          plugin_dir: 'p',
          marketplace_dir: 'm',
          plugin_installed: true,
          statusline_installed: false,
          updated_at: 'x',
        },
        env,
      );
      expect(readSetupState(env)?.plugin_installed).toBe(true);
    } finally {
      t.cleanup();
    }
  });
});
