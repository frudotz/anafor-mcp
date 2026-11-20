/** Safely classify provider limit errors without treating ordinary failures as limits. */
export function isRateLimitError(message: string): boolean {
  const text = message.toLowerCase();
  if (/rate_limit_event/.test(text) && /status["'\s:=]+rejected/.test(text)) return true;
  if (/\b(?:http|status|code)\s*[:=]?\s*429\b/.test(text) || /\btoo many requests\b/.test(text))
    return true;
  return /\b(?:usage|rate)[ -]limit\b/.test(text);
}
