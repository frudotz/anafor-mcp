import { loadConfig, resolveProjectRoot } from '../core/config.js';
import { readStoredLimits } from '../limits/limits.js';
import { m } from '../i18n/index.js';
import { brainLimitDecision } from '../loop/decision.js';

/** Reads only cached limit data; emits Claude Code hook JSON when the brain limit is high. */
export function runUserPromptSubmit(
  input: { cwd?: string },
  env: NodeJS.ProcessEnv = process.env,
): string {
  try {
    const project = resolveProjectRoot(env, input.cwd ?? process.cwd());
    if (!project.initialized) return '';
    const brainConfig = loadConfig(project.root).limits.brain;
    const limits = readStoredLimits(env).claude ?? null;
    const decision = brainLimitDecision(limits, brainConfig);
    if (decision.action === 'continue' || !decision.window) return '';
    const used = limits?.windows.find((window) => window.name === decision.window)?.used_percent;
    if (used === undefined) return '';
    const pct = Math.round(used);
    const text = m().hooks.limitPrompt(pct);
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: text },
    });
  } catch {
    return '';
  }
}
