import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '@classroom/client';
import type {
  ClientMessage, ResourceView, StudentAssignmentView, TeacherAssignmentView, TeacherResourceView, TransferState, TransferStats,
} from '@classroom/protocol';
import type { Conn, FileState, StoredReceipt } from '../shared.ts';
import { api } from './App.tsx';

const time = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dateTime = (ts: number) => new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const ext = (name: string) => (name.includes('.') ? name.split('.').pop()!.toUpperCase() : 'FILE');
const errText = (e: unknown) => String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const STATE_LABEL: Record<TransferState, string> = {
  not_started: 'Not downloaded', queued: 'Queued', downloading: 'Downloading', paused: 'Paused', verifying: 'Verifying integrity…', completed: 'Downloaded', failed: 'Failed',
};

// ---------------- Teacher ----------------

export function TeacherFiles({ resources, stats, send }: { resources: TeacherResourceView[]; stats: TransferStats | null; send(m: ClientMessage): void }) {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<string[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => api.onImportProgress((p) => setProgress((x) => ({ ...x, [p.resourceId]: p.size ? p.bytes / p.size : 1 }))), []);

  const add = async () => {
    setBusy(true); setErrors([]);
    try { setErrors((await api.addFiles()).errors); } catch (e) { setErrors([errText(e)]); } finally { setBusy(false); }
  };

  return (
    <div className="card wide">
      <h3>Classroom files <button className="primary small push" disabled={busy} onClick={add}>{busy ? 'Adding…' : 'Add files'}</button></h3>
      <p className="muted small-text">Files stay on this computer. Students download them over the local network.
        {stats && (stats.activeDownloads > 0 || stats.activeUploads > 0) && <> · <b>{stats.activeDownloads}</b> downloading, <b>{stats.activeUploads}</b> uploading, {formatBytes(stats.bytesPerSec)}/s</>}
      </p>
      {errors.map((e) => <p key={e} className="error">{e}</p>)}
      {resources.length === 0 && <p className="muted">No files yet.</p>}
      {resources.map((r) => (
        <div key={r.id} className="file" data-testid={`teacher-file-${r.name}`}>
          <div className="file-main">
            <span className="tag">{ext(r.name)}</span>
            <div className="grow">
              <b>{r.name}</b> <span className="muted">{formatBytes(r.size)} · added {time(r.addedAt)}{!r.available && ' · hidden from students'}</span><br />
              {r.status === 'importing' && <small>Adding… {Math.round((progress[r.id] ?? 0) * 100)}%</small>}
              {r.status === 'failed' && <small className="error">Could not add this file.</small>}
              {r.status === 'ready' && (
                <small className="muted" title={`SHA-256 ${r.sha256}`}>
                  ✓ SHA-256 {r.sha256?.slice(0, 12)}… · Completed <b data-testid="completed-count">{r.counts.completed}</b> · Downloading {r.counts.downloading + r.counts.verifying} · Queued {r.counts.queued} · Paused {r.counts.paused} · Failed {r.counts.failed} · Not started {r.counts.not_started}
                </small>
              )}
            </div>
          </div>
          {r.status === 'ready' && (
            <div className="row wrap">
              <button className="small" onClick={() => send({ t: 'resource.push', resourceId: r.id })}>Send to everyone</button>
              <button className="small" onClick={() => send({ t: 'resource.available', resourceId: r.id, available: !r.available })}>{r.available ? 'Hide' : 'Make available'}</button>
              <button className="small danger" onClick={() => confirm(`Remove ${r.name} from the class? Copies students already downloaded are not affected.`) && send({ t: 'resource.remove', resourceId: r.id })}>Remove</button>
              <button className="link small" onClick={() => setOpen(open === r.id ? null : r.id)}>{open === r.id ? 'Hide students' : 'Per student'}</button>
            </div>
          )}
          {open === r.id && (
            <table className="mini"><tbody>
              {r.students.map((s) => <tr key={s.memberId}><td>{s.fullName}</td><td>{STATE_LABEL[s.state]}</td><td className="muted">{s.state === 'downloading' || s.state === 'paused' ? `${Math.round((s.bytes / r.size) * 100)}%` : ''}</td></tr>)}
            </tbody></table>
          )}
        </div>
      ))}
    </div>
  );
}

