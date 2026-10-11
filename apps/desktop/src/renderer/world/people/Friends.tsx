// Friends: your profile (what each field shows, to whom), friends, requests in and out, blocked people, and one
// person's profile with the safety number you can compare in person to confirm it is really them.
import { useEffect, useState } from 'react';
import type { PeopleContact } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { useCall } from './Call.tsx';
import { ChatInvite } from './Chats.tsx';
import { ago, errText, Avatar, Initials, REL, usePeople } from './common.tsx';

const FIELDS = [['university', 'University'], ['department', 'Department'], ['course', 'Course'], ['interests', 'Interests'], ['bio', 'About you']] as const;
const WHO = { everyone: 'Everyone nearby', friends: 'Friends', nobody: 'Only me' } as const;

export function Friends({ onChat }: { onChat(convId: string): void }) {
  const [friends] = usePeople(() => api.people.contacts('friends'));
  const [requests] = usePeople(() => api.people.contacts('requests'));
  const [blocked] = usePeople(() => api.people.contacts('blocked'));
  const [offers] = usePeople(() => api.people.deviceOffers());
  const [sel, setSel] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const incoming = requests?.filter((r) => r.relation === 'incoming') ?? [], outgoing = requests?.filter((r) => r.relation === 'outgoing') ?? [];
  const run = (f: () => Promise<unknown>) => { setErr(''); void f().catch((e) => setErr(errText(e))); };
  const row = (c: PeopleContact, actions: React.ReactNode) => (
    <li key={c.key} className="row between person-row">
      <button className="link row" onClick={() => setSel(c.key)} aria-label={`Open ${c.name}`}><Avatar k={c.key} name={c.name} /><span><b>{c.name}</b>{c.verified && <span className="chip"> ✓</span>}<br /><small className="muted">{REL[c.relation] || (c.blocked ? 'Blocked' : '')}{c.lastSeen ? ` · seen ${ago(c.lastSeen)}` : ''}</small></span></button>
      <span className="row">{actions}</span>
    </li>
  );
  return (
    <div className="stack">
      <header className="page-head"><div><span className="eyebrow">Friends</span><h1 className="title world">Your people</h1>
        <p className="muted">Friendships belong to a person’s verified device identity — never a name or an address — and stay on your devices.</p></div></header>
      {err && <p role="alert" className="error">{err}</p>}
      <div className="people-cols">
        <div className="stack">
          {!!offers?.length && <section className="card stack" aria-label="Friends' other devices"><b>Your friends’ other devices</b>
            {offers.map((o) => <div key={`${o.fromKey}:${o.key}`} className="stack person-row">
              <span><b>{o.name}</b> — {o.fromName} says this device is also theirs.</span>
              <small className="muted">Safety number for that device: <span className="mono">{o.safety}</span>. If you can, compare it on their device first.</small>
              <div className="row"><button className="primary small" onClick={() => run(() => api.people.deviceOffer('accept', o.fromKey, o.key))}>Trust as {o.fromName}</button><button className="small" onClick={() => run(() => api.people.deviceOffer('decline', o.fromKey, o.key))}>Not now</button></div>
            </div>)}</section>}
          {incoming.length > 0 && <section className="card" aria-label="Friend requests"><b>Requests for you</b><ul className="people-list">{incoming.map((c) => row(c, <>
            <button className="primary small" onClick={() => run(() => api.people.friend('accept', c.key))}>Accept</button>
            <button className="small" onClick={() => run(() => api.people.friend('reject', c.key))}>Decline</button></>))}</ul></section>}
          <section className="card" aria-label="Friends list"><b>Friends ({friends?.length ?? 0})</b>
            {!friends?.length ? <p className="muted">No friends yet. Find people in Nearby or scan their code.</p> :
              <ul className="people-list">{friends.map((c) => row(c, <ChatInvite peerKey={c.key} onChat={onChat} onError={setErr} label="Chat" />))}</ul>}</section>
          {outgoing.length > 0 && <section className="card" aria-label="Sent requests"><b>Sent requests</b><ul className="people-list">{outgoing.map((c) => row(c,
            <button className="small" onClick={() => run(() => api.people.friend('cancel', c.key))}>Cancel request</button>))}</ul></section>}
          {!!blocked?.length && <section className="card" aria-label="Blocked people"><b>Blocked</b><ul className="people-list">{blocked.map((c) => row(c,
            <button className="small" onClick={() => run(() => api.people.friend('unblock', c.key))}>Unblock</button>))}</ul></section>}
        </div>
        <div className="stack">{sel ? <PersonCard k={sel} onChat={onChat} onClose={() => setSel(null)} onError={setErr} /> : <ProfileEditor />}</div>
      </div>
    </div>
  );
}

