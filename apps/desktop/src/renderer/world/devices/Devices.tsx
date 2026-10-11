// Me › My Devices (lazy): this student's own linked devices, linking by short code with approval here, sync status from
// real counters (no progress is invented), conflicts to compare, and what sync includes.
import { useEffect, useState } from 'react';
import type { SyncConflict, SyncStatus } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { errText } from '../useLoad.ts';
import QRCode from 'qrcode';
import { linkQr, parseLinkQr } from '@classroom/protocol';
import { QrCamera } from '../people/Optical.tsx';

const ago = (t: number | null) => { if (!t) return 'never'; const s = Math.round((Date.now() - t) / 1000); return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86_400 ? `${Math.round(s / 3600)} h ago` : new Date(t).toLocaleDateString(); };
const mb = (n: number) => `${(n / 1024 / 1024).toFixed(n < 10 * 1024 * 1024 ? 1 : 0)} MB`;
const KIND: Record<string, string> = { note: 'Note', diary: 'Diary entry', task: 'Task', course: 'Course', reminder: 'Reminder', exam: 'Exam', deck: 'Deck', 'saved-item': 'Saved item', tape: 'Study Tape', file: 'File', profile: 'Profile' };
const show = (v: unknown) => v === null ? '(deleted)' : typeof v === 'object' ? String((v as { body?: string; title?: string; name?: string }).body ?? (v as { title?: string }).title ?? (v as { name?: string }).name ?? JSON.stringify(v).slice(0, 400)) : String(v);

