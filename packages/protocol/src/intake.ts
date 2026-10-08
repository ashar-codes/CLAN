// External intake ("share to CLAN" from other apps / the browser). Used by desktop and mobile.
export type IntakeInput = { kind: 'url'; url: string; title?: string } | { kind: 'text'; text: string; title?: string };

/**
 * Parses an external intake request (`clan://capture?url=…` or `clan://capture?text=…&title=…`). Only links and text
 * can arrive this way — never files or paths (those come from a real drag-drop or the OS share sheet as file handles).
 * Anything unexpected is rejected rather than repaired.
 */
export function parseIntake(raw: string): IntakeInput | null {
  if (typeof raw !== 'string' || raw.length > 12_000) return null;
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'clan:' || (u.hostname !== 'capture' && u.pathname.replace(/^\/+/, '') !== 'capture')) return null;
  const keys = [...u.searchParams.keys()];
  if (keys.some((k) => !['url', 'text', 'title'].includes(k)) || new Set(keys).size !== keys.length) return null;
  const clean = (s: string | null, max: number) => (s === null ? undefined : /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f‪-‮⁦-⁩]/.test(s) || s.length > max ? null : s.trim());
  const title = clean(u.searchParams.get('title'), 300);
  if (title === null) return null;
  const url = u.searchParams.get('url'), text = u.searchParams.get('text');
  if ((url === null) === (text === null)) return null; // exactly one of url / text
  if (url !== null) {
    let target: URL;
    try { target = new URL(url); } catch { return null; }
    if (!['http:', 'https:'].includes(target.protocol) || url.length > 2048 || target.username || target.password) return null;
    return { kind: 'url', url: target.href, ...(title ? { title } : {}) };
  }
  const t = clean(text, 10_000);
  return t ? { kind: 'text', text: t, ...(title ? { title } : {}) } : null;
}

