// Me: who you are in CLAN, how the world looks, privacy — and the Diary, which has its own calm, private space.
import { useEffect, useState } from 'react';
import { CLANmate, mateFor } from '@clan/design';
import type { DiaryEntry, HomeView } from '../../shared.ts';
import { api } from '../App.tsx';
import { useLoad } from './useLoad.ts';
import { experienceIsAuto, setExperience, type Experience } from './experience.ts';

const MOODS = ['calm', 'happy', 'proud', 'tired', 'anxious', 'low'];
const today = () => new Date().toLocaleDateString('en-CA');

export function Me({ experience, section }: { experience: Experience; section: 'profile' | 'diary' }) {
  const [h, reloadHome] = useLoad<HomeView>(api.clan.home);
  const [privacy, reloadPrivacy] = useLoad(api.clan.privacy);
  const [name, setName] = useState('');
  const [auto, setAuto] = useState(experienceIsAuto());
  useEffect(() => { if (h) setName(h.me.name); }, [h]);
  return (
    <div className="me-grid">
      <section className="card stack me-card">
        {h && <div className="me-mate"><CLANmate spec={mateFor(h.me.name)} size={150} label="Your CLANmate" /></div>}
        <span className="eyebrow">You</span>
        <form className="row" onSubmit={async (e) => { e.preventDefault(); await api.clan.rename(name); reloadHome(); }}><input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label="Your name" /><button>Save name</button></form>
        <p className="muted small-text">Your CLANmate’s look is generated for now; choosing your own arrives with Profiles.</p>
        <fieldset className="experience"><legend className="eyebrow">Visual experience</legend>
          {(['full', 'reduced', 'minimal'] as const).map((e) => (
            <label key={e} className="radio"><input type="radio" name="exp" checked={!auto && experience === e} onChange={() => { setExperience(e); setAuto(false); }} />
              <span><b>{e === 'full' ? 'Full' : e === 'reduced' ? 'Reduced' : 'Minimal'}</b> <small className="muted">{e === 'full' ? '3D places and motion' : e === 'reduced' ? '2D places, gentle motion' : 'fast panels, no motion'}</small></span></label>
          ))}
          <label className="radio"><input type="radio" name="exp" checked={auto} onChange={() => { setExperience('auto'); setAuto(true); }} /><span><b>Automatic</b> <small className="muted">now {experience}</small></span></label>
        </fieldset>
        <Notices />
        <span className="eyebrow">Privacy</span>
        <label className="check"><input type="checkbox" checked={!!privacy?.aiDiary} onChange={async (e) => { await api.clan.setAiDiary(e.target.checked); reloadPrivacy(); }} /> Let AI read my Diary</label>
        <p className="muted small-text">Off by default. Notes and links are private until you share them into a CLAN. Your Diary is never shared and never searchable.</p>
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
