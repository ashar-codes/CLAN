// Me: who you are in CLAN, how the world looks, privacy — and the Diary, which has its own calm, private space.
import { lazy, Suspense, useEffect, useState } from 'react';
import { CLANmate, mateFor } from '@clan/design';
import type { DiaryEntry, HomeView } from '../../shared.ts';
import { api } from '../App.tsx';
import { errText, useLoad } from './useLoad.ts';
import { experienceIsAuto, setExperience, type Experience } from './experience.ts';
import { AvatarEditor, useAvatar } from './avatar';

const AISettingsPanel = lazy(() => import('./ai/Settings.tsx'));
const DevicesPanel = lazy(() => import('./devices/Devices.tsx'));

const MOODS = ['calm', 'happy', 'proud', 'tired', 'anxious', 'low'];
const today = () => new Date().toLocaleDateString('en-CA');

export function Me({ experience, section }: { experience: Experience; section: 'profile' | 'diary' }) {
  const [h, reloadHome] = useLoad<HomeView>(api.clan.home);
  const [name, setName] = useState('');
  const [auto, setAuto] = useState(experienceIsAuto());
  const [avatar, setAvatar] = useAvatar(h?.me.name ?? 'Me');
  useEffect(() => { if (h) setName(h.me.name); }, [h]);
  return (
    <div className={`me-grid${section === 'diary' ? ' diary-active' : ''}`}>
      <section className="card stack me-card">
        {h && <div className="me-mate"><CLANmate spec={avatar} size={150} label="Your CLANmate" /></div>}
        <span className="eyebrow">You</span>
        <form className="row" onSubmit={async (e) => { e.preventDefault(); await api.clan.rename(name); reloadHome(); }}><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Your name" /><button>Save name</button></form>
        <AvatarEditor spec={avatar} onChange={setAvatar} />
        <fieldset className="experience"><legend className="eyebrow">Visual experience</legend>
          {(['full', 'reduced', 'minimal'] as const).map((e) => (
            <label key={e} className="radio"><input type="radio" name="exp" checked={!auto && experience === e} onChange={() => { setExperience(e); setAuto(false); }} />
              <span><b>{e === 'full' ? 'Full' : e === 'reduced' ? 'Reduced' : 'Minimal'}</b> <small className="muted">{e === 'full' ? '3D places and motion' : e === 'reduced' ? '2D places, gentle motion' : 'fast panels, no motion'}</small></span></label>
          ))}
          <label className="radio"><input type="radio" name="exp" checked={auto} onChange={() => { setExperience('auto'); setAuto(true); }} /><span><b>Automatic</b> <small className="muted">now {experience}</small></span></label>
        </fieldset>
        <Notices />
        <Suspense fallback={null}><DevicesPanel /></Suspense>
        <Suspense fallback={null}><AISettingsPanel /></Suspense>
        <YourData />
        <BetaFeedback />
        <span className="eyebrow">Privacy</span>
        <p className="muted small-text">AI reading your Diary is off by default (see AI above). Notes and links are private until you share them into a CLAN. Your Diary is never shared and never searchable.</p>
      </section>
      <Diary focus={section === 'diary'} />
    </div>
  );
}

function Diary({ focus }: { focus: boolean }) {
  const [entry, setEntry] = useState<{ body: string; mood: string | null }>({ body: '', mood: null });
  const [recent, reloadRecent] = useLoad<DiaryEntry[]>(api.clan.diaryRecent);
  const [saved, setSaved] = useState(false);
  useEffect(() => { api.clan.diaryDay(today()).then((e) => e && setEntry({ body: e.body, mood: e.mood })); }, []);
  return (
    <section className="diary-book" aria-label="Diary">
      <p className="diary-lock">Private · stays on this device · never shared{' '}·{' '}never read by AI unless you allow it</p>
      <h2 className="diary-date">{new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })}</h2>
      <div className="row" role="radiogroup" aria-label="Mood">{MOODS.map((m) => <button key={m} role="radio" aria-checked={entry.mood === m} className={`mood ${entry.mood === m ? 'on' : ''}`} onClick={() => setEntry({ ...entry, mood: m })}>{m}</button>)}</div>
      <textarea className="diary-text" autoFocus={focus} placeholder="How was today?" value={entry.body} onChange={(e) => { setEntry({ ...entry, body: e.target.value }); setSaved(false); }} aria-label="Diary entry" />
      <div className="row"><button className="primary" onClick={async () => { await api.clan.writeDiary({ day: today(), ...entry }); setSaved(true); reloadRecent(); }}>Save entry</button>{saved && <span className="muted">Saved</span>}</div>
      <div className="diary-past">{recent?.filter((e) => e.day !== today()).map((e) => <article key={e.id}><span className="eyebrow">{e.day}{e.mood ? ` · ${e.mood}` : ''}</span><p>{e.body}</p></article>)}</div>
    </section>
  );
}

