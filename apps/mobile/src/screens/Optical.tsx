// Optical transfer on the phone: send a small file as a stream of QR codes, or receive one with the camera — with no
// internet, Wi-Fi or Bluetooth at all. Public transfers can be read by anyone who can see the screen (said plainly);
// private transfers are encrypted to the receiver's one-time receive code. A receipt is a QR the receiver shows back.
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { ackCode, encodeTransfer, keyFingerprint, parseReceiveCode, QRX_MAX_BYTES, QRX_RECOMMENDED_BYTES, QrxReceiver, receiveCode, verifyAck, type QrxOffer } from '@classroom/protocol';
import { phoneClan, me } from '../core/clan';
import { deviceSigner } from '../storage';
import { bump, Btn, Card, Err, H1, Muted, Row, Screen, useC } from '../ui/kit';
import { QrImage, QrScanner } from '../ui/qr';

const mb = (n: number) => (n < 1e6 ? `${Math.max(1, Math.round(n / 1e3))} KB` : `${(n / 1e6).toFixed(1)} MB`);
const who = (key: string | null) => { if (!key) return 'Sender not identified'; const c = phoneClan().people.contact(key); return c ? `From ${c.name}${c.verified ? ' (verified)' : ''}` : `From an unknown CLAN identity ${keyFingerprint(key)}`; };
const signer = async () => { const s = await deviceSigner(); return { publicKey: s.publicKey, sign: (b: Uint8Array) => s.sign(b) as string }; };

export function OpticalScreen({ onBack }: { onBack(): void }) {
  const [mode, setMode] = useState<'choose' | 'send' | 'receive'>('choose');
  return (
    <Screen>
      <Row><Btn small label="← Back" onPress={onBack} /><H1>QR transfer</H1></Row>
      {mode === 'choose' && <>
        <Card title="Share a file by QR codes">
          <Muted>Works with no internet, Wi-Fi or Bluetooth: one phone shows changing codes, the other films them. Best for notes, documents and small pictures (up to {QRX_MAX_BYTES / 1024 / 1024} MB; above {QRX_RECOMMENDED_BYTES / 1024} KB a direct connection is much faster).</Muted>
          <Row><Btn primary label="Send a file" onPress={() => setMode('send')} /><Btn label="Receive a file" onPress={() => setMode('receive')} /></Row>
        </Card>
      </>}
      {mode === 'send' && <Sender onDone={() => setMode('choose')} />}
      {mode === 'receive' && <Receiver onDone={() => setMode('choose')} />}
    </Screen>
  );
}

