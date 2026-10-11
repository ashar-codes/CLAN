// QR file transfer on the computer: show a file as a stream of QR codes, or film another screen to receive one. No
// network of any kind is involved. Public streams can be read by anyone who can see the screen; private ones are
// encrypted to the receiver's one-time receive code. Delivery is confirmed only by scanning the receiver's receipt.
import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { keyFingerprint, QRX_RECOMMENDED_BYTES, QrxReceiver, receiveCode, type QrxOffer } from '@classroom/protocol';
import { api } from '../../App.tsx';
import { errText, mb } from './common.tsx';

/** Camera (or a picture) → QR texts. Starts only while mounted, after the main process armed the camera. */
export function QrCamera({ onCode, continuous = false, label = 'Camera preview for scanning' }: { onCode(text: string): boolean | void; continuous?: boolean; label?: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState('');
  const cb = useRef(onCode); cb.current = onCode;
  useEffect(() => {
    let stream: MediaStream | null = null, stop = false, last = '', lastAt = 0;
    void api.people.armMedia('camera').then(() => navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false })).then((s) => {
      stream = s; const v = video.current; if (!v) return;
      v.srcObject = s; void v.play();
      const c = document.createElement('canvas'), ctx = c.getContext('2d', { willReadFrequently: true })!;
      const loop = () => {
        if (stop || !video.current) return;
        const vw = v.videoWidth, vh = v.videoHeight;
        if (vw) {
          const scale = Math.min(1, 900 / Math.max(vw, vh)); c.width = Math.round(vw * scale); c.height = Math.round(vh * scale);
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const r = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height, { inversionAttempts: 'dontInvert' });
          const now = Date.now();
          if (r?.data && (r.data !== last || now - lastAt > (continuous ? 150 : 1500))) { last = r.data; lastAt = now; if (cb.current(r.data) === true) { stop = true; return; } }
        }
        requestAnimationFrame(loop);
      };
      loop();
    }, () => setErr('Camera permission was denied or no camera is available. Choose a picture of the code instead.'));
    return () => { stop = true; stream?.getTracks().forEach((t) => t.stop()); };
  }, [continuous]);
  const fromPicture = (f: File | undefined) => {
    if (!f) return;
    const im = new Image();
    im.onload = () => { const c = document.createElement('canvas'); c.width = im.width; c.height = im.height; const ctx = c.getContext('2d')!; ctx.drawImage(im, 0, 0); const r = jsQR(ctx.getImageData(0, 0, c.width, c.height).data, c.width, c.height); if (r?.data) cb.current(r.data); else setErr('No code found in that picture.'); URL.revokeObjectURL(im.src); };
    im.src = URL.createObjectURL(f);
  };
  return (
    <div className="stack">
      <video ref={video} muted playsInline width={360} aria-label={label} className="qr-video" />
      <label className="button small">Scan a picture instead<input type="file" accept="image/*" hidden onChange={(e) => fromPicture(e.target.files?.[0])} /></label>
      {err && <p role="alert" className="error">{err}</p>}
    </div>
  );
}

export function OpticalTransfer({ onClose }: { onClose(): void }) {
  const [mode, setMode] = useState<'choose' | 'send' | 'receive'>('choose');
  return (
    <section className="card stack" aria-label="QR file transfer">
      <div className="row between"><b>QR file transfer</b><button className="small" onClick={onClose}>Close</button></div>
      {mode === 'choose' && <>
        <p className="muted small-text">No internet, Wi-Fi or Bluetooth needed: one screen shows changing codes and the other device films them. Best for notes, documents and small pictures; above {QRX_RECOMMENDED_BYTES / 1024} KB a direct connection is much faster.</p>
        <div className="row"><button className="primary" onClick={() => setMode('send')}>Send a file</button><button onClick={() => setMode('receive')}>Receive a file</button></div>
      </>}
      {mode === 'send' && <OpticalSend onDone={() => setMode('choose')} />}
      {mode === 'receive' && <OpticalReceive onDone={() => setMode('choose')} />}
    </section>
  );
}

