// Shared bits for the people screens: live reload on changes, small formatting helpers, avatar initials.
import { useEffect, useState, useCallback } from 'react';
import { api } from '../../App.tsx';

/** Re-runs `load` whenever people data changes (messages, requests, transfers, nearby). */
export function usePeople<T>(load: () => Promise<T>, deps: unknown[] = []): [T | null, () => void, string] {
  const [v, setV] = useState<T | null>(null), [err, setErr] = useState('');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const reload = useCallback(() => { void load().then((x) => { setV(x); setErr(''); }, (e) => setErr(errText(e))); }, deps);
  useEffect(() => { reload(); }, [reload]);
  useEffect(() => api.people.onChanged(() => reload()), [reload]);
  return [v, reload, err];
}
export const errText = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');
export const ago = (t: number) => { const s = Math.max(0, Math.round((Date.now() - t) / 1000)); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
/** “in 23 min”, “in 5 h”, “in 2 days” — for messages that disappear. */
export const until = (t: number) => { const s = Math.max(0, Math.round((t - Date.now()) / 1000)); return s < 60 ? 'in under a minute' : s < 3600 ? `in ${Math.round(s / 60)} min` : s < 86400 ? `in ${Math.round(s / 3600)} h` : `in ${Math.round(s / 86400)} days`; };
export const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
export const mb = (n: number) => n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;
export const ttlLabel = (ms: number | null) => !ms ? 'Saved' : ms <= 3_600_000 ? 'Disappears after 1 hour' : ms <= 86_400_000 ? 'Disappears after 24 hours' : 'Disappears after 7 days';
export function Initials({ name, size = 36 }: { name: string; size?: number }) {
  const i = name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('') || '?';
  return <span className="person-avatar" aria-hidden style={{ width: size, height: size, lineHeight: `${size}px`, fontSize: size / 2.6 }}>{i}</span>;
}
export const REL: Record<string, string> = { friend: 'Friend', incoming: 'Asked to be friends', outgoing: 'Request sent', none: '' };