export default function DevicesPanel() {
  const [s, setS] = useState<SyncStatus | null>(null);
  const [conflicts, setConflicts] = useState<SyncConflict[]>([]);
  const [link, setLink] = useState<{ code: string; expiresAt: number; addresses: string[] } | null>(null);
  const [join, setJoin] = useState<{ code: string; address: string } | null>(null);
  const [scanLink, setScanLink] = useState(false);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const reload = () => { void api.sync.status().then(setS); void api.sync.conflicts().then(setConflicts); };
  useEffect(() => { reload(); const off = api.sync.onChanged(reload); const t = setInterval(reload, 3000); return () => { off(); clearInterval(t); }; }, []);
  const act = async (f: () => Promise<unknown>, done = '') => { setBusy(true); setMsg(''); try { await f(); setMsg(done); } catch (e) { setMsg(errText(e)); } finally { setBusy(false); reload(); } };
  if (!s) return null;
  const others = s.devices.filter((d) => !d.current);
  return (
    <section className="stack" aria-label="My Devices" data-testid="my-devices">
      <span className="eyebrow">My Devices</span>
      {s.revoked && <p className="callout" role="alert">This device was unlinked from your other devices. It no longer syncs; what is already here stays here.</p>}
      <ul className="stack" aria-label="Linked devices">
        {s.devices.map((d) => (
          <li key={d.fp} className="row" data-testid="device-row">
            <span><b>{d.name}</b> <small className="muted">{d.platform}{d.current ? ' · this device' : ''}{d.revoked ? ' · unlinked' : ''}</small><br />
              {!d.current && !d.revoked && <small className="muted">Last sync {ago(d.lastSync)}{d.lastSeen ? ` · seen ${ago(d.lastSeen)}` : ''}{d.error ? ` · ${d.error}` : ''}</small>}
              <small className="muted"> · key {d.tlsSpki.slice(0, 8)}</small></span>
            {!d.current && !d.revoked && (confirm === d.fp
              ? <span className="row"><small>Stops syncing now; what's on it stays on it.</small><button className="danger" disabled={busy} onClick={() => void act(() => api.sync.unlink(d.fp), `${d.name} unlinked.`)}>Unlink {d.name}</button><button className="ghost" onClick={() => setConfirm(null)}>Keep</button></span>
              : <button className="danger" onClick={() => setConfirm(d.fp)}>Unlink</button>)}
          </li>
        ))}
      </ul>
      {others.length > 0 && (
        <p className="muted small-text" data-testid="sync-state">
          {s.syncing ? 'Syncing…' : s.settings.paused ? 'Paused.' : 'Up to date when your devices are on the same network.'} {s.stats.pending} change{s.stats.pending === 1 ? '' : 's'} not yet sent
          {s.stats.transfers ? ` · ${s.stats.transfers} file${s.stats.transfers === 1 ? '' : 's'} to fetch (${mb(s.stats.transferBytes)})` : ''}
          {s.stats.skippedBytes ? ` · ${mb(s.stats.skippedBytes)} of large files not downloaded` : ''}
          {s.stats.deferred ? ` · ${s.stats.deferred} waiting for related items` : ''}{s.lastError && !s.syncing ? ` · last attempt: ${s.lastError}` : ''}
        </p>
      )}
      <div className="row">
        {others.length > 0 && <button disabled={busy || s.syncing || s.revoked} onClick={() => void act(async () => { const r = await api.sync.now(); if (r.lastError) throw new Error(r.lastError); }, 'Synced.')}>Sync now</button>}
        {!link && <button disabled={busy || s.revoked} onClick={() => void act(async () => setLink(await api.sync.startLink()))}>Link a new device</button>}
        {!join && <button className="ghost" disabled={busy} onClick={() => setJoin({ code: '', address: '' })}>This is my new device</button>}
      </div>

      {link && !s.linkRequest && (
        <div className="callout stack" data-testid="link-code">
          <span>On your new device open Me › My Devices › “This is my new device” and type:</span>
          <b className="link-code" aria-label="Link code">{link.code}</b>
          <LinkQr code={link.code} addresses={link.addresses} />
          <small className="muted">Valid for 2 minutes, once. Same network needed. If it isn't found automatically, type this address there: {link.addresses.join(' or ') || '—'}</small>
          <button className="ghost" onClick={() => void act(async () => { await api.sync.cancelLink(); setLink(null); })}>Cancel</button>
        </div>
      )}
      {s.linkRequest && (
        <div className="callout stack" role="alertdialog" aria-label="Approve device">
          <span><b>{s.linkRequest.name}</b> ({s.linkRequest.platform}) wants to sync with your account. Only approve it if it's yours and you just typed the code on it.</span>
          <small className="muted">It will get your personal study data. It will not join your CLANs, get host rights, or get your AI key.</small>
          <div className="row">
            <button onClick={() => void act(async () => { await api.sync.approve(s.linkRequest!.sessionId); setLink(null); }, 'Linked.')}>Approve</button>
            <button className="danger" onClick={() => void act(async () => { await api.sync.reject(s.linkRequest!.sessionId); setLink(null); })}>Decline</button>
          </div>
        </div>
      )}
      {join && (
        <form className="stack callout" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.sync.join(join.code, join.address); setJoin(null); }, 'Linked. Your data is coming across.'); }}>
          <span>Type the code shown on your other device, then approve there. This device's own data is kept and added to your account.</span>
          <input value={join.code} onChange={(e) => setJoin({ ...join, code: e.target.value })} placeholder="CLAN-XXXX-XXXX-XXXX" aria-label="Link code" autoComplete="off" />
          {scanLink ? <QrCamera onCode={(t) => { const q = parseLinkQr(t); if (!q) return; setJoin({ code: q.code, address: q.address }); setScanLink(false); return true; }} /> : <button type="button" className="ghost" onClick={() => setScanLink(true)}>Scan the code with the camera</button>}
          <input value={join.address} onChange={(e) => setJoin({ ...join, address: e.target.value })} placeholder="Address (only if not found automatically)" aria-label="Device address" />
          <div className="row"><button disabled={busy || !join.code.trim()}>{busy ? 'Waiting for approval…' : 'Link'}</button><button type="button" className="ghost" onClick={() => setJoin(null)}>Cancel</button></div>
        </form>
      )}

      {conflicts.length > 0 && (
        <div className="stack" aria-label="Sync conflicts">
          <span className="eyebrow">Needs your choice ({conflicts.length})</span>
          {conflicts.map((c) => (
            <div key={c.id} className="callout stack" data-testid="conflict">
              <span><b>{KIND[c.kind] ?? c.kind}</b> — {c.note}</span>
              <div className="compare"><div><small className="muted">This device</small><pre>{show(c.local)}</pre></div><div><small className="muted">{c.fromDevice}</small><pre>{show(c.remote)}</pre></div></div>
              <div className="row">
                <button onClick={() => void act(() => api.sync.resolve(c.id, 'mine'))}>Keep this device's</button>
                <button onClick={() => void act(() => api.sync.resolve(c.id, 'theirs'))}>Use {c.fromDevice}'s</button>
                {c.canKeepBoth && <button onClick={() => void act(() => api.sync.resolve(c.id, 'both'))}>Keep both</button>}
              </div>
            </div>
          ))}
        </div>
      )}

      {others.length > 0 && (
        <fieldset className="stack"><legend className="eyebrow">What syncs</legend>
          <small className="muted">Profile, courses, notes, Saved, Capture Inbox, tasks, reminders, exams, flashcards and reviews, study sessions, personal and course boards, Study Tape details, and your own files. Never: CLANs you host or joined, chats, other people's files, or your AI key.</small>
          <label className="radio"><input type="checkbox" checked={s.settings.syncDiary} onChange={(e) => void act(() => api.sync.setSettings({ syncDiary: e.target.checked }))} /><span>Sync Diary <small className="muted">off by default; encrypted in transit, stored like the rest of your data on each device</small></span></label>
          <label>Files
            <select value={s.settings.files} aria-label="File sync" onChange={(e) => void act(() => api.sync.setSettings({ files: e.target.value as 'all' | 'small' | 'off' }))}>
              <option value="small">Up to 50 MB each</option><option value="all">All, including recordings and large files</option><option value="off">Don't download files</option>
            </select></label>
          <label className="radio"><input type="checkbox" checked={s.settings.paused} onChange={(e) => void act(() => api.sync.setSettings({ paused: e.target.checked }))} /><span>Pause sync on this device</span></label>
        </fieldset>
      )}
      <details><summary className="small-text">Lost a device?</summary>
        <p className="muted small-text">Unlink it here from any of your other devices: it is refused from then on and the change reaches your other devices when they next sync. Its local copy can't be erased remotely — use the device's own lock or erase. If you lost every device, there is no cloud copy to recover from; start fresh and link new devices to it.</p>
      </details>
      {msg && <p className="muted small-text" role="status">{msg}</p>}
    </section>
  );
}

/** The same one-time code as a QR, for a phone or another computer to scan instead of typing. */
function LinkQr({ code, addresses }: { code: string; addresses: string[] }) {
  const [img, setImg] = useState('');
  useEffect(() => { void QRCode.toDataURL(linkQr(code, addresses), { margin: 4, width: 220 }).then(setImg); }, [code, addresses]);
  return img ? <img src={img} alt="Link code as a QR code" width={220} height={220} /> : null;
}