function OpticalSend({ onDone }: { onDone(): void }) {
  const [step, setStep] = useState<'who' | 'scanKey' | 'show' | 'ack'>('who');
  const [tx, setTx] = useState<{ id: string; name: string; size: number; mode: string; minFrames: number; to: string | null } | null>(null);
  const [img, setImg] = useState(''), [i, setI] = useState(0), [fps, setFps] = useState(6), [paused, setPaused] = useState(false);
  const [err, setErr] = useState(''), [receipt, setReceipt] = useState('');
  const frames = useRef<{ from: number; list: string[] }>({ from: 0, list: [] });
  useEffect(() => () => { if (tx) void api.people.opticalStop(tx.id); }, [tx]);
  const start = (code: string | null) => void api.people.opticalStart(code).then((t) => { if (t) { setTx(t); setI(0); frames.current = { from: 0, list: [] }; setStep('show'); } }, (e) => setErr(errText(e)));
  // advance frames at the chosen speed; fetch them from the main process in batches
  useEffect(() => {
    if (step !== 'show' || !tx || paused) return;
    const t = setInterval(() => setI((x) => x + 1), 1000 / fps);
    return () => clearInterval(t);
  }, [step, tx, paused, fps]);
  useEffect(() => {
    if (!tx || step !== 'show') return;
    let gone = false;
    void (async () => {
      const f = frames.current;
      if (i < f.from || i >= f.from + f.list.length) { const list = await api.people.opticalFrames(tx.id, i, 60); if (gone) return; frames.current = { from: i, list }; }
      const text = frames.current.list[i - frames.current.from]!;
      const url = await QRCode.toDataURL(text, { errorCorrectionLevel: 'L', margin: 4, width: 420 });
      if (!gone) setImg(url);
    })().catch((e) => setErr(errText(e)));
    return () => { gone = true; };
  }, [i, tx, step]);
  if (step === 'who') return (
    <div className="stack">
      <button className="primary" onClick={() => setStep('scanKey')}>Only one person (private)…</button>
      <p className="muted small-text">Scan the receive code on their screen first. Only that device can open the file; anyone else filming sees encrypted data.</p>
      <button onClick={() => start(null)}>Anyone who scans (public)…</button>
      <p className="muted small-text">Public: anyone who can see or film this screen can read the file.</p>
      {err && <p role="alert" className="error">{err}</p>}
      <button className="small" onClick={onDone}>Cancel</button>
    </div>
  );
  if (step === 'scanKey') return (
    <div className="stack" aria-label="Scan their receive code">
      <p>Point the camera at their receive code (QR transfer › Receive a file › Receive privately).</p>
      <QrCamera onCode={(t) => { if (!t.startsWith('clan://qrx/key')) { setErr('That is not a CLAN receive code.'); return; } setErr(''); start(t); return true; }} />
      {err && <p role="alert" className="error">{err}</p>}
      <button className="small" onClick={() => setStep('who')}>Back</button>
    </div>
  );
  if (step === 'ack' && tx) return (
    <div className="stack" aria-label="Scan their receipt">
      <QrCamera onCode={(t) => { void api.people.opticalReceipt(tx.id, t).then((r) => { if (!r) return setErr('That receipt does not match this file.'); setReceipt(`Received intact by ${r.name ?? `CLAN identity ${r.fingerprint}`}.`); setPaused(true); setStep('show'); }); return true; }} />
      {err && <p role="alert" className="error">{err}</p>}
      <button className="small" onClick={() => setStep('show')}>Back</button>
    </div>
  );
  if (!tx) return null;
  const shown = i + 1;
  return (
    <div className="stack" aria-label={`Sending ${tx.name}`}>
      <b>{tx.name} · {mb(tx.size)}</b>
      {img && <img src={img} alt={`Transfer frame ${shown}`} width={420} height={420} className="qr-frame" data-frame={i} />}
      <p className="muted small-text">{tx.mode === 'private' ? `Private${tx.to ? `, for ${tx.to}` : ''}.` : 'Public: anyone who can see this screen can read the file.'} Frame {shown} · about {tx.minFrames} needed{shown > tx.minFrames ? ' (keep going until the other device says done)' : ''}.</p>
      <progress max={tx.minFrames} value={Math.min(shown, tx.minFrames)} aria-label="Frames shown" />
      <div className="row" role="group" aria-label="Speed">{[2, 4, 6, 8, 10].map((f) => <button key={f} className="small" aria-pressed={fps === f} onClick={() => setFps(f)}>{f}/s</button>)}</div>
      <div className="row"><button onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button><button onClick={() => setStep('ack')}>Scan their receipt</button><button className="danger" onClick={onDone}>Stop</button></div>
      {receipt ? <p role="status" className="ok">✓ {receipt}</p> : <p className="muted small-text">A QR stream cannot tell you it arrived. Ask them to show their receipt and scan it.</p>}
    </div>
  );
}

