// Board state for one board, over one of two transports: a live CLAN board (ops over the session's pinned WSS, ordered
// by the host) or a local board (Personal / Course / Study Session, through the main process). Local ops apply at once;
// unacknowledged ones stay in an outbox and are re-sent after a reconnect (op ids make that idempotent). Undo/redo are
// ordinary ops (inverses), so they sync like any edit.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { applyOp, emptyBoard, inverse, type ClientMessage, type ServerMessage, type WbBoardView, type WbLogged, type WbObjectData, type WbOp, type WbState } from '@classroom/protocol';
import { api } from '../../App.tsx';

export type BoardTransport =
  | { kind: 'live'; send(m: ClientMessage): void }
  | { kind: 'local'; boardId: string };
export type Cursor = { who: string; name: string; x: number; y: number; page: number; at: number };
export type BoardModel = ReturnType<typeof useBoard>;
type WbMsg = Extract<ServerMessage, { t: `wb.${string}` }>;

export function useBoard(t: BoardTransport, me: string) {
  const state = useRef<WbState>(emptyBoard());
  const [version, setVersion] = useState(0);
  const [view, setView] = useState<WbBoardView | null>(null);
  const [error, setError] = useState('');
  const [cursors, setCursors] = useState<Record<string, Cursor>>({});
  const outbox = useRef(new Map<string, WbOp>());
  const undo = useRef<WbOp[][]>([]), redo = useRef<WbOp[][]>([]);
  const bump = () => setVersion((v) => v + 1);
  const tRef = useRef(t); tRef.current = t;
  /** Live boards sync when the host first tells us about the wall (on connect, and again after every reconnect). */
  const synced = useRef(false);

  const nextClock = () => state.current.clock + 1;
  const ingest = useCallback((ops: WbLogged[]) => { let changed = false; for (const l of ops) changed = applyOp(state.current, l.author, l.op, l.seq) || changed; if (changed) bump(); }, []);

  /** Full or incremental sync (also after a reconnect: since = last seq seen). */
  const sync = useCallback(async () => {
    const tr = tRef.current;
    if (tr.kind === 'live') tr.send({ t: 'wb.sync', since: state.current.seq });
    else { const r = await api.board.read(tr.boardId, state.current.seq); if (r.snapshot) state.current = emptyBoard(); ingest(r.ops); setView({ id: tr.boardId, title: r.title, headSeq: r.head, wall: 'DEFAULT', canEdit: true, canManage: true, memberEdit: false }); }
  }, [ingest]);
  useEffect(() => { state.current = emptyBoard(); outbox.current.clear(); undo.current = []; redo.current = []; bump(); if (tRef.current.kind === 'local') void sync(); }, [t.kind === 'local' ? t.boardId : 'live']); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async (ops: WbOp[]) => {
    for (const op of ops) { applyOp(state.current, me, op); outbox.current.set(op.id, op); }
    bump();
    const tr = tRef.current;
    // the host accepts messages up to 64 KB: send in batches well under that
    if (tr.kind === 'live') { let batch: WbOp[] = [], n = 0; for (const op of ops) { const b = JSON.stringify(op).length; if (batch.length && (n + b > 48_000 || batch.length >= 200)) { tr.send({ t: 'wb.ops', ops: batch }); batch = []; n = 0; } batch.push(op); n += b; } if (batch.length) tr.send({ t: 'wb.ops', ops: batch }); }
    else {
      try { const logged = await api.board.edit(tr.boardId, ops); for (const op of ops) outbox.current.delete(op.id); ingest(logged); }
      catch (e) { setError(String((e as Error).message)); }
    }
  }, [ingest, me]);

  /** Commit a user action: the ops plus their inverses for undo. */
  const commit = useCallback((ops: WbOp[]) => {
    if (!ops.length) return;
    const inv = ops.map((op) => inverse(state.current.objects.get(op.obj) ? structuredClone(state.current.objects.get(op.obj)) : undefined, op, 0, '')).filter(Boolean) as WbOp[];
    undo.current.push(inv.reverse()); if (undo.current.length > 200) undo.current.shift();
    redo.current = [];
    void send(ops);
  }, [send]);
  const restamp = (ops: WbOp[]) => ops.map((o) => ({ ...o, id: crypto.randomUUID(), clock: nextClock() }));
  const doUndo = useCallback(() => { const step = undo.current.pop(); if (!step) return; const ops = restamp(step); redo.current.push(ops.map((op) => inverse(state.current.objects.get(op.obj) && structuredClone(state.current.objects.get(op.obj)), op, 0, '')).filter(Boolean).reverse() as WbOp[]); void send(ops); }, [send]); // eslint-disable-line react-hooks/exhaustive-deps
  const doRedo = useCallback(() => { const step = redo.current.pop(); if (!step) return; const ops = restamp(step); undo.current.push(ops.map((op) => inverse(state.current.objects.get(op.obj) && structuredClone(state.current.objects.get(op.obj)), op, 0, '')).filter(Boolean).reverse() as WbOp[]); void send(ops); }, [send]); // eslint-disable-line react-hooks/exhaustive-deps

  const op = {
    put: (data: WbObjectData, obj = crypto.randomUUID()): WbOp => ({ t: 'put', id: crypto.randomUUID(), obj, clock: nextClock(), data }),
    patch: (obj: string, data: Partial<WbObjectData>): WbOp => ({ t: 'patch', id: crypto.randomUUID(), obj, clock: nextClock(), data: data as never }),
    del: (obj: string): WbOp => ({ t: 'del', id: crypto.randomUUID(), obj, clock: nextClock() }),
  };

  /** Server messages for a live board (the dashboard routes wb.* here). */
  const onServer = useCallback((m: WbMsg | Extract<ServerMessage, { t: 'error' }>) => {
    if (m.t === 'wb.state') {
      if (m.snapshot) { const keep = [...outbox.current.values()]; state.current = emptyBoard(); for (const o of keep) applyOp(state.current, me, o); }
      ingest(m.ops); setView(m.board);
      if (outbox.current.size && tRef.current.kind === 'live') { const tr = tRef.current; for (const op of [...outbox.current.values()].slice(0, 500)) tr.send({ t: 'wb.ops', ops: [op] }); } // replay after reconnect (one per message, always small)
      bump();
    } else if (m.t === 'wb.op') ingest(m.ops);
    else if (m.t === 'wb.ack') { for (const id of m.ids) outbox.current.delete(id); }
    else if (m.t === 'wb.nack') {
      for (const id of m.ids) outbox.current.delete(id);
      setError(m.message);
      void sync(); // refused ops were applied locally: resync to the host's truth
    } else if (m.t === 'wb.wall') { setView(m.board); if (!synced.current) { synced.current = true; void sync(); } }
    else if (m.t === 'wb.cursor') setCursors((c) => ({ ...c, [m.who]: { who: m.who, name: m.name, x: m.x, y: m.y, page: m.page, at: Date.now() } }));
    else if (m.t === 'error' && ['presenting', 'whiteboard', 'not_shared'].includes(m.code)) setError(m.message);
  }, [ingest, me, sync]);

  /** The CLAN connection (re)opened: resync from the last seq seen once the host speaks. */
  const connected = useCallback(() => { synced.current = false; }, []);
  const cursor = useCallback((x: number, y: number, page: number) => { const tr = tRef.current; if (tr.kind === 'live') tr.send({ t: 'wb.cursor', x, y, page }); }, []);
  useEffect(() => { const i = setInterval(() => setCursors((c) => Object.fromEntries(Object.entries(c).filter(([, v]) => Date.now() - v.at < 5000))), 2000); return () => clearInterval(i); }, []);
  return useMemo(() => ({ state, version, view, error, setError, cursors, commit, undo: doUndo, redo: doRedo, op, onServer, sync, connected, cursor, pending: () => outbox.current.size }), [version, view, error, cursors, commit, doUndo, doRedo, onServer, sync, connected, cursor]); // eslint-disable-line react-hooks/exhaustive-deps
}