/** Which conversations may notify you, and whether notices may show message text (off: only who and where). */
function Notices() {
  const [p, reload] = useLoad(api.notify.prefs);
  if (!p) return null;
  const set = async (k: keyof typeof p, v: boolean) => { await api.notify.setPrefs({ [k]: v }); reload(); };
  return (
    <fieldset className="experience"><legend className="eyebrow">Notifications</legend>
      <label className="check"><input type="checkbox" checked={p.direct} onChange={(e) => void set('direct', e.target.checked)} /> Direct messages</label>
      <label className="check"><input type="checkbox" checked={p.files} onChange={(e) => void set('files', e.target.checked)} /> Files sent to me</label>
      <label className="check"><input type="checkbox" checked={p.groups} onChange={(e) => void set('groups', e.target.checked)} /> CLAN group conversations</label>
      <label className="check"><input type="checkbox" checked={p.previews} onChange={(e) => void set('previews', e.target.checked)} /> Show message text in notifications</label>
      <small className="muted">Focus mode holds every alert. Nothing notifies you about a conversation you have open.</small>
    </fieldset>
  );
}

/** Your data: export to a folder you choose (Diary only if ticked), import an export, open automatic backups. */
function YourData() {
  const [diary, setDiary] = useState(false), [msg, setMsg] = useState('');
  const run = async (f: () => Promise<string>) => { try { setMsg(await f()); } catch (e) { setMsg(errText(e)); } };
  return (
    <section className="stack" aria-label="Your data">
      <span className="eyebrow">Your data</span>
      <p className="muted small-text">Automatic backups of everything on this computer are kept (newest three). Export makes a copy you can keep or move.</p>
      <label className="radio"><input type="checkbox" checked={diary} onChange={(e) => setDiary(e.target.checked)} /><span>Include my Diary in the export</span></label>
      <div className="row">
        <button onClick={() => void run(async () => { const r = await api.data.export({ diary }); return r ? `Exported ${r.records} items and ${r.files} files${r.diary ? ', including your Diary' : ''}.` : ''; })}>Export my data…</button>
        <button className="ghost" onClick={() => void run(async () => { const r = await api.data.import(); return r ? `Imported ${r.records} items and ${r.files} files.` : ''; })}>Import an export…</button>
        <button className="ghost" onClick={() => void run(async () => { await api.data.backupNow(); return 'Backed up.'; })}>Back up now</button>
        <button className="ghost" onClick={() => void api.data.backups()}>Show backups</button>
      </div>
      {msg && <p className="muted small-text" role="status">{msg}</p>}
    </section>
  );
}

/** Beta feedback: written here, saved as a file you send yourself. Diagnostics (versions, counts, error kinds) only if ticked. */
function BetaFeedback() {
  const [kind, setKind] = useState<'problem' | 'idea' | 'other'>('problem'), [text, setText] = useState(''), [diag, setDiag] = useState(false);
  const [preview, setPreview] = useState<string | null>(null), [msg, setMsg] = useState('');
  return (
    <section className="stack" aria-label="Beta feedback">
      <span className="eyebrow">Beta feedback</span>
      <div className="row" role="radiogroup" aria-label="Feedback kind">
        {(['problem', 'idea', 'other'] as const).map((k) => <label key={k} className="radio"><input type="radio" name="fb-kind" checked={kind === k} onChange={() => setKind(k)} /><span>{k === 'problem' ? 'Something went wrong' : k === 'idea' ? 'An idea' : 'Other'}</span></label>)}
      </div>
      <textarea value={text} onChange={(e) => setText(e.target.value)} maxLength={10000} rows={4} aria-label="Your feedback" placeholder="What happened, or what would help?" />
      <label className="radio"><input type="checkbox" checked={diag} onChange={(e) => { setDiag(e.target.checked); if (!e.target.checked) setPreview(null); }} /><span>Attach diagnostics <small className="muted">versions, platform, item counts and error types — never your notes, Diary, chats, files, names or keys</small></span></label>
      {diag && <button className="ghost" onClick={async () => setPreview(JSON.stringify(await api.feedback.preview(), null, 2))}>Show exactly what's attached</button>}
      {preview && <pre className="small-text" aria-label="Diagnostics preview" style={{ maxHeight: 200, overflow: 'auto' }}>{preview}</pre>}
      <button disabled={!text.trim()} onClick={async () => { try { const r = await api.feedback.save({ kind, text, diagnostics: diag }); if (r) { setMsg(`Saved to ${r.path}. Send that file to the CLAN team yourself — nothing is uploaded.`); setText(''); } } catch (e) { setMsg(errText(e)); } }}>Save feedback…</button>
      {msg && <p className="muted small-text" role="status">{msg}</p>}
    </section>
  );
}