function OpticalReceive({ onDone }: { onDone(): void }) {
  const code = useRef<ReturnType<typeof receiveCode> | null>(null), rx = useRef<QrxReceiver | null>(null);
  const [priv, setPriv] = useState<boolean | null>(null), [codeImg, setCodeImg] = useState('');
  const [offer, setOffer] = useState<QrxOffer | null>(null), [accepted, setAccepted] = useState(false), [prog, setProg] = useState({ solved: 0, total: 1 });
  const [done, setDone] = useState<{ bytes: Uint8Array; name: string; mime: string; sha256: string; from: string | null } | null>(null);
  const [err, setErr] = useState(''), [msg, setMsg] = useState(''), [ackImg, setAckImg] = useState(''), [fromName, setFromName] = useState('');
  const begin = (p: boolean) => {
    if (p) { code.current = receiveCode(); void QRCode.toDataURL(code.current.text, { margin: 4, width: 300 }).then(setCodeImg); }
    rx.current = new QrxReceiver(p ? { receive: code.current! } : {}); setPriv(p);
  };
  useEffect(() => { const k = done?.from ?? offer?.from; if (k) void api.people.contact(k).then((c) => setFromName(c ? `From ${c.name}${c.verified ? ' (verified)' : ''}` : `From an unknown CLAN identity ${keyFingerprint(k)}`)); }, [offer?.from, done?.from]);
  const onFrame = (t: string) => {
    const r = rx.current; if (!r) return;
    const res = r.push(t);
    if (res === 'meta') setOffer(r.offer);
    if ((res === 'progress' || res === 'done') && r.progress) setProg({ solved: r.progress.solved, total: r.progress.total });
    if (res === 'done') { try { setDone(r.result()); } catch (e) { setErr(errText(e)); } return true; }
  };
  if (priv === null) return (
    <div className="stack">
      <button className="primary" onClick={() => begin(true)}>Receive privately</button>
      <p className="muted small-text">Shows a one-time receive code; the sender scans it first so only this computer can open the file.</p>
      <button onClick={() => begin(false)}>Receive a public transfer</button>
      <button className="small" onClick={onDone}>Cancel</button>
    </div>
  );
  if (done) return (
    <div className="stack" aria-label="Received file">
      <b>{done.name} · {mb(done.bytes.length)}</b>
      <p className="muted">{done.from ? fromName : 'Sender not identified'}. Length and SHA-256 match exactly.</p>
      <div className="row">
        <button className="primary" onClick={() => void api.people.opticalInbox(done.bytes, done.name, done.mime).then(() => setMsg('Saved to your Inbox.'), (e) => setErr(errText(e)))}>Save to Inbox</button>
        <button onClick={() => void api.people.opticalSave(done.bytes, done.name).then((r) => r && setMsg(`Saved as ${r.name}.`), (e) => setErr(errText(e)))}>Save a copy…</button>
        <button onClick={() => void api.people.opticalAck(offer!.id, done.sha256).then((t) => QRCode.toDataURL(t, { margin: 4, width: 300 })).then(setAckImg, (e) => setErr(errText(e)))}>Show receipt</button>
      </div>
      {msg && <p role="status">{msg}</p>}
      {ackImg && <figure><img src={ackImg} alt="Receipt code for the sender" width={300} height={300} /><figcaption className="muted small-text">The sender scans this to confirm the file arrived intact. It shows your CLAN identity.</figcaption></figure>}
      {err && <p role="alert" className="error">{err}</p>}
      <button className="small" onClick={onDone}>Done</button>
    </div>
  );
  return (
    <div className="stack" aria-label={priv ? 'Receive privately' : 'Receive a public transfer'}>
      {priv && !offer && codeImg && <figure><img src={codeImg} alt="Your one-time receive code" width={300} height={300} /><figcaption className="muted small-text">Let the sender scan this, then point the camera at their screen.</figcaption></figure>}
      {offer && !accepted && (
        <div className="card inset" role="group" aria-label="Incoming transfer">
          <b>{offer.name ?? 'Encrypted file'}{offer.size !== null ? ` · ${mb(offer.size)}` : ''}</b>
          <p className="muted small-text">{offer.from ? fromName : 'Sender not identified'} · {offer.mode === 'private' ? (offer.forMe ? 'private, for this computer' : 'private, for someone else') : 'public'}</p>
          {offer.forMe ? <div className="row"><button className="primary" onClick={() => { try { rx.current!.accept(); setAccepted(true); } catch (e) { setErr(errText(e)); } }}>Accept</button><button onClick={onDone}>Decline</button></div> : <p className="muted">This transfer is not for your receive code.</p>}
        </div>
      )}
      {accepted && <><p role="status">Receiving… {prog.solved} of {prog.total} parts</p><progress max={prog.total} value={prog.solved} aria-label="Received parts" /></>}
      <QrCamera continuous onCode={onFrame} label="Camera pointed at the other screen" />
      {err && <p role="alert" className="error">{err}</p>}
      <button className="small" onClick={onDone}>Cancel</button>
    </div>
  );
}