function Sender({ onDone }: { onDone(): void }) {
  const c = useC();
  const [file, setFile] = useState<{ bytes: Uint8Array; name: string; mime: string } | null>(null);
  const [to, setTo] = useState<{ publicKey: string; fingerprint: string; name: string } | null>(null);
  const [step, setStep] = useState<'pick' | 'who' | 'scanKey' | 'show' | 'ack'>('pick');
  const [tx, setTx] = useState<ReturnType<typeof encodeTransfer> | null>(null);
  const [i, setI] = useState(0), [fps, setFps] = useState(5), [paused, setPaused] = useState(false);
  const [err, setErr] = useState<string | null>(null), [receipt, setReceipt] = useState<string | null>(null);
  useEffect(() => { if (step !== 'show' || paused || !tx) return; const t = setInterval(() => setI((x) => x + 1), 1000 / fps); return () => clearInterval(t); }, [step, paused, fps, tx]);
  const pick = async () => {
    setErr(null);
    const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }); const a = !r.canceled && r.assets[0];
    if (!a) return;
    const f = new File(a.uri), size = f.size ?? 0;
    if (size > QRX_MAX_BYTES) return setErr(`That file is ${mb(size)}. QR transfer is limited to ${mb(QRX_MAX_BYTES)} — use a direct connection instead.`);
    setFile({ bytes: f.bytesSync(), name: a.name, mime: a.mimeType ?? 'application/octet-stream' }); setStep('who');
  };
  const start = async (recipient: typeof to) => {
    if (!file) return;
    try { setTx(encodeTransfer(file, { blockSize: file.bytes.length > 64_000 ? 600 : 400, to: recipient ?? undefined, signer: await signer() })); setI(0); setStep('show'); }
    catch (e) { setErr((e as Error).message); }
  };
  if (step === 'pick') return <Card title="Send a file"><Btn primary label="Choose a file" onPress={() => void pick()} /><Err msg={err} /><Btn small label="Cancel" onPress={onDone} /></Card>;
  if (step === 'who') return (
    <Card title={`${file!.name} · ${mb(file!.bytes.length)}`}>
      {file!.bytes.length > QRX_RECOMMENDED_BYTES && <Text style={{ color: c.warn }}>This will take a while by QR (about {Math.ceil(file!.bytes.length / 600 / 5 / 60)} min). A direct connection is faster if one is available.</Text>}
      <Btn primary label="Only one person (private)" onPress={() => setStep('scanKey')} />
      <Muted small>Private: first scan the receive code on their screen. Only that phone can open the file; others who film the screen see only encrypted data.</Muted>
      <Btn label="Anyone who scans (public)" onPress={() => void start(null)} />
      <Muted small>Public: anyone who can see or film your screen can read this file.</Muted>
      <Err msg={err} />
    </Card>
  );
  if (step === 'scanKey') return (
    <Card title="Scan their receive code">
      <QrScanner hint="On the other phone: QR transfer › Receive a file › Receive privately." onClose={() => setStep('who')} onCode={(t) => { const k = parseReceiveCode(t); if (!k) { setErr('That is not a CLAN receive code.'); return; } setTo(k); void start(k); return true; }} />
      <Err msg={err} />
    </Card>
  );
  if (step === 'ack') return (
    <Card title="Scan their receipt">
      <QrScanner onClose={() => setStep('show')} onCode={(t) => { const r = verifyAck(t, { id: tx!.id, sha256: tx!.info.sha256 }); if (!r) { setErr('That receipt does not match this file.'); return; } const p = phoneClan().people.contact(r.key); setReceipt(`Received intact by ${p ? p.name : `CLAN identity ${keyFingerprint(r.key)}`}.`); setStep('show'); setPaused(true); return true; }} />
      <Err msg={err} />
    </Card>
  );
  const shown = i + 1, need = tx!.minFrames;
  return (
    <Card title={`Sending ${file!.name}`}>
      <QrImage text={tx!.frame(i)} size={300} label={`Transfer frame ${shown}`} />
      <Muted>{tx!.meta.mode === 'private' ? `Private, for ${to?.name || 'the receive code you scanned'}.` : 'Public: anyone who can see this screen can read the file.'} Frame {shown} · about {need} needed{shown > need ? ' (keep going until the other phone says done)' : ''}.</Muted>
      <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: need, now: Math.min(shown, need) }} style={{ height: 6, backgroundColor: c.border, borderRadius: 3 }}><View style={{ width: `${Math.min(100, (shown / need) * 100)}%`, height: 6, backgroundColor: c.accent, borderRadius: 3 }} /></View>
      <Row gap={6}>{[2, 4, 6, 8].map((f) => <Btn key={f} small label={`${f}/s`} on={fps === f} onPress={() => setFps(f)} />)}</Row>
      <Row><Btn small label={paused ? 'Resume' : 'Pause'} onPress={() => setPaused(!paused)} /><Btn small label="Scan their receipt" onPress={() => setStep('ack')} /><Btn small danger label="Stop" onPress={onDone} /></Row>
      {receipt && <Text accessibilityLiveRegion="polite" style={{ color: c.ok, fontWeight: '700' }}>✓ {receipt}</Text>}
      {!receipt && <Muted small>A QR stream cannot tell you it arrived. Ask them to show their receipt and scan it.</Muted>}
    </Card>
  );
}

