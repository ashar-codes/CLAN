/**
 * Strip secrets from anything that might be logged: bearer tokens, PEM private keys, long base64/base64url blobs
 * (tokens, OPAQUE messages, keys, signatures) and 6-digit join codes.
 */
export function redact(input: unknown): string {
  let s = input instanceof Error ? describe(input) : typeof input === 'string' ? input : safeJson(input);
  s = s.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted-private-key]');
  s = s.replace(/(bearer\s+)[^\s"',;]+/gi, '$1[redacted]');
  s = s.replace(/("(?:token|code|password|sessionKey|teacherToken|serverSetup|privateKey|signature|mac|startLoginRequest|finishLoginRequest|loginResponse)"\s*:\s*)"[^"]*"/g, '$1"[redacted]"');
  s = s.replace(/[A-Za-z0-9+/_-]{32,}={0,2}/g, '[redacted]');
  s = s.replace(/(?<!\d)\d{6}(?!\d)/g, '[code]');
  return s;
}

/** "Name: message <- cause: message <- ..." (bounded), so nested library errors stay diagnosable. */
function describe(e: Error): string {
  const parts: string[] = [];
  for (let c: unknown = e, i = 0; c instanceof Error && i < 5; c = (c as { cause?: unknown }).cause, i++) {
    const code = (c as { code?: string }).code;
    parts.push(`${c.name}${code ? ` [${code}]` : ''}: ${c.message}`);
  }
  return parts.join(' <- ');
}

function safeJson(v: unknown) {
  try { return JSON.stringify(v); } catch { return String(v); }
}

const recent: { at: number; context: string; name: string; code: string | null }[] = [];
/** The only logging path the server uses. Also keeps the last 50 error *kinds* (context, name, code — never messages,
 *  which can carry paths or user text) for an opt-in diagnostic export. */
export const logError = (context: string, e: unknown) => {
  console.error(`[classroom] ${context}: ${redact(e)}`);
  recent.push({ at: Date.now(), context: context.slice(0, 40), name: e instanceof Error ? e.name.slice(0, 40) : typeof e, code: (e as { code?: unknown })?.code ? String((e as { code: unknown }).code).slice(0, 40) : null });
  if (recent.length > 50) recent.shift();
};
export const recentErrors = () => recent.map((r) => ({ ...r }));
