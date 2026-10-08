// Personal Space › Inbox: everything captured lands here first (private), plus files CLANmates sent you directly.
// Filing moves or shares the canonical item — nothing is copied, and nothing leaves Personal Space until you file it.
import { useEffect, useState } from 'react';
import type { InboxItem, ReceivedFile } from '../../shared.ts';
import { api } from '../App.tsx';
import { errText, useLoad } from './useLoad.ts';

const ICON: Record<InboxItem['kind'], string> = { note: '✎', link: '↗', text: '❝', file: '▤' };
const when = (ts: number) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export function Inbox({ onChanged }: { onChanged?(): void }) {
  const [items, reload] = useLoad<InboxItem[]>(api.capture.inbox);
  const [received] = useLoad<ReceivedFile[]>(api.chat.received);
  const [cols] = useLoad(api.clan.collections);
  const [clans] = useLoad(api.clan.list);
  const [err, setErr] = useState('');
  useEffect(() => api.capture.onAdded(reload), [reload]);
  const file = async (it: InboxItem, v: string) => {
    setErr('');
    const [kind, id] = v.split(':') as [string, string];
    try {
      await api.capture.file(it.id, kind === 'collection' ? { kind: 'collection', collectionId: id } : kind === 'done' ? { kind: 'done' } : { kind: kind as 'clan' | 'course', clanId: id });
      reload(); onChanged?.();
    } catch (e) { setErr(errText(e)); }
  };
  return (
    <section className="card inbox" aria-label="Inbox" data-testid="inbox">
      <header className="row between"><span className="eyebrow">Inbox · private until you file it</span><span className="muted c-num">{items?.length ?? 0}</span></header>
      {items?.length === 0 && <p className="muted small-text">Quick Capture puts notes, links, ideas and files here first.</p>}
      {items?.map((it) => (
        <div key={it.id} className="inbox-item" data-testid="inbox-item">
          <span className="qc-icon" aria-hidden>{ICON[it.kind]}</span>
          <span className="grow"><b>{it.title}</b><br /><small className="muted">{it.kind} · {when(it.createdAt)}{it.detail ? ` · ${it.detail.slice(0, 80)}` : ''}</small></span>
          <select value="" aria-label={`File ${it.title}`} onChange={(e) => void file(it, e.target.value)}>
            <option value="">File to…</option>
            {it.kind === 'link' && <optgroup label="Saved collection">{cols?.filter((c) => c.kind !== 'inbox').map((c) => <option key={c.id} value={`collection:${c.id}`}>{c.name}</option>)}</optgroup>}
            {!!clans?.filter((c) => c.type === 'CLASSROOM').length && <optgroup label="Course">{clans.filter((c) => c.type === 'CLASSROOM').map((c) => <option key={c.id} value={`course:${c.id}`}>{c.name}</option>)}</optgroup>}
            {!!clans?.length && <optgroup label="Share into a CLAN">{clans.map((c) => <option key={c.id} value={`clan:${c.id}`}>{c.name}</option>)}</optgroup>}
            <option disabled>A person — use CLANmate › Send in a live room</option>
            <option value="done:">Keep in Personal Space</option>
          </select>
        </div>
      ))}
      {err && <p className="error small-text">{err}</p>}
      {!!received?.length && <>
        <span className="eyebrow">Sent to you</span>
        {received.slice(0, 20).map((m) => m.attachment?.kind === 'file' && (
          <div key={m.id} className="inbox-item" data-testid="received-item">
            <span className="qc-icon" aria-hidden>▤</span>
            <span className="grow"><b>{m.attachment.name}</b><br /><small className="muted">from {m.authorName} · {m.clanName} · {when(m.createdAt)} · download it from your conversation while the CLAN is live</small></span>
          </div>
        ))}
      </>}
    </section>
  );
}
