// Nearby › People: people on this network who chose to be visible (never invented), this device's own profile and
// visibility, its QR code, and scanning someone else's code (camera or picture) to connect with a verified identity.
import { useEffect, useRef, useState } from 'react';
import jsQR from 'jsqr';
import type { NearbyPersonView, PeopleContact } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { errText, Avatar, Initials, REL, usePeople } from './common.tsx';
import { ChatInvite } from './Chats.tsx';
import { Radar } from '../Radar.tsx';
import { OpticalTransfer } from './Optical.tsx';

export function NearbyPeople({ onChat }: { onChat(convId: string): void }) {
  const [directoryText, setDirectoryText] = useState(''), [directoryStatus, setDirectoryStatus] = useState('');
  const directory = () => api.people.directory().then((r) => setDirectoryStatus(r.status));
  useEffect(() => { void directory(); }, []);
  const [alerts, setAlerts] = useState(false);
  useEffect(() => { void api.people.nearbyAlerts().then(setAlerts); }, []);
  const [list] = usePeople(() => api.people.nearby());
  const [me, reloadMe] = usePeople(() => api.people.me());
  const [msg, setMsg] = useState(''), [err, setErr] = useState('');
  const [connected, setConnected] = useState<string | null>(null);
  const [optical, setOptical] = useState(false);
  const [cc] = usePeople(() => connected ? api.people.contact(connected) : Promise.resolve(null), [connected]);
  useEffect(() => { const t = setInterval(() => void api.people.nearby().then(() => {}), 5000); return () => clearInterval(t); }, []);
  const act = (f: () => Promise<unknown>, done: string) => { setErr(''); void f().then(() => setMsg(done), (e) => setErr(errText(e))); };
  const vis = me?.profile.visibility;
  return (
    <section className="stack" aria-label="Nearby people">
      <div className="card stack" aria-label="Your visibility">
        <div className="row between"><b>You are {vis === 'everyone' ? 'visible to everyone nearby' : vis === 'friends' ? 'visible to friends only' : 'invisible'}</b>
          {vis === 'everyone' && me?.profile.everyoneUntil && <span className="muted">until {new Date(me.profile.everyoneUntil).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>}</div>
        <div className="row" role="radiogroup" aria-label="Who can find you">
          <button aria-pressed={vis === 'everyone'} onClick={() => act(() => api.people.visibility('everyone', 3_600_000).then(reloadMe), 'Visible to everyone on this network for 1 hour.')}>Everyone nearby (1 h)</button>
          <button aria-pressed={vis === 'friends'} onClick={() => act(() => api.people.visibility('friends').then(reloadMe), 'Only friends can find you.')}>Friends only</button>
          <button aria-pressed={vis === 'invisible'} onClick={() => act(() => api.people.visibility('invisible').then(reloadMe), 'You are invisible. Discovery is off.')}>Invisible</button>
        </div>
        <p className="muted small-text">Everyone Nearby shows only the fields you mark “everyone”, on the local network (and an explicitly configured internal directory), and switches back to Friends Only by itself. Avoid it on public or shared networks. Your location is never shown.</p>
      </div>
      <button aria-pressed={alerts} onClick={() => void api.people.nearbyAlerts(!alerts).then(setAlerts)}>Friend nearby alerts: {alerts ? 'On' : 'Off'}</button>
      {msg && <p role="status">{msg}</p>}{err && <p role="alert" className="error">{err}</p>}
      <div className="card stack" aria-label="Internal network directory"><b>Optional administrator LAN directory</b><p className="muted small-text">Paste the administrator’s public HTTPS configuration only after checking its certificate pin. Enabling sends your device public key and listening addresses to that trusted administrator; discovery returns rotating hints, never private chats or files. Invisible stops People advertisements. No network scanning or gateway forwarding.</p><textarea aria-label="LAN directory configuration" maxLength={20000} value={directoryText} onChange={(e) => setDirectoryText(e.target.value)} /><div className="row"><button onClick={() => act(() => Promise.resolve().then(() => api.people.directory(JSON.parse(directoryText))).then(directory), 'Internal directory enabled.')}>Enable internal directory</button><button onClick={() => act(() => api.people.directory(null).then(directory), 'Directory disabled; registration expires within 90 seconds.')}>Disable directory</button><button onClick={() => void directory()}>Check directory status</button></div><p role="status">{directoryStatus}</p><small>Your enrollment public key: {me?.key}</small><p className="muted small-text">Different routers work only when internal routing and firewall policy permit the connection. If discovery is unavailable, use a trusted profile QR. Ask the network administrator about isolated VLANs.</p></div>
      <Radar items={(list ?? []).map((n) => ({ id: n.key, name: n.name, kind: `Person · ${n.network ?? 'Nearby'} · ${n.connection ?? 'nearby'}`, verified: n.verified && n.relation === 'friend' }))} onSelect={(key) => document.getElementById(`person-${key}`)?.scrollIntoView({ block: 'center' })} />
      <p className="muted small-text">Positions are a visual layout, not physical distances. Select a person to view their verified profile and connection actions.</p>
      <div role="list" aria-label="People nearby" className="people-list">
        {!list?.length && <p className="muted" role="status">Nobody nearby is visible to you right now. People appear here only while they choose to be visible.</p>}
        {list?.map((n) => <NearbyCard key={n.key} n={n} onChat={onChat} onError={setErr} />)}
      </div>
      {cc && !list?.some((n) => n.key === cc.key) && <div role="list" aria-label="Connected by code" className="people-list">
        <NearbyCard n={{ key: cc.key, name: cc.name, profile: cc.profile ?? { key: cc.key, name: cc.name, avatar: null, updatedAt: 0 }, endpoint: '', relation: cc.relation, seenAt: cc.lastSeen, verified: cc.verified }} onChat={onChat} onError={setErr} /></div>}
      <QrCard onConnected={(c) => { setConnected(c.key); setMsg(`Connected to ${c.name}. Their identity matched the code.`); }} onError={setErr} onOptical={() => setOptical(true)} />
      {optical ? <OpticalTransfer onClose={() => setOptical(false)} /> : <button onClick={() => setOptical(true)}>QR file transfer (no network needed)…</button>}
    </section>
  );
}

function NearbyCard({ n, onChat, onError }: { n: NearbyPersonView; onChat(id: string): void; onError(e: string): void }) {
  const p = n.profile, rel = n.relation;
  const run = (f: () => Promise<unknown>) => void f().catch((e) => onError(errText(e)));
  return (
    <article id={`person-${n.key}`} role="listitem" className="card person" aria-label={n.name}>
      <div className="row"><Avatar k={n.key} name={n.name} /><div><b>{n.name}</b>{n.verified && <span className="chip" title="Identity checked by QR code"> ✓ verified</span>}
        <br /><small className="muted">{[p.university, p.department, p.course].filter(Boolean).join(' · ') || 'CLAN user'}{REL[rel] ? ` · ${REL[rel]}` : ''}</small></div></div>
      <p className="muted small-text">{n.network ?? 'Nearby'} · {n.connection === 'connected' ? 'Connected (authenticated session)' : n.connection === 'reconnecting' ? 'Reconnecting' : n.connection === 'offline' || n.connection === 'failed' ? 'Offline — queued items remain pending' : 'Nearby — no persistent connection confirmed'}</p>
      {p.bio && <p className="small-text">{p.bio}</p>}
      {p.interests?.length ? <p className="muted small-text">Interests: {p.interests.join(', ')}</p> : null}
      <div className="row">
        {rel === 'none' && <button onClick={() => run(() => api.people.friend('request', n.key))}>Add friend</button>}
        {rel === 'incoming' && <button className="primary" onClick={() => run(() => api.people.friend('accept', n.key))}>Accept friend</button>}
        <ChatInvite peerKey={n.key} onChat={onChat} onError={onError} />
      </div>
    </article>
  );
}

/** Your code and a scanner. A scanned code must match the identity and certificate the person presents. */
function QrCard({ onConnected, onError, onOptical }: { onConnected(c: PeopleContact): void; onError(e: string): void; onOptical(): void }) {
  const [img, setImg] = useState<string | null>(null), [text, setText] = useState(''), [scanning, setScanning] = useState(false);
  const [intent, setIntent] = useState<'profile' | 'friend' | 'chat'>('profile');
  useEffect(() => { if (img) void api.people.qrImage(intent).then(setImg, () => {}); }, [intent]); // eslint-disable-line react-hooks/exhaustive-deps
  const video = useRef<HTMLVideoElement>(null);
  const connect = (code: string) => {
    if (code.startsWith('CLQ1') || code.startsWith('clan://qrx/')) return onOptical(); // a QR transfer: open the receiver
    void api.people.connectQr(code).then(onConnected, (e) => onError(errText(e)));
  };
  const decode = (data: ImageData) => jsQR(data.data, data.width, data.height)?.data ?? null;
  useEffect(() => {
    if (!scanning) return;
    let stream: MediaStream | null = null, stop = false;
    void api.people.armMedia('camera').then(() => navigator.mediaDevices.getUserMedia({ video: true, audio: false })).then((s) => {
      stream = s; if (!video.current) return; video.current.srcObject = s; void video.current.play();
      const c = document.createElement('canvas'), ctx = c.getContext('2d')!;
      const loop = () => {
        if (stop || !video.current) return;
        const v = video.current; c.width = v.videoWidth; c.height = v.videoHeight;
        if (c.width) { ctx.drawImage(v, 0, 0); const code = decode(ctx.getImageData(0, 0, c.width, c.height)); if (code) { setScanning(false); connect(code); return; } }
        requestAnimationFrame(loop);
      };
      loop();
    }, () => { onError('Camera permission was denied or no camera is available. Paste the code or choose a picture of it instead.'); setScanning(false); });
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [scanning]); // eslint-disable-line react-hooks/exhaustive-deps
  const fromPicture = (f: File | undefined) => {
    if (!f) return;
    const im = new Image(); im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const ctx = c.getContext('2d')!; ctx.drawImage(im, 0, 0); const code = decode(ctx.getImageData(0, 0, c.width, c.height)); if (code) connect(code); else onError('No CLAN code found in that picture.'); URL.revokeObjectURL(im.src); };
    im.src = URL.createObjectURL(f);
  };
  return (
    <div className="card stack" aria-label="QR code">
      <b>Connect with a code</b>
      <div className="row">
        <button onClick={() => void api.people.qrImage(intent).then(setImg, (e) => onError(errText(e)))}>Show my code</button>
        <button onClick={() => setScanning(!scanning)}>{scanning ? 'Stop camera' : 'Scan with camera'}</button>
        <label className="button">Scan a picture<input type="file" accept="image/*" hidden onChange={(e) => fromPicture(e.target.files?.[0])} /></label>
      </div>
      {img && <div className="row" role="radiogroup" aria-label="What the code offers">{(['profile', 'friend', 'chat'] as const).map((x) => <button key={x} className="small" aria-pressed={intent === x} onClick={() => setIntent(x)}>{x === 'profile' ? 'My profile' : x === 'friend' ? 'Friend request' : 'Chat invitation'}</button>)}</div>}
      {img && <figure><img src={img} alt="Your CLAN profile code" width={220} height={220} /><figcaption className="muted small-text">Whoever scans this can find you on this network, even in Friends Only mode. <button className="link" onClick={() => void api.people.resetQr().then(() => api.people.qrImage().then(setImg))}>Make a new code</button> to stop old copies working.</figcaption></figure>}
      {scanning && <video ref={video} muted playsInline width={260} aria-label="Camera preview for scanning" />}
      <div className="row"><input aria-label="Paste a CLAN code" placeholder="clan://p/…" value={text} onChange={(e) => setText(e.target.value)} /><button disabled={!text.trim()} onClick={() => connect(text.trim())}>Connect</button></div>
    </div>
  );
}
