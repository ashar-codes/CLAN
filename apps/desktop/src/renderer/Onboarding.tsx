// First run: who you are (name + this device's name), an optional picture and ID number, and who can find you nearby.
// Identity keys already exist; this only names them. Everything stays on this computer until you connect to someone.
import { useState } from 'react';
import { api } from './App.tsx';

type Vis = 'everyone' | 'friends' | 'invisible';
const VIS: [Vis, string, string][] = [
  ['everyone', 'Everyone nearby (recommended)', 'People on the same network can find you and send a friend or chat request.'],
  ['friends', 'Friends only', 'Only people you have added as friends can find you.'],
  ['invisible', 'Invisible', 'Nobody can find you nearby; you can still connect by code.']];

export function Onboarding({ onDone }: { onDone(): void }) {
  const [name, setName] = useState(''), [device, setDevice] = useState(''), [roll, setRoll] = useState(''), [vis, setVis] = useState<Vis>('everyone');
  const [pic, setPic] = useState(false), [err, setErr] = useState(''), [busy, setBusy] = useState(false);
  const save = async () => {
    const fullName = name.trim().replace(/\s+/g, ' '), deviceName = device.trim();
    if (!fullName) return setErr('Enter your full name.');
    if (!deviceName) return setErr('Name this computer, e.g. “My laptop”.');
    setBusy(true); setErr('');
    try {
      await api.saveProfile({ fullName, rollNo: roll.trim(), deviceName });
      await api.people.visibility(vis);
      onDone();
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <main className="onboarding card stack" style={{ maxWidth: 560, margin: '6vh auto' }} aria-labelledby="ob-title">
      <h1 id="ob-title" className="title world">Welcome to CLAN</h1>
      <p className="muted">Create your profile. Your name is how friends and CLAN hosts see you; it is shared only with people and CLANs you connect to.</p>
      <label>Full name<input autoFocus value={name} maxLength={80} placeholder="Your full name" onChange={(e) => setName(e.target.value)} /></label>
      <label>Device name<input value={device} maxLength={60} placeholder="e.g. My laptop" onChange={(e) => setDevice(e.target.value)} /></label>
      <label>Student / ID number <span className="muted">(optional — only if your class asks for it)</span><input value={roll} maxLength={40} onChange={(e) => setRoll(e.target.value)} /></label>
      <div className="row"><button type="button" onClick={() => void api.people.pickAvatar().then((a) => setPic(!!a), (e) => setErr((e as Error).message))}>{pic ? 'Picture added ✓ (change)' : 'Add your profile picture (optional)'}</button></div>
      <fieldset className="stack"><legend><b>Who can find you nearby?</b></legend>
        {VIS.map(([v, label, help]) => <label key={v} className="row"><input type="radio" name="vis" checked={vis === v} onChange={() => setVis(v)} /><span><b>{label}</b><br /><small className="muted">{help}</small></span></label>)}
        <small className="muted">Nearby people see only your name and picture (plus profile fields you mark for everyone). Change this any time in People. People you block can't contact you, but in Everyone Nearby anyone on this network can see you — choose Friends Only or Invisible to hide.</small>
      </fieldset>
      {err && <p role="alert" className="error">{err}</p>}
      <button className="primary" disabled={busy} onClick={() => void save()}>Continue</button>
    </main>
  );
}
