import { createInterface, type Interface } from 'node:readline';
import { BrainSession, type BrainEvent } from '../chat/brain.js';
import {
  pendingRequests,
  resetRemembered,
  respond,
  type PermissionRequest,
} from '../chat/permissions.js';
import { ACTIVE_JOB_STATES } from '../core/states.js';
import { formatWindows, readCodexLimits, readStoredLimits } from '../limits/limits.js';
import { Store } from '../store/store.js';

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

/** Beyin olayını ekrana basılacak satıra çevirir (null: gösterme). */
export function renderBrainEvent(e: BrainEvent): string | null {
  switch (e.type) {
    case 'init':
      return c.dim(`[beyin oturumu ${e.sessionId.slice(0, 8)} · ${e.model}]`);
    case 'text':
      return `${c.cyan('beyin ›')} ${e.text}`;
    case 'tool':
      return c.dim(`  ⚙ ${e.name}${e.brief ? ` ${e.brief}` : ''}`);
    case 'result':
      return c.dim(
        `  ✓ tur bitti${e.turns !== null ? ` · ${e.turns} adım` : ''}${e.costUsd !== null ? ` · API eşdeğeri ~$${e.costUsd.toFixed(3)}` : ''}`,
      );
    case 'error':
      return c.red(`! ${e.message}`);
    case 'exit':
      return c.dim(`[beyin oturumu kapandı (${e.code ?? '?'})]`);
  }
}

/** İş panosu satırları (anafor jobs ve sohbet içi /jobs). */
export function jobsTable(store: Store, all = false): string[] {
  const tasks = store.listTasks({ includeClosed: all }).slice(0, 15);
  const lines: string[] = [];
  for (const t of tasks) {
    lines.push(`${c.bold(t.id)} [${t.state}] ${t.title}`);
    for (const j of store.listJobs({ taskId: t.id })) {
      const mark = ACTIVE_JOB_STATES.includes(j.state)
        ? c.yellow('●')
        : j.state === 'needs_review'
          ? c.cyan('◆')
          : c.dim('○');
      lines.push(
        `  ${mark} ${j.id} ${j.role.padEnd(14)} ${j.worker.padEnd(11)} ${j.state}${j.error ? c.red(` · ${j.error.slice(0, 60)}`) : ''}`,
      );
    }
  }
  return lines.length ? lines : [c.dim('(görev yok)')];
}

export function limitsLines(): string[] {
  const stored = readStoredLimits();
  const codex = readCodexLimits();
  const rows = { ...stored, ...(codex ? { codex } : {}) };
  const out = Object.values(rows).map(
    (r) => `${r.worker.padEnd(12)} ${r.status.padEnd(8)} ${formatWindows(r.windows)}`,
  );
  return out.length ? out : [c.dim('(limit bilgisi yok)')];
}

/** Yeni iş olaylarını izler (sohbet sırasında canlı iş takibi). */
class JobFollower {
  private seen = new Map<string, number>();
  constructor(private readonly store: Store) {}
  poll(): string[] {
    const out: string[] = [];
    const jobs = this.store.listJobs({
      states: [...ACTIVE_JOB_STATES, 'needs_review', 'failed', 'timed_out', 'invalid_output'],
    });
    for (const j of jobs) {
      const last = this.seen.get(j.id) ?? 0;
      const evs = this.store.listEvents(j.id, last, 20);
      for (const e of evs) {
        if (['message', 'command', 'file_change', 'error', 'cancel'].includes(e.type)) {
          out.push(
            c.dim(
              `  ↳ ${j.id} ${j.worker} ${e.type}: ${e.summary.replace(/\s+/g, ' ').slice(0, 110)}`,
            ),
          );
        }
        this.seen.set(j.id, e.seq);
      }
    }
    return out;
  }
}

export interface ChatOptions {
  root: string;
  newSession?: boolean;
  once?: string;
  model?: string;
  permissionMode?: string;
}

/**
 * `anafor chat`: beyin ajanla terminalden konuşma. Mesajlar resmi `claude` sürecine iletilir;
 * izin istekleri burada sorulur; işçi işleri canlı izlenir.
 */
