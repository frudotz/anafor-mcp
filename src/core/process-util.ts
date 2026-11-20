import { spawnSync } from 'node:child_process';

/** Süreç hâlâ yaşıyor mu? */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** pid ile süreç ağacını sonlandırır (Windows: taskkill /T, POSIX: grup + süreç). */
export function killPidTree(pid: number): void {
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
      stdio: 'ignore',
      windowsHide: true,
    });
    return;
  }
  for (const target of [-pid, pid]) {
    try {
      process.kill(target, 'SIGTERM');
    } catch {
      // yok sayılır
    }
  }
}
