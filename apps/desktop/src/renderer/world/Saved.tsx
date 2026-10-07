// Saved: collections as distinct shelves; links + metadata only (nothing is downloaded or copied).
import { useState, type DragEvent } from 'react';
import type { Collection, SavedItem } from '../../shared.ts';
import { api } from '../App.tsx';
import { useLoad, errText } from './useLoad.ts';
import type { Experience } from './experience.ts';

/** Kind from the link itself (no fetching). */
export const kindOf = (url: string): 'video' | 'image' | 'file' | 'article' => {
  const u = url.toLowerCase();
  if (/youtube\.com|youtu\.be|vimeo\.com|\.mp4($|\?)|instagram\.com\/reel|tiktok\.com/.test(u)) return 'video';
  if (/\.(png|jpe?g|gif|webp|svg)($|\?)/.test(u)) return 'image';
  if (/\.(pdf|docx?|pptx?|xlsx?|zip)($|\?)/.test(u)) return 'file';
  return 'article';
};
const ICON = { video: '▶', image: '◩', file: '▤', article: '¶' } as const;
const tone = (c: Collection) => (c.kind === 'inbox' ? 'inbox' : c.kind === 'watch-later' ? 'later' : 'custom');

export function Saved({ experience }: { experience: Experience }) {
  const [cols, reloadCols] = useLoad<Collection[]>(api.clan.collections);
  const [items, reloadItems] = useLoad<SavedItem[]>(api.clan.savedItems);
  const [clans] = useLoad(api.clan.list);
  const [url, setUrl] = useState('');
  const [col, setCol] = useState('');
  const [err, setErr] = useState('');
  const [flat, setFlat] = useState(experience === 'minimal');
  const [over, setOver] = useState<string | null>(null);
  const reload = () => { reloadCols(); reloadItems(); };
  const move = async (id: string, to: string) => { await api.clan.moveSaved(id, to); reload(); };
  const card = (i: SavedItem) => (
    <article key={i.id} className={`saved-card k-${kindOf(i.url)}`} draggable={!flat} onDragStart={(e: DragEvent) => e.dataTransfer.setData('text/clan-saved', i.id)}>
      <div className="saved-thumb"><span aria-hidden>{ICON[kindOf(i.url)]}</span><span className="chip">{i.source}</span></div>
      <a href={i.url} target="_blank" rel="noreferrer noopener" className="saved-title">{i.title}</a>
      {i.note && <p className="muted small-text">{i.note}</p>}
      {i.tags.length > 0 && <div className="row tight">{i.tags.map((t) => <span key={t} className="chip">#{t}</span>)}</div>}
      <div className="row tight">
        <select value={i.collectionId} onChange={async (e) => { const to = e.target.value; await move(i.id, to); }} aria-label="Move to">{cols?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <select value="" onChange={async (e) => { const to = e.target.value; await api.clan.shareSaved(i.id, to, true); reload(); }} aria-label="Share to CLAN"><option value="">Share…</option>{clans?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      </div>
    </article>
  );
  return (
    <div className="stack">
      <header className="page-head">
        <div><span className="eyebrow">Saved</span><h1 className="title world">Your shelves</h1><p className="muted">Links and notes about them — CLAN never downloads the video, post or page itself.</p></div>
        <div className="seg small" role="tablist" aria-label="Layout"><button role="tab" aria-selected={!flat} onClick={() => setFlat(false)}>Board</button><button role="tab" aria-selected={flat} onClick={() => setFlat(true)}>List</button></div>
      </header>
      <form className="capture-bar" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await api.clan.save({ url }); setUrl(''); reload(); } catch (x) { setErr(errText(x)); } }}>
        <input type="url" placeholder="Paste a link (saved as a link only — nothing is downloaded)" value={url} onChange={(e) => setUrl(e.target.value)} className="grow" aria-label="Link" />
        <button className="primary" disabled={!url}>Save to Inbox</button>
        <input placeholder="New collection" value={col} maxLength={60} onChange={(e) => setCol(e.target.value)} aria-label="New collection name" />
        <button type="button" disabled={!col.trim()} onClick={async () => { await api.clan.createCollection(col); setCol(''); reload(); }}>+ Collection</button>
        {err && <span className="error">{err}</span>}
      </form>
      {flat ? (
        <div className="saved-list">{items?.length ? items.map(card) : <div className="empty-place"><b>Nothing saved yet.</b><span className="muted">Paste a link above, or use Quick Capture.</span></div>}</div>
      ) : (
        <div className="saved-cols">
          {cols?.map((c) => (
            <section key={c.id} className={`saved-col tone-${tone(c)} ${over === c.id ? 'over' : ''}`} aria-label={c.name}
              onDragOver={(e) => { e.preventDefault(); setOver(c.id); }} onDragLeave={() => setOver(null)}
              onDrop={(e) => { e.preventDefault(); setOver(null); const id = e.dataTransfer.getData('text/clan-saved'); if (id) void move(id, c.id); }}>
              <header><b>{c.name}</b><span className="c-num muted">{c.count}</span></header>
              {items?.filter((i) => i.collectionId === c.id).map(card)}
              {c.count === 0 && <p className="muted small-text shelf-empty">{c.kind === 'inbox' ? 'New captures land here.' : 'Drag links here.'}</p>}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