export async function runChat(opts: ChatOptions): Promise<number> {
  const store = new Store(opts.root);
  resetRemembered(store.paths.anaforDir);
  const follower = new JobFollower(store);
  let rl: Interface | null = null;
  let busy = false;
  let closed = false;
  let asking = false;
  const print = (s: string) => {
    if (rl && !opts.once) {
      process.stdout.write('\r\x1b[K' + s + '\n');
      if (!busy && !asking) rl.prompt(true);
    } else {
      console.log(s);
    }
  };

  let resolveTurn: (() => void) | null = null;
  const brain = new BrainSession(
    {
      root: opts.root,
      ...(opts.newSession ? { newSession: true } : {}),
      ...(opts.model ? { model: opts.model } : {}),
      ...(opts.permissionMode ? { permissionMode: opts.permissionMode } : {}),
    },
    (e) => {
      const line = renderBrainEvent(e);
      if (line) print(line);
      if (e.type === 'result' || e.type === 'exit') {
        busy = false;
        resolveTurn?.();
        resolveTurn = null;
        if (e.type === 'exit') closed = true;
        if (rl && !opts.once && !closed) rl.prompt();
      }
    },
  );
  brain.start();

  const askPermission = async (req: PermissionRequest): Promise<void> => {
    if (opts.once || !rl) {
      respond(store.paths.anaforDir, req.id, {
        behavior: 'deny',
        message: 'Etkileşimsiz modda izin verilmez',
      });
      print(c.yellow(`! izin reddedildi (etkileşimsiz): ${req.tool_name}`));
      return;
    }
    asking = true;
    const brief = JSON.stringify(req.input).slice(0, 160);
    const answer = await new Promise<string>((resolve) =>
      rl!.question(
        c.yellow(
          `? Beyin izin istiyor: ${req.tool_name} ${brief}\n  [e]vet / [h]ayır / [d]aima (bu oturum): `,
        ),
        resolve,
      ),
    );
    asking = false;
    const a = answer.trim().toLowerCase();
    respond(store.paths.anaforDir, req.id, {
      behavior: a.startsWith('e') || a.startsWith('y') || a.startsWith('d') ? 'allow' : 'deny',
      remember: a.startsWith('d'),
      message: 'Kullanıcı reddetti',
    });
  };

  const handled = new Set<string>();
  const timer = setInterval(() => {
    for (const l of follower.poll()) print(l);
    if (asking) return;
    const next = pendingRequests(store.paths.anaforDir).find((r) => !handled.has(r.id));
    if (next) {
      handled.add(next.id);
      void askPermission(next);
    }
  }, 700);

  const turn = (text: string) =>
    new Promise<void>((resolve) => {
      busy = true;
      resolveTurn = resolve;
      brain.send(text);
    });

  try {
    if (opts.once) {
      await turn(opts.once);
      return 0;
    }
    console.log(c.bold('Anafor sohbet') + c.dim('  (/jobs, /limits, /izinler, /yeni, /cikis)'));
    rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: c.green('sen › '),
    });
    rl.prompt();
    for await (const raw of rl) {
      const line = raw.trim();
      if (asking) continue;
      if (!line) {
        rl.prompt();
        continue;
      }
      if (line === '/cikis' || line === '/exit') break;
      if (line === '/jobs') jobsTable(store).forEach((l) => print(l));
      else if (line === '/limits') limitsLines().forEach((l) => print(l));
      else if (line === '/izinler')
        print(`${pendingRequests(store.paths.anaforDir).length} bekleyen izin isteği`);
      else if (line === '/yeni')
        print(c.dim('Yeni oturum için çıkıp `anafor chat --new` çalıştırın.'));
      else if (closed) print(c.red('Beyin oturumu kapalı; `anafor chat` ile yeniden başlatın.'));
      else await turn(line);
      if (!busy) rl.prompt();
    }
    return 0;
  } finally {
    clearInterval(timer);
    brain.stop();
    rl?.close();
    store.close();
  }
}
