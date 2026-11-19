const emitted = new Set<string>();

/** Emit each process warning at most once, even when configuration is reloaded. */
export function warnOnce(key: string, message: string): void {
  if (emitted.has(key)) return;
  emitted.add(key);
  console.warn(message);
}
