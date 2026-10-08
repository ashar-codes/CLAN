// Boards that belong to you: Personal Space, a Course, or a Study Session. Same board surface as the CLAN wall; stored
// on this device as editable operations (export makes a PNG/PDF copy).
import { lazy, Suspense, useCallback, useState } from 'react';
import type { Board, BoardOwner } from '../../../shared.ts';
import { api } from '../../App.tsx';
import { errText, useLoad } from '../useLoad.ts';
const BoardView = lazy(() => import('./BoardView.tsx').then((m) => ({ default: m.BoardView })));
import { useBoard } from './useBoard.ts';

export function Boards({ owner, boardId }: { owner: { kind: Exclude<BoardOwner['kind'], 'clan'>; id: string }; boardId?: string }) {
  const [boards, reload] = useLoad<Board[]>(useCallback(() => api.board.list(owner), [owner.kind, owner.id])); // eslint-disable-line react-hooks/exhaustive-deps
  const [open, setOpen] = useState<string | null>(boardId ?? null);
  const [title, setTitle] = useState('');
  const [err, setErr] = useState('');
  const cur = boards?.find((b) => b.id === open);
  if (open && cur) return <div className="stack"><button className="link back" onClick={() => { setOpen(null); reload(); }}>← Boards</button><LocalBoard board={cur} /></div>;
  return (
    <div className="stack">
      <div className="deck-grid">
        {boards?.map((b) => <button key={b.id} className="card deck board-card" onClick={() => setOpen(b.id)} data-testid="board-card"><span className="board-thumb" aria-hidden /><b>{b.title}</b><small className="muted">{new Date(b.updatedAt).toLocaleDateString()}</small></button>)}
        {boards?.length === 0 && <p className="muted">No boards yet.</p>}
      </div>
      <form className="row card" onSubmit={async (e) => { e.preventDefault(); setErr(''); try { const b = await api.board.create(owner, title || 'Board'); setTitle(''); reload(); setOpen(b.id); } catch (x) { setErr(errText(x)); } }}>
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="New board" aria-label="Board name" maxLength={120} />
        <button className="primary">New board</button>{err && <span className="error small-text">{err}</span>}
      </form>
    </div>
  );
}

function LocalBoard({ board }: { board: Board }) {
  const model = useBoard({ kind: 'local', boardId: board.id }, 'me');
  const [notes] = useLoad(api.clan.notes);
  return <Suspense fallback={<p className="muted" role="status">Opening the board…</p>}><BoardView board={model} title={board.title} placeables={(notes ?? []).slice(0, 50).map((n) => ({ module: 'notes' as const, id: n.id, title: n.title }))} /></Suspense>;
}
