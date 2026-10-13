// Saved: collections as distinct shelves; links + metadata only (nothing is downloaded or copied).
import { useState, type DragEvent } from 'react';
import type { Collection, SavedItem } from '../../shared.ts';
import { api } from '../App.tsx';
import { useLoad, errText } from './useLoad.ts';
import {ContentEditor} from './ContentEditor.tsx';
import { Inbox } from './Inbox.tsx';
import { useAI } from './ai/ctx.tsx';
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
  const ai = useAI();
  const [cols, reloadCols] = useLoad<Collection[]>(api.clan.collections);
  const [items, reloadItems] = useLoad<SavedItem[]>(api.clan.savedItems);
  const [files,reloadFiles]=useLoad(api.clan.personalFiles);
  const [clans] = useLoad(api.clan.list);
  const [url, setUrl] = useState('');
  const [col, setCol] = useState('');
  const [err, setErr] = useState('');
  const [flat, setFlat] = useState(experience === 'minimal');
  const [editing,setEditing]=useState<SavedItem|null>(null),[busy,setBusy]=useState(false),[editingCollection,setEditingCollection]=useState<Collection|null>(null);
  const [over, setOver] = useState<string | null>(null);
  const reload = () => { reloadCols(); reloadItems(); reloadFiles(); };
  const run=async(f:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);setErr('');try{await f();reload();}catch(e){setErr(errText(e));}finally{setBusy(false);}};
  const move = (id: string, to: string) => run(()=>api.clan.moveSaved(id,to));
  const card = (i: SavedItem) => (
    <article key={i.id} className={`saved-card k-${kindOf(i.url)}`} draggable={!flat} onDragStart={(e: DragEvent) => e.dataTransfer.setData('text/clan-saved', i.id)}>
      <div className="saved-thumb"><span aria-hidden>{ICON[kindOf(i.url)]}</span><span className="chip">{i.source}</span></div>
      <a href={i.url} target="_blank" rel="noreferrer noopener" className="saved-title">{i.title}</a>
      {i.note && <p className="muted small-text">{i.note}</p>}
      <button className="link small ai-link left" onClick={() => ai.open({ mode: 'run', title: i.title, action: 'ask', scope: { kind: 'saved', savedId: i.id }, ask: true })}>Ask about this (link and your note only)</button>
      {i.tags.length > 0 && <div className="row tight">{i.tags.map((t) => <span key={t} className="chip">#{t}</span>)}</div>}
      <div className="row tight"><button disabled={busy} aria-label={`Edit saved ${i.title}`} onClick={()=>setEditing(i)}>Edit</button><button disabled={busy} aria-label={`Delete saved ${i.title}`} onClick={()=>{if(confirm(`Delete “${i.title}”? Removes your saved link and its shares on this device and linked devices. The website and independently copied material remain.`))void run(()=>api.clan.removeSaved(i.id));}}>Delete</button>
        <select value={i.collectionId} onChange={async (e) => { const to = e.target.value; await move(i.id, to); }} aria-label="Move to">{cols?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <select value="" onChange={async (e) => { const to = e.target.value; await run(()=>api.clan.shareSaved(i.id,to,true)); }} aria-label="Share to CLAN"><option value="">Share…</option>{clans?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
      </div>
    </article>
  );
  return (
    <div className="stack">
      <header className="page-head">
        <div><span className="eyebrow">Saved</span><h1 className="title world">Your shelves</h1><p className="muted">Links and notes about them — CLAN never downloads the video, post or page itself.</p></div>
        <div className="seg small" role="tablist" aria-label="Layout"><button role="tab" aria-selected={!flat} onClick={() => setFlat(false)}>Board</button><button role="tab" aria-selected={flat} onClick={() => setFlat(true)}>List</button></div>
      </header>
      {editingCollection&&<ContentEditor title="Rename collection" initial={{name:editingCollection.name}} fields={[{key:'name',label:'Collection name',required:true}]} save={async v=>{await api.clan.renameCollection(editingCollection.id,v.name!);reload();}} close={()=>setEditingCollection(null)}/>}
      {editing&&<ContentEditor title={`Edit ${editing.title}`} initial={{title:editing.title,note:editing.note}} fields={[{key:'title',label:'Title'},{key:'note',label:'Note',multiline:true}]} save={async v=>{await api.clan.updateSaved(editing.id,v);reload();}} close={()=>setEditing(null)}/>}
      <details className="card"><summary>Manage personal files</summary><p className="muted">Detach files used by a timetable, course, task or exam there before removal.</p>{files?.map(f=><div className="row" key={f.refId}><b>{f.name}</b><button disabled={busy} aria-label={`Delete file ${f.name}`} onClick={()=>{if(confirm(`Delete “${f.name}”? Removes your personal library reference on linked devices. Independently referenced copies remain.`))void run(()=>api.clan.removePersonalFile(f.refId));}}>Delete file</button></div>)}</details>
      <details className="card"><summary>Manage collections</summary>{cols?.filter(c=>c.kind==='custom').map(c=><div className="row" key={c.id}><b>{c.name}</b><button disabled={busy} onClick={()=>setEditingCollection(c)}>Rename</button><button disabled={busy} onClick={()=>{if(confirm(`Delete collection “${c.name}”? Saved links move to Inbox and remain available.`))void run(()=>api.clan.removeCollection(c.id));}}>Delete collection</button></div>)}</details>
      <Inbox onChanged={() => reload()} />
      <form className="capture-bar" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await api.clan.save({ url }); setUrl(''); reload(); } catch (x) { setErr(errText(x)); } }}>
        <input type="url" placeholder="Paste a link (saved as a link only — nothing is downloaded)" value={url} onChange={(e) => setUrl(e.target.value)} className="grow" aria-label="Link" />
        <button className="primary" disabled={!url}>Save to Inbox</button>
        <input placeholder="New collection" value={col} maxLength={60} onChange={(e) => setCol(e.target.value)} aria-label="New collection name" />
        <button type="button" disabled={!col.trim()} onClick={async () => { await run(async()=>{await api.clan.createCollection(col);setCol('');}); }}>+ Collection</button>
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