export function TeacherAssignments({ assignments, send }: { assignments: TeacherAssignmentView[]; send(m: ClientMessage): void }) {
  const [creating, setCreating] = useState(false);
  const [f, setF] = useState({ title: '', instructions: '', due: '', types: '', maxMb: '50' });
  const [error, setError] = useState('');

  const create = () => {
    const maxBytes = Math.round(Number(f.maxMb) * 1024 * 1024);
    if (!f.title.trim() || !(maxBytes > 0)) return setError('Give the assignment a title and a maximum size.');
    const allowedExtensions = f.types.split(/[\s,]+/).map((t) => t.trim().replace(/^\./, '').toLowerCase()).filter(Boolean);
    if (allowedExtensions.some((t) => !/^[a-z0-9]{1,10}$/.test(t))) return setError('File types should look like: pdf, zip, docx');
    send({ t: 'assignment.create', assignment: { title: f.title.trim(), instructions: f.instructions, dueAt: f.due ? new Date(f.due).getTime() : null, allowedExtensions, maxBytes, mode: 'individual' } });
    setCreating(false); setError('');
    setF({ title: '', instructions: '', due: '', types: '', maxMb: '50' });
  };

  return (
    <div className="card wide">
      <h3>Assignments {!creating && <button className="primary small push" onClick={() => setCreating(true)}>New assignment</button>}</h3>
      {creating && (
        <div className="form">
          <label>Title<input value={f.title} maxLength={120} placeholder="Assignment 04" onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label>Instructions<textarea value={f.instructions} maxLength={5000} rows={3} onChange={(e) => setF({ ...f, instructions: e.target.value })} /></label>
          <div className="row wrap">
            <label>Due (optional)<input type="datetime-local" value={f.due} onChange={(e) => setF({ ...f, due: e.target.value })} /></label>
            <label>Allowed types<input value={f.types} placeholder="pdf, zip (empty = any)" onChange={(e) => setF({ ...f, types: e.target.value })} /></label>
            <label>Max size (MB)<input type="number" min="1" max="2048" value={f.maxMb} onChange={(e) => setF({ ...f, maxMb: e.target.value })} /></label>
          </div>
          <small className="muted">Individual submissions. Group submissions arrive with the groups feature.</small>
          {error && <p className="error">{error}</p>}
          <div className="row"><button className="primary" onClick={create}>Publish</button><button onClick={() => setCreating(false)}>Cancel</button></div>
        </div>
      )}
      {assignments.length === 0 && !creating && <p className="muted">No assignments yet.</p>}
      {assignments.map((a) => (
        <details key={a.id} className="assignment" open>
          <summary>
            <b>{a.title}</b> {a.closed && <span className="tag">closed</span>}
            <span className="muted"> · {a.dueAt ? `due ${dateTime(a.dueAt)}` : 'no due time'} · Submitted <b data-testid="submitted-count">{a.counts.submitted}</b> · Late {a.counts.late} · Missing {a.counts.missing}{a.counts.uploading ? ` · Uploading ${a.counts.uploading}` : ''}{a.counts.failed ? ` · Failed ${a.counts.failed}` : ''}</span>
          </summary>
          <table className="mini"><tbody>
            {a.students.map((s) => (
              <tr key={s.memberId}>
                <td>{s.fullName} <span className="muted">{s.rollNo}</span></td>
                <td className={s.state === 'late' || s.state === 'failed' ? 'warn' : s.state === 'missing' ? 'muted' : ''}>{s.state[0]!.toUpperCase() + s.state.slice(1)}{s.version && s.version > 1 ? ` (v${s.version})` : ''}</td>
                <td className="muted">{s.submittedAt ? time(s.submittedAt) : ''}</td>
                <td>{s.submissionId && <button className="link small" title={s.fileName ?? ''} onClick={() => api.revealSubmission(s.submissionId!)}>Show file</button>}</td>
              </tr>
            ))}
          </tbody></table>
          {!a.closed && <button className="small" onClick={() => confirm(`Close "${a.title}"? Students will no longer be able to submit.`) && send({ t: 'assignment.close', assignmentId: a.id })}>Close assignment</button>}
        </details>
      ))}
    </div>
  );
}

// ---------------- Student ----------------

