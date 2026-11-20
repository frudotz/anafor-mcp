import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { m } from '../i18n/index.js';

export type WatchdogRunner = (
  command: string,
  args: string[],
) => { status: number | null; stdout?: string };
const defaultRunner: WatchdogRunner = (command, args) => {
  const result = spawnSync(command, args, { windowsHide: true, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout };
};

export function watchdogCommand(
  action: string,
  platform = process.platform,
  runner = defaultRunner,
  root = process.cwd(),
): { lines: string[]; code: number } {
  if (!['install', 'uninstall', 'status'].includes(action))
    return { lines: [m().cli.watchdogUsage], code: 2 };
  if (platform !== 'win32' && action === 'install')
    return {
      lines: [
        m().cli.watchdogNonWindowsInstall,
        m().cli.watchdogCron,
        `*/5 * * * * cd "${root}" && anafor loop recover`,
        m().cli.watchdogLaunchd,
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0"><dict>',
        '<key>Label</key><string>com.anafor.loop-recover</string>',
        '<key>ProgramArguments</key><array>',
        ...[
          process.execPath,
          fileURLToPath(new URL('../cli/main.js', import.meta.url)),
          'loop',
          'recover',
        ].map(
          (arg) =>
            `<string>${arg.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`,
        ),
        '</array><key>StartInterval</key><integer>300</integer>',
        `<key>WorkingDirectory</key><string>${root.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')}</string>`,
        '</dict></plist>',
      ],
      code: 0,
    };
  if (platform !== 'win32')
    return {
      lines: [
        action === 'uninstall'
          ? m().cli.watchdogNonWindowsUninstall
          : m().cli.watchdogNonWindowsStatus,
      ],
      code: 0,
    };
  const dir = join(root, '.anafor');
  const scriptPath = join(dir, 'loop-recover.vbs');
  const cli = fileURLToPath(new URL('../cli/main.js', import.meta.url));
  const vb = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const hash = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 8);
  const task = `AnaforLoopRecover-${hash}`;
  if (action === 'install') {
    const taskCommand = `wscript.exe //B //NoLogo "${scriptPath}"`;
    if (taskCommand.length > 261) return { lines: [m().cli.watchdogPathTooLong], code: 1 };
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      scriptPath,
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(
          `Set shell = CreateObject("Wscript.Shell")\nnodePath = ${vb(process.execPath)}\ncliPath = ${vb(cli)}\nshell.CurrentDirectory = ${vb(root)}\nshell.Run Chr(34) & nodePath & Chr(34) & " " & Chr(34) & cliPath & Chr(34) & " loop recover", 0, False\n`,
          'utf16le',
        ),
      ]),
    );
    const result = runner('schtasks', [
      '/Create',
      '/SC',
      'MINUTE',
      '/MO',
      '5',
      '/TN',
      task,
      '/TR',
      taskCommand,
      '/RL',
      'LIMITED',
      '/F',
    ]);
    return result.status === 0
      ? { lines: [m().cli.watchdogInstalled], code: 0 }
      : { lines: [m().cli.watchdogInstallFailed(result.status)], code: 1 };
  }
  if (action === 'uninstall') {
    const result = runner('schtasks', ['/Delete', '/TN', task, '/F']);
    try {
      unlinkSync(scriptPath);
    } catch {
      /* wrapper may not exist */
    }
    return result.status === 0
      ? { lines: [m().cli.watchdogRemoved], code: 0 }
      : { lines: [m().cli.watchdogRemoveFailed(result.status)], code: 1 };
  }
  const result = runner('schtasks', ['/Query', '/TN', task]);
  return result.status === 0
    ? { lines: [result.stdout ?? m().cli.watchdogInstalled], code: 0 }
    : { lines: [m().cli.watchdogNotInstalled], code: 1 };
}