function PersonCard({ k, onChat, onClose, onError }: { k: string; onChat(id: string): void; onClose(): void; onError(e: string): void }) {
  const [c] = usePeople(() => api.people.contact(k), [k]);
  const { call, active } = useCall();
  const [confirm, setConfirm] = useState<'remove' | 'block' | null>(null);
  const run = (f: () => Promise<unknown>) => void f().catch((e) => onError(errText(e)));
  if (!c) return null;
  const p = c.profile;
  return (
    <section className="card stack" aria-label={`Profile of ${c.name}`}>
      <div className="row between"><div className="row"><Avatar k={c.key} name={c.name} size={52} /><div><h2 className="title">{c.name}</h2>
        <small className="muted">{REL[c.relation] || (c.blocked ? 'Blocked' : 'Not connected')}{c.verified ? ' · identity verified' : ' · not verified yet'}</small></div></div>
        <button className="small" onClick={onClose}>Close</button></div>
      {p ? <dl className="profile-dl">{FIELDS.map(([f, l]) => { const v = p[f as keyof typeof p]; return v && (Array.isArray(v) ? v.length : true) ? <div key={f}><dt>{l}</dt><dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd></div> : null; })}</dl>
        : <p className="muted">They have not shared any profile details with you.</p>}
      <div className="card inset">
        <b>Safety number</b>
        <p className="mono">{c.safetyNumber}</p>
        <p className="muted small-text">Compare this with the number on their screen, in person. If they match, nobody is pretending to be them.{c.verified ? ' You already verified this person (by code or by comparing).' : ''}</p>
        {!c.verified && <button onClick={() => run(() => api.people.friend('verify', c.key))}>The numbers match</button>}
      </div>
      <div className="row">
        {c.relation === 'none' && !c.blocked && <button onClick={() => run(() => api.people.friend('request', c.key))}>Add friend</button>}
        {c.relation === 'incoming' && <button className="primary" onClick={() => run(() => api.people.friend('accept', c.key))}>Accept friend</button>}
        {!c.blocked && <ChatInvite peerKey={c.key} onChat={onChat} onError={onError} label="Chat" />}
        {c.relation === 'friend' && !c.blocked && <button disabled={active} onClick={() => call(c.key, c.name)}>Call</button>}
        {c.relation === 'friend' && <button onClick={() => setConfirm('remove')}>Remove friend</button>}
        {c.blocked ? <button onClick={() => run(() => api.people.friend('unblock', c.key))}>Unblock</button> : <button className="danger" onClick={() => setConfirm('block')}>Block</button>}
      </div>
      {confirm && <div className="card inset" role="alertdialog" aria-label="Confirm">
        <p>{confirm === 'remove' ? `Remove ${c.name} as a friend? They are told, and your chats stay unless you remove them.` : `Block ${c.name}? They can no longer find you, message you, call you or send you files. They are not told.`}</p>
        <div className="row"><button className="danger" onClick={() => { setConfirm(null); run(() => api.people.friend(confirm, c.key)); }}>{confirm === 'remove' ? 'Remove' : 'Block'}</button><button onClick={() => setConfirm(null)}>Cancel</button></div>
      </div>}
    </section>
  );
}

function ProfileEditor() {
  const [me, reload] = usePeople(() => api.people.me());
  const [pic, setPic] = useState<string | null>(null);
  const [form, setForm] = useState<Record<string, string>>({}), [vis, setVis] = useState<Record<string, keyof typeof WHO>>({});
  const [msg, setMsg] = useState(''), [err, setErr] = useState('');
  useEffect(() => { void api.people.avatar('me').then(setPic, () => {}); }, [me?.profile.avatar?.sha256]);
  useEffect(() => {
    if (!me) return;
    const f = me.profile.fields as Record<string, unknown>;
    setForm({ name: me.profile.name, ...Object.fromEntries(FIELDS.map(([k]) => [k, Array.isArray(f[k]) ? (f[k] as string[]).join(', ') : String(f[k] ?? '')])) });
    setVis(me.profile.fieldVisibility as Record<string, keyof typeof WHO>);
  }, [me]);
  if (!me) return null;
  const save = () => {
    setErr(''); setMsg('');
    const out: Record<string, unknown> = { name: form.name, fieldVisibility: vis };
    for (const [k] of FIELDS) out[k] = k === 'interests' ? (form[k] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : form[k] ?? '';
    void api.people.update(out).then(() => { setMsg('Profile saved.'); reload(); }, (e) => setErr(errText(e)));
  };
  return (
    <section className="card stack" aria-label="Your profile">
      <div className="row"><span className="avatar-pick">{pic ? <img src={pic} alt="Your picture" width={52} height={52} className="person-avatar" /> : <Initials name={me.profile.name} size={52} />}</span>
        <div><b>Your profile</b><br /><small className="muted">Device identity {me.fingerprint}</small></div>
        <button className="small" onClick={() => void api.people.pickAvatar().then(() => reload(), (e) => setErr(errText(e)))}>Change picture</button></div>
      <label>Name<input value={form.name ?? ''} maxLength={80} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
      {FIELDS.map(([k, l]) => (
        <div key={k} className="row field-vis">
          <label className="grow">{l}{k === 'bio' ? <textarea maxLength={500} value={form[k] ?? ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
            : <input value={form[k] ?? ''} placeholder={k === 'interests' ? 'Separate with commas' : ''} onChange={(e) => setForm({ ...form, [k]: e.target.value })} />}</label>
          <label>Shown to<select value={vis[k] ?? 'friends'} onChange={(e) => setVis({ ...vis, [k]: e.target.value as keyof typeof WHO })}>{Object.entries(WHO).map(([v, t]) => <option key={v} value={v}>{t}</option>)}</select></label>
        </div>
      ))}
      <p className="muted small-text">Your name is shown to anyone you contact. Your picture stays on this device for now.</p>
      <div className="row"><button className="primary" onClick={save}>Save profile</button>{msg && <span role="status">{msg}</span>}{err && <span role="alert" className="error">{err}</span>}</div>
    </section>
  );
}
