import type { AnaforConfig } from '../core/config.js';
import { CirakAdapter } from './cirak.js';
import { CodexAdapter } from './codex.js';
import { FakeAdapter } from './fake.js';
import { AntigravityAdapter, GeminiAdapter } from './google.js';
import { LocalApiAdapter } from './local-api.js';
import { OpenCodeAdapter } from './opencode.js';
import type { WorkerAdapter } from './types.js';

export type AdapterRegistry = ReadonlyMap<string, WorkerAdapter>;

/**
 * Adaptör kümesi. Yeni bir işçi = WorkerAdapter uygulayan bir sınıf + buraya bir satır.
 * Ayarlar config `workers.<id>` altından gelir; `enabled: false` işçiyi kapatır.
 * Yapılandırma gerektiren işçiler (opencode, local) ve gri alandaki işçiler (antigravity)
 * yalnızca açıkça yapılandırılınca kaydedilir.
 */
export function defaultAdapters(
  config?: Pick<AnaforConfig, 'workers'> & Partial<Pick<AnaforConfig, 'test_command'>>,
): AdapterRegistry {
  const w = config?.workers ?? {};
  const cirak = { ...w['claude-lite'], ...w.cirak };
  const opt = <T extends object>(o: T) =>
    Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  const list: WorkerAdapter[] = [
    new CodexAdapter(
      opt({
        bin: w.codex?.bin,
        maxConcurrency: w.codex?.max_concurrency,
        windowsSandbox: w.codex?.windows_sandbox,
        userConfig: w.codex?.user_config,
      }),
    ),
    new CirakAdapter(
      opt({
        bin: cirak.bin,
        model: cirak.model,
        maxConcurrency: cirak.max_concurrency,
        allowedTools: cirak.allowed_tools,
        userConfig: cirak.user_config,
      }),
    ),
    new GeminiAdapter(
      opt({
        bin: w.gemini?.bin,
        model: w.gemini?.model,
        maxConcurrency: w.gemini?.max_concurrency,
      }),
    ),
    new FakeAdapter(),
  ];
  if (w.opencode?.model) {
    list.push(
      new OpenCodeAdapter(
        opt({
          bin: w.opencode.bin,
          model: w.opencode.model,
          maxConcurrency: w.opencode.max_concurrency,
          allowAnthropicApi: w.opencode.allow_anthropic_api,
        }),
      ),
    );
  }
  if (w.local?.model) {
    list.push(
      new LocalApiAdapter(
        opt({
          model: w.local.model,
          baseUrl: w.local.base_url,
          apiKeyEnv: w.local.api_key_env,
          maxConcurrency: w.local.max_concurrency,
        }),
      ),
    );
  }
  if (w.antigravity?.enabled === true) {
    list.push(
      new AntigravityAdapter(
        opt({
          bin: w.antigravity.bin,
          model: w.antigravity.model,
          maxConcurrency: w.antigravity.max_concurrency,
          acknowledged: w.antigravity.acknowledge_terms === true,
          allowedCommands: [
            ...(config?.test_command ? [config.test_command] : []),
            ...(w.antigravity.allowed_commands ?? []),
          ],
        }),
      ),
    );
  }
  return new Map(
    list
      .filter((a) => (a.id === 'cirak' ? cirak.enabled : w[a.id]?.enabled) !== false)
      .map((a) => [a.id, a]),
  );
}
