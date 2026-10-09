// Share to CLAN, pure part: turns what another app shared into capture inputs, or says why not. Untrusted input.
import { parseIntake } from '@classroom/protocol';
import type { CaptureInput } from '@clan/core';

export type SharedFile = { uri: string; name: string; mime: string; size: number };
export type Shared = { text: string | null; subject: string | null; files: SharedFile[]; errors: string[] };
export const MAX_INTAKE_BYTES = 200 * 1024 * 1024;

/** Pure: what can be captured from a share, and why anything was refused. */
export function intakeItems(s: Shared): { items: CaptureInput[]; refused: string[] } {
  const items: CaptureInput[] = [], refused = [...s.errors];
  const text = s.text?.trim();
  if (text) {
    const url = /^https?:\/\/\S+$/i.test(text) ? text : /(https?:\/\/[^\s]+)/i.exec(text)?.[1];
    const link = url ? parseIntake(`clan://capture?url=${encodeURIComponent(url)}${s.subject ? `&title=${encodeURIComponent(s.subject)}` : ''}`) : null;
    if (link?.kind === 'url') items.push({ kind: 'link', url: link.url, title: link.title });
    const rest = url ? text.replace(url, '').trim() : text;
    const t = rest ? parseIntake(`clan://capture?text=${encodeURIComponent(rest)}`) : null;
    if (t?.kind === 'text') items.push({ kind: 'text', text: t.text });
    else if (rest && !link) refused.push('That text can’t be saved (control characters or too long).');
  }
  for (const f of s.files.slice(0, 10)) {
    if (!/^file:\/\//.test(f.uri)) { refused.push(`${f.name}: not a file this app received.`); continue; }
    if (f.size > MAX_INTAKE_BYTES) { refused.push(`${f.name} is over 200 MB.`); continue; }
    items.push({ kind: 'file', path: f.uri, name: f.name.replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 200) || 'file', mime: f.mime.slice(0, 120) });
  }
  return { items, refused };
}

