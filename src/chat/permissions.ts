import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { newId } from '../core/ids.js';

/**
 * Beyin ajanın izin istekleri için dosya tabanlı aracı (broker).
 * Claude Code `--permission-prompt-tool` → Anafor MCP `permission_prompt` aracı → istek dosyası
 * → `anafor chat` kullanıcıya sorar → yanıt dosyası → araç kararı döner.
 * Kimse yanıtlamazsa süre sonunda REDDEDİLİR (izin atlatma yok).
 */
export interface PermissionRequest {
  id: string;
  tool_name: string;
  input: unknown;
  created_at: string;
}

export interface PermissionDecision {
  behavior: 'allow' | 'deny';
  message?: string;
  /** "Bu oturumda bu araca hep izin ver" */
  remember?: boolean;
}

const dir = (anaforDir: string) => join(anaforDir, 'permissions');

export function submitRequest(
  anaforDir: string,
  toolName: string,
  input: unknown,
): PermissionRequest {
  mkdirSync(dir(anaforDir), { recursive: true });
  const req: PermissionRequest = {
    id: newId('E'),
    tool_name: toolName,
    input,
    created_at: new Date().toISOString(),
  };
  writeFileSync(join(dir(anaforDir), `${req.id}.req.json`), JSON.stringify(req));
  return req;
}

export function pendingRequests(anaforDir: string): PermissionRequest[] {
  if (!existsSync(dir(anaforDir))) return [];
  return readdirSync(dir(anaforDir))
    .filter((f) => f.endsWith('.req.json'))
    .filter((f) => !existsSync(join(dir(anaforDir), f.replace('.req.json', '.res.json'))))
    .map((f) => JSON.parse(readFileSync(join(dir(anaforDir), f), 'utf8')) as PermissionRequest)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

export function respond(anaforDir: string, id: string, decision: PermissionDecision): void {
  writeFileSync(join(dir(anaforDir), `${id}.res.json`), JSON.stringify(decision));
}

/** Kalıcı "hep izin ver" listesi (yalnızca oturum boyunca, chat başlatınca temizlenir). */
const allowFile = (anaforDir: string) => join(dir(anaforDir), 'session-allow.json');

export function rememberedAllow(anaforDir: string): string[] {
  try {
    return JSON.parse(readFileSync(allowFile(anaforDir), 'utf8')) as string[];
  } catch {
    return [];
  }
}

export function resetRemembered(anaforDir: string): void {
  mkdirSync(dir(anaforDir), { recursive: true });
  writeFileSync(allowFile(anaforDir), '[]');
}

export async function awaitDecision(
  anaforDir: string,
  req: PermissionRequest,
  timeoutMs: number,
  pollMs = 300,
): Promise<PermissionDecision> {
  const res = join(dir(anaforDir), `${req.id}.res.json`);
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(res)) {
      const d = JSON.parse(readFileSync(res, 'utf8')) as PermissionDecision;
      rmSync(res, { force: true });
      rmSync(join(dir(anaforDir), `${req.id}.req.json`), { force: true });
      if (d.behavior === 'allow' && d.remember) {
        const list = new Set(rememberedAllow(anaforDir));
        list.add(req.tool_name);
        writeFileSync(allowFile(anaforDir), JSON.stringify([...list]));
      }
      return d;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  rmSync(join(dir(anaforDir), `${req.id}.req.json`), { force: true });
  return { behavior: 'deny', message: 'İzin isteği yanıtlanmadı (zaman aşımı); reddedildi.' };
}

/** MCP permission_prompt aracının mantığı: Claude Code'un beklediği yanıt biçimi. */
export async function decidePermission(
  anaforDir: string,
  toolName: string,
  input: Record<string, unknown>,
  timeoutMs = 10 * 60_000,
): Promise<
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
> {
  if (rememberedAllow(anaforDir).includes(toolName))
    return { behavior: 'allow', updatedInput: input };
  const req = submitRequest(anaforDir, toolName, input);
  const d = await awaitDecision(anaforDir, req, timeoutMs);
  return d.behavior === 'allow'
    ? { behavior: 'allow', updatedInput: input }
    : { behavior: 'deny', message: d.message ?? 'Kullanıcı reddetti.' };
}