export function StudentFiles({ conn, resources, pushed, send }: { conn: Conn; resources: ResourceView[]; pushed: string | null; send(m: ClientMessage): void }) {
  const [states, setStates] = useState<Record<string, FileState>>({});
  const [error, setError] = useState('');
  const autoQueued = useRef(new Set<string>());

  // Merge disk/memory state for the current list; report it to the teacher.
  useEffect(() => {
    api.fileStatus(conn, resources).then((list) => setStates(Object.fromEntries(list.map((s) => [s.resourceId, s]))));
  }, [conn, resources]);
  useEffect(() => api.onFileState((s) => {
    setStates((x) => ({ ...x, [s.resourceId]: s }));
    send({ t: 'transfer.state', resourceId: s.resourceId, state: s.state, bytes: s.bytes });
  }), [send]);

  // "Send to everyone": queue once per resource; if the student pauses it, respect that.
  useEffect(() => {
    for (const r of resources) {
      const want = r.pushed || r.id === pushed;
      const st = states[r.id]?.state;
      if (want && st && (st === 'not_started' || st === 'failed') && !autoQueued.current.has(r.id)) {
        autoQueued.current.add(r.id);
        void api.download(conn, r);
      }
    }
  }, [resources, pushed, states, conn]);

  const act = (f: () => Promise<unknown>) => { setError(''); f().catch((e) => setError(errText(e))); };

  return (
    <div className="card wide">
      <h3>Classroom files</h3>
      {error && <p className="error">{error}</p>}
      {resources.length === 0 && <p className="muted">Your teacher hasn't shared any files yet.</p>}
      {resources.map((r) => {
        const s = states[r.id] ?? { state: 'not_started' as const, bytes: 0, size: r.size, resourceId: r.id };
        const pct = r.size ? Math.floor((s.bytes / r.size) * 100) : 100;
        return (
          <div key={r.id} className="file" data-testid={`student-file-${r.name}`}>
            <div className="file-main">
              <span className="tag">{ext(r.name)}</span>
              <div className="grow">
                <b>{r.name}</b> <span className="muted">{formatBytes(r.size)}</span><br />
                <small className={s.state === 'failed' ? 'error' : 'muted'} data-testid="file-state">
                  {STATE_LABEL[s.state]}{(s.state === 'downloading' || s.state === 'paused') && ` · ${pct}%`}{s.resumedFrom ? ' · resumed' : ''}{s.error ? ` — ${s.error}` : ''}
                </small>
                {(s.state === 'downloading' || s.state === 'paused' || s.state === 'verifying') && <progress max={100} value={pct} />}
              </div>
            </div>
            <div className="row wrap">
              {s.state === 'not_started' && <button className="primary small" onClick={() => act(() => api.download(conn, r))}>Download</button>}
              {(s.state === 'downloading' || s.state === 'queued') && <button className="small" onClick={() => act(() => api.pause(r.id))}>Pause</button>}
              {s.state === 'paused' && <button className="primary small" onClick={() => act(() => api.download(conn, r))}>Resume</button>}
              {s.state === 'failed' && <button className="primary small" onClick={() => act(() => api.download(conn, r))}>Retry</button>}
              {s.state === 'completed' && s.canOpen && <button className="small" onClick={() => act(() => api.openFile(conn.sessionId, r.id))}>Open</button>}
              {s.state === 'completed' && <button className="small" onClick={() => act(() => api.showFile(conn.sessionId, r.id))}>Show in folder</button>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function StudentAssignments({ conn, assignments }: { conn: Conn; assignments: StudentAssignmentView[] }) {
  const [uploading, setUploading] = useState<Record<string, { sent: number; size: number; name: string }>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [receipts, setReceipts] = useState<StoredReceipt[]>([]);
  // Verification of the server's "latest" receipt per assignment, done by main against the PAKE-learned teacher key.
  const [checks, setChecks] = useState<Record<string, StoredReceipt>>({});
  useEffect(() => { api.receipts(conn.sessionId).then(setReceipts); }, [conn.sessionId]);
  useEffect(() => {
    for (const a of assignments) if (a.latest && !checks[a.latest.payload.submissionId]) {
      const id = a.latest.payload.submissionId;
      api.verifyReceipt(a.latest).then((r) => setChecks((x) => ({ ...x, [id]: r })));
    }
  }, [assignments]);
  useEffect(() => api.onUploadProgress((p) => setUploading((x) => (x[p.assignmentId] ? { ...x, [p.assignmentId]: { ...x[p.assignmentId]!, sent: p.sent, size: p.size } } : x))), []);

  const submit = async (a: StudentAssignmentView) => {
    setErrors((x) => ({ ...x, [a.id]: '' }));
    const pick = await api.pickSubmission(a.allowedExtensions).catch((e) => { setErrors((x) => ({ ...x, [a.id]: errText(e) })); return null; });
    if (!pick) return;
    if (pick.size > a.maxBytes) return setErrors((x) => ({ ...x, [a.id]: `That file is ${formatBytes(pick.size)}; the limit is ${formatBytes(a.maxBytes)}.` }));
    setUploading((x) => ({ ...x, [a.id]: { sent: 0, size: pick.size, name: pick.name } }));
    try {
      const r = await api.submit(conn, a.id, pick.pickId);
      setReceipts((x) => [r, ...x.filter((y) => y.receipt.payload.submissionId !== r.receipt.payload.submissionId)]);
      setChecks((x) => ({ ...x, [r.receipt.payload.submissionId]: r }));
    } catch (e) {
      setErrors((x) => ({ ...x, [a.id]: errText(e) + ' You can retry; nothing will be submitted twice.' }));
    } finally {
      setUploading(({ [a.id]: _, ...rest }) => rest);
    }
  };

  return (
    <div className="card wide">
      <h3>Assignments</h3>
      {assignments.length === 0 && <p className="muted">No assignments yet.</p>}
      {assignments.map((a) => {
        const up = uploading[a.id];
        const latest = a.latest?.payload;
        const check = latest && checks[latest.submissionId];
        return (
          <div key={a.id} className="assignment" data-testid={`assignment-${a.title}`}>
            <b>{a.title}</b> {a.closed && <span className="tag">closed</span>}
            <div className="muted small-text">{a.dueAt ? `Due ${dateTime(a.dueAt)}` : 'No due time'} · {a.allowedExtensions.length ? a.allowedExtensions.map((e) => '.' + e).join(' ') : 'any file type'} · up to {formatBytes(a.maxBytes)}</div>
            {a.instructions && <p className="instructions">{a.instructions}</p>}
            {latest && (
              <div className={`receipt${check && !check.verified ? ' bad' : ''}`} data-testid="receipt">
                <span data-testid="receipt-verification">{!check ? 'Checking receipt…' : check.verified ? 'Verified ✓' : `Verification failed — ${check.reason}`}</span><br />
                <b>Submitted</b>{latest.late && <span className="warn"> (late)</span>} {latest.fileName} · {formatBytes(latest.size)} · {dateTime(latest.submittedAt)}{latest.version > 1 && ` · version ${latest.version}`}<br />
                <small className="muted">Receipt {latest.submissionId.slice(0, 8)} · SHA-256 {latest.sha256.slice(0, 16)}… · signed by the teacher's computer</small>
              </div>
            )}
            {up && <div><small>Uploading {up.name}… {up.size ? Math.floor((up.sent / up.size) * 100) : 0}%</small><progress max={up.size || 1} value={up.sent} /></div>}
            {errors[a.id] && <p className="error">{errors[a.id]}</p>}
            {!a.closed && !up && <button className={latest ? 'small' : 'primary small'} onClick={() => submit(a)}>{latest ? 'Submit a new version' : 'Submit file'}</button>}
          </div>
        );
      })}
      {receipts.length > 0 && (
        <details><summary className="muted">Receipts saved on this device ({receipts.length})</summary>
          <table className="mini"><tbody>{receipts.map(({ receipt: { payload: r }, verified, reason }) => (
            <tr key={r.submissionId}><td>{r.assignmentTitle}</td><td>{r.fileName}</td><td className="muted">{dateTime(r.submittedAt)}</td><td className="muted">{r.sha256.slice(0, 10)}…</td><td className={verified ? '' : 'error'}>{verified ? 'Verified ✓' : `Verification failed (${reason})`}</td></tr>
          ))}</tbody></table>
        </details>
      )}
    </div>
  );
}
