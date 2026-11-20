import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export function configureAnaforIgnore(root: string, excludeLocal: boolean): boolean {
  const target = excludeLocal
    ? (() => {
        const common = spawnSync(
          'git',
          ['rev-parse', '--path-format=absolute', '--git-common-dir'],
          { cwd: root, encoding: 'utf8', windowsHide: true },
        );
        if (common.status !== 0) throw new Error('Git ortak dizini bulunamadı');
        return join(common.stdout.trim(), 'info', 'exclude');
      })()
    : join(root, '.gitignore');
  if (excludeLocal) mkdirSync(join(target, '..'), { recursive: true });
  const content = existsSync(target) ? readFileSync(target, 'utf8') : '';
  if (/^\.anafor\/?$/m.test(content)) return false;
  appendFileSync(target, `${content.endsWith('\n') || content === '' ? '' : '\n'}.anafor/\n`);
  return !excludeLocal;
}
