import { useEffect, useRef, useState } from 'react';
import type { FilePreview } from '@classroom/client';
import { api } from './App.tsx';

export function FileActions({ sessionId, id, name, canOpen }: { sessionId: string; id: string; name: string; canOpen: boolean }) {
  const [view, setView] = useState<FilePreview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState('');
  const act = async (f: () => Promise<unknown>) => {
    setBusy(true); setError(''); setNotice('');
    try { await f(); } catch (e) { setError(String((e as Error).message ?? e)); }
    finally { setBusy(false); }
  };
  return <>
    <button className="small" disabled={busy} onClick={() => void act(async () => setView(await api.previewFile(sessionId, id)))}>Preview</button>
    {canOpen && <button className="small" disabled={busy} onClick={() => void act(() => api.openWithFile(sessionId, id))}>Open with…</button>}
    <button className="small" disabled={busy} onClick={() => void act(async () => { const result = await api.saveFile(sessionId, id); if (result) setNotice(`Saved ${result.name}.`); })}>Save a copy</button>
    {notice && <p className="muted" role="status">{notice}</p>}
    {error && <p className="error" role="status">{error}</p>}
    {view && <PassivePreview name={name} view={view} close={() => setView(null)} />}
  </>;
}
function PassivePreview({ name, view, close }: { name: string; view: FilePreview; close(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close(); }, []);
  return <dialog ref={dialog} className="file-preview card" aria-label={`Preview ${name}`} onClose={close} onCancel={close}>
    <h3>{name}</h3><button autoFocus onClick={close}>Close preview</button>
    {view.kind === 'text' ? <pre>{view.text}</pre> : view.kind === 'image' ? <img src={view.uri} alt={name} /> : <p>{view.reason}</p>}
  </dialog>;
}
