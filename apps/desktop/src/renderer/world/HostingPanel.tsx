// Persistent hosting for one CLAN: which device hosts it, the owner's authorization to move it, the explicit pause and
// hand-over with progress/retry/cancel, incoming hand-overs, conflicts only the owner can resolve, and retained copies.
import { useCallback, useEffect, useState } from 'react';
import type { HostingView } from '../../shared.ts';
import { api } from '../App.tsx';
import { errText } from './useLoad.ts';

const mb = (n: number) => `${(n / 1e6).toFixed(n < 1e7 ? 1 : 0)} MB`;

export function HostingPanel({ clanId }: { clanId: string }) {
  const [v, setV] = useState<HostingView | null>(null), [err, setErr] = useState(''), [note, setNote] = useState('');
  const [confirm, setConfirm] = useState<null | 'handover' | 'cancel' | 'ours' | 'theirs' | 'ack' | 'enable' | 'revoke'>(null);
  const [acks, setAcks] = useState<string[]>([]), [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [dest, setDest] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(() => api.hosting.status(clanId).then(setV, (e) => setErr(errText(e))), [clanId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => api.hosting.onProgress((p) => { if (p.clanId === clanId) setProgress(p); }), [clanId]);
  useEffect(() => api.hosting.onChanged((p) => { if (p.clanId === clanId) { if (p.activated) setNote('This computer now hosts this CLAN.'); void load(); } }), [clanId, load]);
  // incoming hand-over: refresh while bytes arrive
  useEffect(() => { if (!v?.staging && !v?.running) return; const t = setInterval(() => void load(), 2000); return () => clearInterval(t); }, [v?.staging, v?.running, load]);
  const act = (f: () => Promise<unknown>, done?: string) => { setBusy(true); setErr(''); setConfirm(null); void f().then(() => { if (done) setNote(done); }, (e) => setErr(errText(e))).finally(() => { setBusy(false); setProgress(null); void load(); }); };
  if (!v) return err ? <section className="card"><p role="alert">{err}</p></section> : null;
  const h = v.hosting, isHost = h?.hostKey === v.me;
  const blocking = v.preflight.filter((i) => i.blocking), optional = v.preflight.filter((i) => !i.blocking);
  const ready = !v.live && !blocking.length && optional.every((i) => acks.includes(i.code));

  return (
    <section className="card stack" aria-label="Hosting">
      <span className="eyebrow">Hosting</span>
      {note && <p role="status">{note}</p>}
      {err && <p role="alert" className="error">{err}</p>}

      {!h && (v.isOwner ? <>
        <p className="muted">Only this computer can host this CLAN. Allowing hosting to move signs this CLAN with this computer's device key so one of your linked computers can take over later — one host at a time.</p>
        {confirm === 'enable'
          ? <div className="row" role="group" aria-label="Confirm allow moving"><button className="primary" disabled={busy} onClick={() => act(() => api.hosting.enable(clanId), 'Hosting can now move to your linked computers.')}>Allow</button><button onClick={() => setConfirm(null)}>Cancel</button></div>
          : <button onClick={() => setConfirm('enable')}>Allow moving hosting…</button>}
      </> : <p className="muted">Hosted by its owner's device.</p>)}

      {h?.state === 'conflict' && v.conflict && <div role="alert" className="stack">
        <p><b>Two hosts claim this CLAN.</b> {v.conflict.message} Nobody can change it until the owner chooses which host's record stands. Nothing is deleted: the other copy stays on its device.</p>
        <p className="muted">Step {v.conflict.forkEpoch}: {v.conflictNames?.ours} (this device's record) · {v.conflictNames?.theirs ?? 'unknown device'}</p>
        {v.isOwner ? <div className="row">
          {(['ours', 'theirs'] as const).map((c) => confirm === c
            ? <span key={c} role="group" aria-label={`Confirm keep ${c}`}><button className="primary" disabled={busy} onClick={() => act(() => api.hosting.resolve(clanId, c).then((r) => { if (r.notReached.length) setNote(`Decision saved. Not yet delivered to: ${r.notReached.join(', ')} — they will be told when you retry with them online.`); }))}>Confirm</button><button onClick={() => setConfirm(null)}>Cancel</button></span>
            : <button key={c} disabled={busy || (c === 'theirs' && !v.conflict!.theirs)} onClick={() => setConfirm(c)}>Keep {c === 'ours' ? v.conflictNames?.ours : v.conflictNames?.theirs}</button>)}
        </div> : <p>Ask the owner ({v.ownerName}) to choose on their device. You can export this device's copy meanwhile.</p>}
        <button onClick={() => act(() => api.hosting.exportCopy(clanId).then((r) => { if (r) setNote(`Copy saved to ${r.path}.`); }))}>Export this device's copy…</button>
      </div>}

      {v.superseded && <div role="alert" className="stack">
        <p>The owner chose another host's record for step {v.superseded.epoch}. This computer's own copy is kept here, read-only. Export anything you need; this CLAN cannot be hosted here again until you acknowledge.</p>
        <div className="row"><button onClick={() => act(() => api.hosting.exportCopy(clanId).then((r) => { if (r) setNote(`Copy saved to ${r.path}.`); }))}>Export copy…</button>
          {confirm === 'ack' ? <span role="group" aria-label="Confirm acknowledge"><button onClick={() => act(() => api.hosting.acknowledgeSuperseded(clanId))}>I have what I need</button><button onClick={() => setConfirm(null)}>Cancel</button></span> : <button onClick={() => setConfirm('ack')}>Acknowledge…</button>}</div>
      </div>}

      {h && h.state !== 'conflict' && <p>{isHost
        ? h.state === 'active' ? (h.writable ? 'This computer hosts this CLAN.' : `This computer can no longer accept changes: ${h.reason}`)
          : h.state === 'frozen' ? 'Paused for a hand-over: no changes are accepted until it finishes or you cancel.' : 'Hosting was handed over; this computer no longer accepts changes for this CLAN.'
        : `Hosted by ${v.hostName}.`}</p>}

      {v.staging && !isHost && <p role="status">Receiving hosting from {v.hostName}: {mb(v.staging.received)} of {mb(v.staging.total)}{v.staging.state === 'verified' ? ' — verified, waiting for the hand-over to complete.' : '.'} If the transfer stops, it resumes from here when the other device retries.</p>}

      {isHost && h && (h.state === 'active' || h.state === 'frozen') && v.request && <div className="stack" role="group" aria-label="Hand-over request">
        <p>The owner asked to move hosting to <b>{v.request.destName}</b>.</p>
        {v.live && <p role="alert">End the live session first.</p>}
        {blocking.map((i) => <p key={i.code} role="alert">{i.message} ({i.count})</p>)}
        {optional.map((i) => <label key={i.code} className="row"><input type="checkbox" checked={acks.includes(i.code)} onChange={(e) => setAcks(e.target.checked ? [...acks, i.code] : acks.filter((x) => x !== i.code))} /> {i.message} ({i.count}) — I understand</label>)}
        {progress && <progress max={progress.total || 1} value={progress.done} aria-label="Hand-over progress">{mb(progress.done)}</progress>}
        {confirm === 'handover' ? <div role="group" aria-label="Confirm hand-over">
          <p>Pause this CLAN and hand it to {v.request.destName}? Members cannot change anything until {v.request.destName} takes over. If the transfer stops, retry — nothing is lost and the CLAN stays paused, never split between two hosts.</p>
          <div className="row"><button className="primary" disabled={busy} onClick={() => act(() => api.hosting.handover(clanId, acks).then((r) => setNote(`${r.destName} now hosts this CLAN.`)))}>Pause and hand over</button><button onClick={() => setConfirm(null)}>Cancel</button></div>
        </div> : <div className="row">
          <button className="primary" disabled={busy || !ready} onClick={() => setConfirm('handover')}>{h.state === 'frozen' ? 'Retry hand-over' : `Hand over to ${v.request.destName}…`}</button>
          {h.state === 'active' && <button disabled={busy} onClick={() => act(() => api.hosting.decline(clanId))}>Decline</button>}
        </div>}
      </div>}

      {isHost && h?.state === 'frozen' && !v.transition && (confirm === 'cancel'
        ? <div role="group" aria-label="Confirm cancel"><p>Resume hosting here and drop the prepared hand-over?</p><div className="row"><button onClick={() => act(() => api.hosting.cancel(clanId), 'Hosting resumed on this computer.')}>Resume hosting here</button><button onClick={() => setConfirm(null)}>Keep paused</button></div></div>
        : <button disabled={busy} onClick={() => setConfirm('cancel')}>Cancel hand-over…</button>)}
      {isHost && v.transition && <p role="status">The hand-over is signed. Retry until the other computer confirms; this computer will not host this CLAN again.</p>}

      {h && v.isOwner && !v.request && h.state !== 'conflict' && <div className="row" role="group" aria-label="Move hosting">
        <select aria-label="Move hosting to" value={dest} onChange={(e) => setDest(e.target.value)}><option value="">Move hosting to…</option>{v.computers.filter((d) => d.publicKey !== h.hostKey).map((d) => <option key={d.fp} value={d.fp}>{d.name}</option>)}</select>
        <button disabled={!dest || busy} onClick={() => act(() => api.hosting.request(clanId, dest), 'Request sent. The current host must confirm and pause to hand over.')}>Ask current host</button>
      </div>}
      {h && v.isOwner && !isHost && h.state !== 'conflict' && (confirm === 'revoke'
        ? <div role="group" aria-label="Confirm stop hosting"><p>Stop {v.hostName} from hosting? It refuses all changes once told; its data stays there. Move hosting back with a new hand-over.</p>
          <div className="row"><button disabled={busy} onClick={() => act(() => api.hosting.revoke(clanId).then((r) => setNote(r.notReached.length ? `Saved. Not yet told: ${r.notReached.join(', ')} — retry when it is on.` : `${v.hostName} no longer accepts changes.`)))}>Stop hosting</button><button onClick={() => setConfirm(null)}>Cancel</button></div></div>
        : <button disabled={busy} onClick={() => setConfirm('revoke')}>Stop {v.hostName} hosting…</button>)}
      {v.restored && <p role="alert">{v.restored}</p>}
      <p className="muted">A phone can own a CLAN and move its hosting to one of your computers. Phones do not host CLANs themselves yet, and a CLAN is only available while its current host computer is on.</p>
    </section>
  );
}