function Receiver({ onDone }: { onDone(): void }) {
  const c = useC();
  const code = useRef<ReturnType<typeof receiveCode> | null>(null);
  const [priv, setPriv] = useState<boolean | null>(null);
  const rx = useRef<QrxReceiver | null>(null);
  const [offer, setOffer] = useState<QrxOffer | null>(null), [accepted, setAccepted] = useState(false), [progress, setProgress] = useState({ solved: 0, total: 1 });
  const [done, setDone] = useState<{ bytes: Uint8Array; name: string; mime: string; sha256: string; from: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null), [saved, setSaved] = useState<string | null>(null), [ack, setAck] = useState<string | null>(null);
  const begin = (p: boolean) => { if (p) code.current = receiveCode(phoneClan().people.myProfile().name); rx.current = new QrxReceiver(p ? { receive: code.current! } : {}); setPriv(p); };
  const onFrame = (t: string) => {
    const r = rx.current; if (!r) return;
    const res = r.push(t);
    if (res === 'meta') setOffer(r.offer);
    if (res === 'progress' || res === 'done') { const p = r.progress; if (p) setProgress({ solved: p.solved, total: p.total }); }
    if (res === 'done') { try { setDone(r.result()); } catch (e) { setErr((e as Error).message); } return true; }
  };
  const save = async () => {
    if (!done) return;
    const f = new File(Paths.cache, `qrx-${Date.now()}-${done.name.replace(/[^\w.-]/g, '_')}`); f.create({ overwrite: true }); f.write(done.bytes);
    try { await phoneClan().capture.capture(me(), { kind: 'file', path: f.uri, name: done.name, mime: done.mime }); bump(); setSaved('Saved to your Inbox.'); }
    catch (e) { setErr((e as Error).message); }
  };
  const share = async () => { if (!done) return; const f = new File(Paths.cache, done.name.replace(/[^\w.-]/g, '_')); f.create({ overwrite: true }); f.write(done.bytes); await Sharing.shareAsync(f.uri, { mimeType: done.mime }); };
  if (priv === null) return (
    <Card title="Receive a file">
      <Btn primary label="Receive privately" onPress={() => begin(true)} />
      <Muted small>Shows a one-time receive code; the sender scans it first, so only this phone can open the file.</Muted>
      <Btn label="Receive a public transfer" onPress={() => begin(false)} />
      <Btn small label="Cancel" onPress={onDone} />
    </Card>
  );
  if (done) return (
    <Card title="Received and verified">
      <Text style={{ color: c.text, fontWeight: '700' }}>{done.name} · {mb(done.bytes.length)}</Text>
      <Muted>{who(done.from)}. Length and SHA-256 match exactly.</Muted>
      <Row><Btn primary label="Save to Inbox" onPress={() => void save()} /><Btn label="Share / Open" onPress={() => void share()} /><Btn label="Show receipt" onPress={() => void signer().then((s) => setAck(ackCode({ id: offer!.id, sha256: done.sha256, signer: s })))} /></Row>
      {saved && <Text accessibilityLiveRegion="polite" style={{ color: c.ok }}>{saved}</Text>}
      {ack && <><QrImage text={ack} size={240} label="Receipt code for the sender" /><Muted small>The sender scans this to confirm the file arrived intact. It shows your CLAN identity.</Muted></>}
      <Err msg={err} /><Btn small label="Done" onPress={onDone} />
    </Card>
  );
  return (
    <Card title={priv ? 'Receive privately' : 'Receive a public transfer'}>
      {priv && !offer && <><QrImage text={code.current!.text} size={240} label="Your one-time receive code" /><Muted small>Let the sender scan this, then point your camera at their screen.</Muted></>}
      {offer && !accepted && (
        <View style={{ gap: 6 }} accessibilityLabel="Incoming transfer">
          <Text style={{ color: c.text, fontWeight: '700' }}>{offer.name ?? 'Encrypted file'}{offer.size !== null ? ` · ${mb(offer.size)}` : ''}</Text>
          <Muted>{who(offer.from)} · {offer.mode === 'private' ? (offer.forMe ? 'private, for this phone' : 'private, for someone else') : 'public'}</Muted>
          {offer.forMe ? <Row><Btn primary label="Accept" onPress={() => { try { rx.current!.accept(); setAccepted(true); } catch (e) { setErr((e as Error).message); } }} /><Btn label="Decline" onPress={onDone} /></Row> : <Muted>This transfer is not for your receive code.</Muted>}
        </View>
      )}
      {accepted && <><Muted>Receiving… {progress.solved} of {progress.total} parts</Muted>
        <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: progress.total, now: progress.solved }} style={{ height: 6, backgroundColor: c.border, borderRadius: 3 }}><View style={{ width: `${(progress.solved / progress.total) * 100}%`, height: 6, backgroundColor: c.accent, borderRadius: 3 }} /></View></>}
      <QrScanner continuous hint="Hold steady, about 20–40 cm from the other screen. Missed frames are fine." onClose={onDone} onCode={onFrame} />
      <Err msg={err} />
    </Card>
  );
}
