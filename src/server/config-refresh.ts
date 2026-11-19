import { statSync } from 'node:fs';
import { join } from 'node:path';

export function configStamp(root: string): string {
  return ['.anafor/config.json', 'anafor.config.json']
    .map((file) => {
      try {
        const stat = statSync(join(root, file));
        return `${file}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${file}:missing`;
      }
    })
    .join('|');
}

/** Cheap per-tool-call check; invokes reload only when a config file changes. */
export function refreshConfigIfChanged(
  root: string,
  previousStamp: string,
  reload: () => void,
): string {
  const current = configStamp(root);
  if (current !== previousStamp) reload();
  return current;
}
