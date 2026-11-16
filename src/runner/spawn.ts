import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Derlenmiş runner betiği (dist/runner/main.js). */
export function runnerScriptPath(): string {
  const here = fileURLToPath(import.meta.url);
  // src/runner/spawn.ts altından çalışıyorsak (testler) dist'teki karşılığını kullan.
  const js = here.endsWith('.ts')
    ? fileURLToPath(new URL('../../dist/runner/main.js', import.meta.url))
    : fileURLToPath(new URL('./main.js', import.meta.url));
  return js;
}

/**
 * İşi MCP sunucusundan bağımsız, ayrık bir süreçte başlatır.
 * Sunucu kapansa da iş sürer; çıktı iş artefakt dizinine yazılır.
 */
export function spawnDetachedRunner(
  projectRoot: string,
  jobId: string,
  artifactsDir: string,
): number {
  const script = runnerScriptPath();
  if (!existsSync(script)) {
    throw new Error(`Runner bulunamadı: ${script} (önce \`npm run build\`)`);
  }
  mkdirSync(artifactsDir, { recursive: true });
  const out = openSync(join(artifactsDir, 'runner.log'), 'a');
  const child = spawn(process.execPath, [script, projectRoot, jobId], {
    detached: true,
    stdio: ['ignore', out, out],
    windowsHide: true,
  });
  child.unref();
  if (child.pid === undefined) throw new Error('Runner süreci başlatılamadı');
  return child.pid;
}
