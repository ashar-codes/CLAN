// Production shell: Home / CLANs / Study / Saved / Me. Works without 3D; every number on screen comes from the device
// database through window.classroom.clan. Empty states say what is missing instead of showing fixtures.
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { CLANBeacon, SavedCard } from '@clan/design';
import type { ClanDetail, ClanType, Collection, DiaryEntry, HomeView, Note, SavedItem, SearchHit } from '../shared.ts';
import { api } from './App.tsx';

type Tab = 'home' | 'clans' | 'study' | 'saved' | 'me';
const TABS: [Tab, string][] = [['home', 'Home'], ['clans', 'CLANs'], ['study', 'Study'], ['saved', 'Saved'], ['me', 'Me']];
const TYPE_LABEL: Record<ClanType, string> = { CLASSROOM: 'Classroom', STUDY_GROUP: 'Study group', PROJECT_TEAM: 'Project team', FRIENDS: 'Friends', TEMPORARY: 'Temporary' };
const errText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const ago = (ts: number) => { const m = Math.round((Date.now() - ts) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : new Date(ts).toLocaleDateString(); };
const today = () => new Date().toLocaleDateString('en-CA');

function useLoad<T>(f: () => Promise<T>) {
  const [v, setV] = useState<T | null>(null);
  const [err, setErr] = useState('');
  const reload = useCallback(() => { f().then(setV, (e) => setErr(errText(e))); }, [f]);
  useEffect(reload, [reload]);
  return [v, reload, err] as const;
}

export function Shell({ onCreate, onJoin }: { onCreate(type?: ClanType): void; onJoin(): void }) {
  const [tab, setTab] = useState<Tab>('home');
  return (
    <div className="shell">
      <header className="shell-top">
        <span className="brand-sm">CLAN</span>
        <nav className="tabs-main" aria-label="Main">
          {TABS.map(([t, l]) => <button key={t} className={tab === t ? 'on' : ''} aria-current={tab === t ? 'page' : undefined} onClick={() => setTab(t)}>{l}</button>)}
        </nav>
      </header>
      <main className="shell-body">
        {tab === 'home' && <Home go={setTab} onCreate={onCreate} onJoin={onJoin} />}
        {tab === 'clans' && <Clans onCreate={onCreate} onJoin={onJoin} />}
        {tab === 'study' && <Study />}
        {tab === 'saved' && <Saved />}
        {tab === 'me' && <Me />}
      </main>
    </div>
  );
}

function Home({ go, onCreate, onJoin }: { go(t: Tab): void; onCreate(type?: ClanType): void; onJoin(): void }) {
  const [h] = useLoad<HomeView>(api.clan.home);
  const [nearby, setNearby] = useState<{ sid: string; title: string; type: string }[]>([]);
  const [guide, setGuide] = useState(false);
  useEffect(() => api.discover((l) => setNearby(l)), []);
  if (!h) return null;
  return (
    <div className="home-grid">
      <section className="card span2 today">
        <span className="eyebrow">Today · {new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</span>
        <h1 className="title">Hi {h.me.name}</h1>
        <div className="row">
          <button className="primary" onClick={() => go('study')}>New note</button>
          <button onClick={() => go('saved')}>Save a link</button>
          <button onClick={() => onCreate('STUDY_GROUP')}>New CLAN</button>
          <button className="choice-inline" onClick={() => onCreate('CLASSROOM')}>Create Classroom</button>
          <button className="choice-inline" onClick={onJoin}>Join Classroom</button>
        </div>
      </section>
      <section className="card"><span className="eyebrow">Nearby CLANs</span>
        <NearbyList list={nearby} onJoin={onJoin} />
      </section>
      <section className="card"><span className="eyebrow">Continue studying</span>
        {h.continueNotes.length ? h.continueNotes.map((n) => <button key={n.id} className="line link-row" onClick={() => go('study')}>{n.title}<span className="muted">{ago(n.updatedAt)}</span></button>)
          : <p className="muted">Notes you write show up here.</p>}
      </section>
      <section className="card"><span className="eyebrow">Upcoming exams</span><p className="muted">No exams yet. Exam planning arrives with the Exams module.</p></section>
      <section className="card"><span className="eyebrow">Deadlines</span>
        {h.deadlines.length ? h.deadlines.map((r) => <div key={r.id} className="line">{r.text}<span className={r.dueAt < Date.now() ? 'error' : 'muted'}>{new Date(r.dueAt).toLocaleDateString()}</span></div>)
          : <p className="muted">Nothing due in the next two weeks.</p>}
      </section>
      <section className="card"><span className="eyebrow">Saved for later</span>
        {h.inbox.length ? h.inbox.map((s) => <a key={s.id} className="line" href={s.url} target="_blank" rel="noreferrer noopener">{s.title}<span className="muted">{s.source}</span></a>)
          : <p className="muted">Your Inbox is empty.</p>}
        <button className="small" onClick={() => go('saved')}>Open Saved</button>
      </section>
      <section className="card"><span className="eyebrow">Your CLANs</span>
        {h.clans.length ? h.clans.slice(0, 5).map((c) => <div key={c.id} className="line">{c.name}<span className="muted">{TYPE_LABEL[c.type]} · {c.members}</span></div>)
          : <p className="muted">Create a CLAN or join a classroom to start one.</p>}
      </section>
      <section className="card"><span className="eyebrow">Recent activity</span>
        {h.activity.length ? h.activity.map((a, i) => <div key={i} className="line">{a.label}<span className="muted">{ago(a.ts)}</span></div>) : <p className="muted">Nothing yet.</p>}
      </section>
      <section className="card guide-entry">
        <button className="guide-dots" aria-expanded={guide} onClick={() => setGuide(!guide)}><i /><i /><i /> <span>Guide</span></button>
        {guide && <p className="muted">No AI provider is set up on this device. When one is, it will see only what the screen you are on shows; your Diary stays off unless you turn it on in Me → Privacy.</p>}
      </section>
    </div>
  );
}

/** Active CLAN sessions advertised on this network. Names come from untrusted discovery; the code + OPAQUE decide. */
function NearbyList({ list, onJoin }: { list: { sid: string; title: string; type: string }[]; onJoin(): void }) {
  if (!list.length) return <p className="muted">No CLAN sessions on this network right now.</p>;
  return <>{list.map((n) => <div key={n.sid} className="line"><span><CLANBeacon state="available" size={16} /> {n.title} <span className="muted">· {TYPE_LABEL[n.type as ClanType] ?? 'CLAN'}</span></span><button className="small" onClick={onJoin}>Join</button></div>)}</>;
}

function Clans({ onCreate, onJoin }: { onCreate(type?: ClanType): void; onJoin(): void }) {
  const [list] = useLoad(api.clan.list);
  const [open, setOpen] = useState<string | null>(null);
  const [nearby, setNearby] = useState<{ sid: string; title: string; type: string }[]>([]);
  useEffect(() => api.discover((l) => setNearby(l)), []);
  if (open) return <ClanView id={open} onBack={() => setOpen(null)} />;
  return (
    <div className="stack">
      <div className="row between"><h1 className="title">CLANs</h1>
        <div className="row"><button className="primary" onClick={() => onCreate('STUDY_GROUP')}>Create CLAN</button><button onClick={onJoin}>Join by Code</button></div></div>
      <div className="row">{(['CLASSROOM', 'STUDY_GROUP', 'PROJECT_TEAM', 'FRIENDS', 'TEMPORARY'] as const).map((t) => <button key={t} className="small" onClick={() => onCreate(t)}>+ {TYPE_LABEL[t]}</button>)}</div>
      <section><span className="eyebrow">My CLANs</span>
        <div className="clan-grid">
          {list?.map((c) => <button key={c.id} className="card clan-card" onClick={() => setOpen(c.id)}><span className="eyebrow">{TYPE_LABEL[c.type]}</span><b>{c.name}</b>{c.expiresAt && <span className="muted">until {new Date(c.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}</button>)}
          {list?.length === 0 && <p className="muted">No CLANs yet. Create one or join with a code.</p>}
        </div>
      </section>
      <section className="card"><span className="eyebrow">Nearby CLANs</span><NearbyList list={nearby} onJoin={onJoin} /></section>
    </div>
  );
}

function ClanView({ id, onBack }: { id: string; onBack(): void }) {
  const [d] = useLoad<ClanDetail>(useCallback(() => api.clan.detail(id), [id]));
  if (!d) return null;
  return (
    <div className="stack">
      <button className="link back" onClick={onBack}>← CLANs</button>
      <span className="eyebrow">{TYPE_LABEL[d.clan.type]}{d.sessions ? ` · ${d.sessions} class session${d.sessions === 1 ? '' : 's'}` : ''}</span>
      <h1 className="title">{d.clan.name}</h1>
      <div className="clan-grid">
        <section className="card"><span className="eyebrow">Members ({d.members.length})</span>{d.members.map((m) => <div key={m.userId} className="line">{m.name}<span className="muted">{m.role}</span></div>)}</section>
        <section className="card"><span className="eyebrow">Files</span>{d.files.length ? d.files.map((f) => <div key={f.refId} className="line">{f.name}<span className="muted">{(f.size / 1e6).toFixed(1)} MB</span></div>) : <p className="muted">No files.</p>}</section>
        <section className="card"><span className="eyebrow">Shared notes</span>{d.notes.length ? d.notes.map((n) => <div key={n.id} className="line">{n.title}<span className="muted">{n.mine ? 'yours' : ''}</span></div>) : <p className="muted">Share a note from Study.</p>}</section>
        <section className="card"><span className="eyebrow">Shared links</span>{d.saved.length ? d.saved.map((s) => <a key={s.id} className="line" href={s.url} target="_blank" rel="noreferrer noopener">{s.title}</a>) : <p className="muted">Share a link from Saved.</p>}</section>
      </div>
    </div>
  );
}

function Study() {
  const [notes, reload] = useLoad(api.clan.notes);
  const [clans] = useLoad(api.clan.list);
  const [sel, setSel] = useState<Note | null>(null);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [draft, setDraft] = useState({ title: '', body: '' });
  useEffect(() => { if (sel) setDraft({ title: sel.title, body: sel.body }); }, [sel]);
  const create = async () => { const n = await api.clan.createNote({ title: 'Untitled' }); reload(); setSel(n); };
  const save = async () => { if (sel) { setSel(await api.clan.updateNote(sel.id, draft)); reload(); } };
  return (
    <div className="study-grid">
      <aside className="stack">
        <form onSubmit={async (e) => { e.preventDefault(); setHits(q.trim() ? await api.clan.search(q) : null); }}><input type="search" placeholder="Search notes and saved" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" /></form>
        {hits && <div className="card">{hits.length ? hits.map((h) => <div key={h.module + h.entityId} className="line"><span>{h.title}<br /><small className="muted">{h.snippet}</small></span><span className="muted">{h.module}</span></div>) : <p className="muted">No results.</p>}</div>}
        <button className="primary" onClick={create}>New note</button>
        {notes?.map((n) => <button key={n.id} className={`line link-row ${sel?.id === n.id ? 'on' : ''}`} onClick={() => setSel(n)}>{n.title}<span className="muted">{n.sharedWith.length ? 'shared' : 'private'}</span></button>)}
      </aside>
      {sel ? (
        <section className="card stack">
          <input className="note-title" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} aria-label="Title" />
          <textarea className="note-body" value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label="Note" />
          <div className="row">
            <button className="primary" onClick={save}>Save</button>
            <select value="" onChange={async (e) => { const clanId = e.target.value; await api.clan.shareNote(sel.id, clanId, true); reload(); setSel({ ...sel, sharedWith: [...sel.sharedWith, clanId] }); }} aria-label="Share to CLAN">
              <option value="">Share to CLAN…</option>{clans?.filter((c) => !sel.sharedWith.includes(c.id)).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button onClick={() => api.clan.remind({ text: `Review “${sel.title}”`, dueAt: Date.now() + 86_400_000, target: { module: 'notes', id: sel.id } })}>Remind me tomorrow</button>
            <button className="danger" onClick={async () => { await api.clan.removeNote(sel.id); setSel(null); reload(); }}>Delete</button>
          </div>
          {sel.sharedWith.length > 0 && <p className="muted small-text">Shared with {sel.sharedWith.map((c) => clans?.find((x) => x.id === c)?.name ?? 'a CLAN').join(', ')}. Members see your latest version.</p>}
        </section>
      ) : <p className="muted pad">Pick a note or start a new one. Notes are private until you share them.</p>}
    </div>
  );
}

function Saved() {
  const [cols, reloadCols] = useLoad<Collection[]>(api.clan.collections);
  const [items, reloadItems] = useLoad<SavedItem[]>(api.clan.savedItems);
  const [clans] = useLoad(api.clan.list);
  const [url, setUrl] = useState('');
  const [col, setCol] = useState('');
  const [err, setErr] = useState('');
  const reload = () => { reloadCols(); reloadItems(); };
  return (
    <div className="stack">
      <form className="row" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { await api.clan.save({ url }); setUrl(''); reload(); } catch (x) { setErr(errText(x)); } }}>
        <input type="url" placeholder="Paste a link (saved as a link only — nothing is downloaded)" value={url} onChange={(e) => setUrl(e.target.value)} className="grow" aria-label="Link" />
        <button className="primary" disabled={!url}>Save to Inbox</button>
        <input placeholder="New collection" value={col} maxLength={60} onChange={(e) => setCol(e.target.value)} aria-label="New collection name" />
        <button type="button" disabled={!col.trim()} onClick={async () => { await api.clan.createCollection(col); setCol(''); reload(); }}>+ Collection</button>
        {err && <span className="error">{err}</span>}
      </form>
      <div className="saved-cols">
        {cols?.map((c) => (
          <section key={c.id} className="saved-col"><header><b>{c.name}</b><span className="muted">{c.count}</span></header>
            {items?.filter((i) => i.collectionId === c.id).map((i) => (
              <div key={i.id} className="stack tight">
                <SavedCard title={i.title} source={i.source} url={i.url} note={i.note} tags={i.tags} />
                <div className="row">
                  <select value={i.collectionId} onChange={async (e) => { const to = e.target.value; await api.clan.moveSaved(i.id, to); reload(); }} aria-label="Move to">{cols.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                  <select value="" onChange={async (e) => { const to = e.target.value; await api.clan.shareSaved(i.id, to, true); reload(); }} aria-label="Share to CLAN"><option value="">Share…</option>{clans?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
                </div>
              </div>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}

const MOODS = ['calm', 'happy', 'proud', 'tired', 'anxious', 'low'];
function Me() {
  const [h, reloadHome] = useLoad<HomeView>(api.clan.home);
  const [privacy, reloadPrivacy] = useLoad(api.clan.privacy);
  const [entry, setEntry] = useState<{ body: string; mood: string | null }>({ body: '', mood: null });
  const [recent, reloadRecent] = useLoad<DiaryEntry[]>(api.clan.diaryRecent);
  const [saved, setSaved] = useState(false);
  const [name, setName] = useState('');
  useEffect(() => { api.clan.diaryDay(today()).then((e) => e && setEntry({ body: e.body, mood: e.mood })); }, []);
  useEffect(() => { if (h) setName(h.me.name); }, [h]);
  return (
    <div className="me-grid">
      <section className="card stack">
        <span className="eyebrow">You</span>
        <form className="row" onSubmit={async (e) => { e.preventDefault(); await api.clan.rename(name); reloadHome(); }}><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Your name" /><button>Save name</button></form>
        <span className="eyebrow">Privacy</span>
        <label className="check"><input type="checkbox" checked={!!privacy?.aiDiary} onChange={async (e) => { await api.clan.setAiDiary(e.target.checked); reloadPrivacy(); }} /> Let AI read my Diary</label>
        <p className="muted small-text">Off by default. Notes and links are private until you share them into a CLAN. Your Diary is never shared and never searchable.</p>
      </section>
      <section className="card stack diary">
        <span className="eyebrow">Diary · private to this device</span>
        <h2>{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
        <div className="row" role="radiogroup" aria-label="Mood">{MOODS.map((m) => <button key={m} role="radio" aria-checked={entry.mood === m} className={entry.mood === m ? 'on small' : 'small'} onClick={() => setEntry({ ...entry, mood: m })}>{m}</button>)}</div>
        <textarea className="note-body" placeholder="How was today?" value={entry.body} onChange={(e) => { setEntry({ ...entry, body: e.target.value }); setSaved(false); }} aria-label="Diary entry" />
        <div className="row"><button className="primary" onClick={async () => { await api.clan.writeDiary({ day: today(), ...entry }); setSaved(true); reloadRecent(); }}>Save entry</button>{saved && <span className="muted">Saved</span>}</div>
        {recent?.filter((e) => e.day !== today()).map((e) => <div key={e.id}><span className="eyebrow">{e.day}{e.mood ? ` · ${e.mood}` : ''}</span><p>{e.body}</p></div>)}
      </section>
    </div>
  );
}
