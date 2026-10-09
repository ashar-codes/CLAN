// Phone whiteboard: the CLAN board over the class connection, and your own boards (personal / course) stored in core on
// the phone — one op format and one reducer everywhere (same convergence as desktop; personal boards also sync between
// your devices). Touch: one finger draws/erases/moves/places text (by tool), two fingers pan + pinch-zoom. Stylus force
// is used as pressure where reported. Drawn on two demand-rendered canvas layers in the installed WebView engine.
// Edits made while disconnected wait in an outbox and are re-sent (same op ids) after the board re-syncs.
import { CanvasLayer } from './CanvasLayer';
import { useCallback, useMemo, useRef, useState } from 'react';
import { PanResponder, Pressable, Text, TextInput, View, type GestureResponderEvent } from 'react-native';
import { applyOp, emptyBoard, hit, inverse, simplify, visible, type ClientMessage, type ServerMessage, type WbBoardView, type WbObject, type WbObjectData, type WbOp } from '@classroom/protocol';

type C = { text: string; muted: string; border: string; surface: string; accent: string; danger: string };
type Tool = 'hand' | 'pen' | 'highlighter' | 'eraser' | 'select' | 'sticky' | 'text';
export type BoardModel = { s: { current: ReturnType<typeof emptyBoard> }; v: number; view: { canEdit: boolean } | null; error: string; commit(ops: WbOp[]): void; op: Ops; undo(): void };
type Ops = { put(d: WbObjectData): WbOp; patch(obj: string, d: Partial<WbObjectData>): WbOp; del(obj: string): WbOp };
type WbMsg = Extract<ServerMessage, { t: `wb.${string}` }>;

export function useMobileBoard(send: (m: ClientMessage) => void, me: string) {
  const s = useRef(emptyBoard());
  const [v, setV] = useState(0);
  const [view, setView] = useState<WbBoardView | null>(null);
  const [error, setError] = useState('');
  const synced = useRef(false);
  const undo = useRef<WbOp[][]>([]);
  const outbox = useRef(new Map<string, WbOp>()); // own ops the host hasn't echoed yet
  const bump = () => setV((x) => x + 1);
  const confirmed = (ops: { op: WbOp }[]) => { for (const l of ops) outbox.current.delete(l.op.id); };
  const onServer = useCallback((m: WbMsg) => {
    if (m.t === 'wb.state') {
      if (m.snapshot) s.current = emptyBoard();
      for (const l of m.ops) applyOp(s.current, l.author, l.op, l.seq);
      confirmed(m.ops); setView(m.board); bump();
      for (const op of outbox.current.values()) { applyOp(s.current, me, op); send({ t: 'wb.ops', ops: [op] }); } // reconnected: re-send what didn't arrive
    }
    else if (m.t === 'wb.op') { for (const l of m.ops) applyOp(s.current, l.author, l.op, l.seq); confirmed(m.ops); bump(); }
    else if (m.t === 'wb.wall') { setView(m.board); if (!synced.current) { synced.current = true; send({ t: 'wb.sync', since: s.current.seq }); } }
    else if (m.t === 'wb.nack') { setError(m.message); send({ t: 'wb.sync', since: 0 }); }
  }, [send]);
  const commit = useCallback((ops: WbOp[]) => {
    undo.current.push(ops.map((op) => inverse(s.current.objects.get(op.obj) && { ...s.current.objects.get(op.obj)! }, op, 0, '')).filter(Boolean).reverse() as WbOp[]);
    for (const op of ops) { applyOp(s.current, me, op); outbox.current.set(op.id, op); }
    bump();
    for (const op of ops) send({ t: 'wb.ops', ops: [op] }); // one per message keeps each well under the host's limit
  }, [me, send]);
  const clock = () => s.current.clock + 1;
  const op = {
    put: (data: WbObjectData): WbOp => ({ t: 'put', id: randomId(), obj: randomId(), clock: clock(), data }),
    patch: (obj: string, data: Partial<WbObjectData>): WbOp => ({ t: 'patch', id: randomId(), obj, clock: clock(), data: data as never }),
    del: (obj: string): WbOp => ({ t: 'del', id: randomId(), obj, clock: clock() }),
  };
  const doUndo = () => { const step = undo.current.pop(); if (step) { const ops = step.map((o) => ({ ...o, id: randomId(), clock: clock() })); for (const o of ops) { applyOp(s.current, me, o); outbox.current.set(o.id, o); } bump(); for (const o of ops) send({ t: 'wb.ops', ops: [o] }); } };
  return { s, v, view, error, setError, onServer, commit, op, undo: doUndo, connected: () => { synced.current = false; } };
}

/** One of your own boards (personal / course), stored by core on this phone: works offline, syncs between your devices. */
export function useLocalBoard(b: { read(since: number): { ops: { seq: number; author: string; op: WbOp }[]; snapshot: boolean }; edit(ops: WbOp[]): void }, me: string): BoardModel {
  const s = useRef(emptyBoard());
  const [v, setV] = useState(0), [error, setError] = useState('');
  const undo = useRef<WbOp[][]>([]);
  const load = useCallback(() => { const r = b.read(s.current.seq); if (r.snapshot) s.current = emptyBoard(); for (const l of r.ops) applyOp(s.current, l.author, l.op, l.seq); setV((x) => x + 1); }, [b]);
  useMemo(() => load(), [load]);
  const clock = () => s.current.clock + 1;
  const commit = (ops: WbOp[]) => {
    undo.current.push(ops.map((op) => inverse(s.current.objects.get(op.obj) && { ...s.current.objects.get(op.obj)! }, op, 0, '')).filter(Boolean).reverse() as WbOp[]);
    try { b.edit(ops); setError(''); } catch (e) { setError((e as Error).message); }
    load();
  };
  return { s, v, view: { canEdit: true }, error, commit, undo: () => { const step = undo.current.pop(); if (step) { try { b.edit(step.map((o) => ({ ...o, id: randomId(), clock: clock() }))); } catch (e) { setError((e as Error).message); } load(); } },
    op: { put: (data) => ({ t: 'put', id: randomId(), obj: randomId(), clock: clock(), data }), patch: (obj, data) => ({ t: 'patch', id: randomId(), obj, clock: clock(), data: data as never }), del: (obj) => ({ t: 'del', id: randomId(), obj, clock: clock() }) } };
}
const randomId = () => (globalThis.crypto?.randomUUID?.() ?? 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => Math.floor(Math.random() * 16).toString(16)));

export function MobileBoard({ c, board, title }: { c: C; board: BoardModel; title: string }) {
  const can = !!board.view?.canEdit;
  const [tool, setTool] = useState<Tool>(can ? 'pen' : 'hand');
  const [vp, setVp] = useState({ x: 0, y: 0, z: 0.6 });
  const [draft, setDraft] = useState<[number, number][] | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [sticky, setSticky] = useState<{ x: number; y: number; text: string; kind: 'sticky' | 'text' } | null>(null);
  const g = useRef<{ start: [number, number]; pts: [number, number][]; pressure: number[]; pinch?: { d: number; z: number; cx: number; cy: number; vx: number; vy: number }; move?: { id: string; ox: number; oy: number; sx: number; sy: number }; erased: Set<string> } | null>(null);
  const vpRef = useRef(vp); vpRef.current = vp;
  const toolRef = useRef(tool); toolRef.current = tool;
  const world = (e: GestureResponderEvent) => { const p = vpRef.current; return [e.nativeEvent.locationX / p.z + p.x, e.nativeEvent.locationY / p.z + p.y] as [number, number]; };
  const pan = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => true, onMoveShouldSetPanResponder: () => true,
    onPanResponderGrant: (e) => {
      const [x, y] = world(e), t = toolRef.current;
      g.current = { start: [x, y], pts: [[0, 0]], pressure: [e.nativeEvent.force ?? 0.5], erased: new Set() };
      if (!can || t === 'hand') return;
      if (t === 'sticky' || t === 'text') { setSticky({ x, y, text: '', kind: t }); g.current = null; return; }
      if (t === 'select') { const o = hit(board.s.current, 0, x, y, 12 / vpRef.current.z); setSel(o?.id ?? null); if (o) g.current.move = { id: o.id, ox: o.x, oy: o.y, sx: x, sy: y }; return; }
      if (t === 'eraser') { const o = hit(board.s.current, 0, x, y, 14 / vpRef.current.z); if (o) g.current.erased.add(o.id); return; }
      setDraft([[0, 0]]);
    },
    onPanResponderMove: (e, gs) => {
      const st = g.current; if (!st) return;
      const touches = e.nativeEvent.touches;
      if (touches.length === 2 || toolRef.current === 'hand' || !can) { // pan / pinch-zoom
        const [a, b] = [touches[0], touches[1] ?? touches[0]];
        const d = Math.hypot(a!.pageX - b!.pageX, a!.pageY - b!.pageY);
        st.pinch ??= { d: d || 1, z: vpRef.current.z, cx: gs.x0, cy: gs.y0, vx: vpRef.current.x, vy: vpRef.current.y };
        const z = Math.min(4, Math.max(0.15, st.pinch.z * (touches.length === 2 ? d / st.pinch.d : 1)));
        setVp({ z, x: st.pinch.vx - gs.dx / z, y: st.pinch.vy - gs.dy / z }); setDraft(null);
        return;
      }
      const [x, y] = world(e);
      if (st.move) { const o = board.s.current.objects.get(st.move.id); if (o) { o.x = st.move.ox + x - st.move.sx; o.y = st.move.oy + y - st.move.sy; setVp({ ...vpRef.current }); } return; }
      if (toolRef.current === 'eraser') { const o = hit(board.s.current, 0, x, y, 14 / vpRef.current.z); if (o) st.erased.add(o.id); setVp({ ...vpRef.current }); return; }
      st.pts.push([x - st.start[0], y - st.start[1]]); st.pressure.push(e.nativeEvent.force ?? 0.5); setDraft([...st.pts]);
    },
    onPanResponderRelease: () => {
      const st = g.current; g.current = null; setDraft(null);
      if (!st || st.pinch) return;
      if (st.move) { const o = board.s.current.objects.get(st.move.id); if (o) { const nx = o.x, ny = o.y; o.x = st.move.ox; o.y = st.move.oy; if (Math.hypot(nx - o.x, ny - o.y) > 1) board.commit([board.op.patch(o.id, { x: nx, y: ny })]); } return; }
      if (st.erased.size) { board.commit([...st.erased].map((id) => board.op.del(id))); return; }
      const t = toolRef.current;
      if ((t === 'pen' || t === 'highlighter') && st.pts.length > 1) {
        const pts = simplify(st.pts, 0.8).slice(0, 1500);
        board.commit([board.op.put({ kind: 'stroke', page: 0, x: st.start[0], y: st.start[1], w: 0, h: 0, points: pts, color: '#17233b', width: t === 'highlighter' ? 14 : 3, z: Date.now() % 1e9,
          ...(t === 'highlighter' ? { highlighter: true } : {}), ...(st.pressure.some((p) => p !== 0.5) ? { pressure: st.pressure.slice(0, pts.length).map((p) => Math.max(0, Math.min(1, p))) } : {}) })]);
      }
    },
  }), [board, can]); // eslint-disable-line react-hooks/exhaustive-deps
  const objs = useMemo(() => visible(board.s.current, 0), [board.v]);
  const moving = g.current?.move ? board.s.current.objects.get(g.current.move.id) ?? null : null;
  const preview: WbObjectData | null = draft && g.current ? { kind: 'stroke', page: 0, x: g.current.start[0], y: g.current.start[1], w: 0, h: 0, points: draft, color: '#17233b', width: tool === 'highlighter' ? 14 : 3, z: 0, ...(tool === 'highlighter' ? { highlighter: true } : {}) } : null;
  return (
    <View style={{ gap: 6 }} accessibilityLabel={`${title}: ${objs.length} objects`}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4 }} accessibilityRole="toolbar">
        {(['hand', ...(can ? ['pen', 'highlighter', 'eraser', 'select', 'text', 'sticky'] : [])] as Tool[]).map((t) =>
          <Pressable key={t} accessibilityRole="button" accessibilityState={{ selected: tool === t }} onPress={() => setTool(t)} style={{ minHeight: 48, paddingHorizontal: 10, justifyContent: 'center', borderRadius: 10, borderWidth: 1, borderColor: tool === t ? c.accent : c.border }}>
            <Text style={{ color: tool === t ? c.accent : c.text }}>{{ hand: 'Pan', pen: 'Pen', highlighter: 'Highlight', eraser: 'Erase', select: 'Select', text: 'Text', sticky: 'Sticky' }[t]}</Text></Pressable>)}
        {can && <Pressable accessibilityRole="button" onPress={board.undo} style={{ minHeight: 48, paddingHorizontal: 10, justifyContent: 'center' }}><Text style={{ color: c.text }}>Undo</Text></Pressable>}
        {can && sel && <Pressable accessibilityRole="button" onPress={() => { board.commit([board.op.del(sel)]); setSel(null); }} style={{ minHeight: 48, paddingHorizontal: 10, justifyContent: 'center' }}><Text style={{ color: c.danger }}>Delete</Text></Pressable>}
      </View>
      {!can && <Text style={{ color: c.muted }}>View only</Text>}
      {!!board.error && <Text style={{ color: c.danger }}>{board.error}</Text>}
      <View {...pan.panHandlers} testID="board-canvas" style={{ height: 420, borderRadius: 14, overflow: 'hidden', backgroundColor: '#fffdf8', borderWidth: 1, borderColor: c.border }}>
        <CanvasLayer objects={objs} vp={vp} selected={sel} erased={[...(g.current?.erased ?? [])]} moving={moving} draft={preview} />
        {objs.filter((o) => (o.text || o.ref) && !g.current?.erased.has(o.id)).map((o) => <View key={o.id} accessible accessibilityLabel={o.text ?? o.ref?.title} pointerEvents="none" style={{ position: 'absolute', left: (o.x - vp.x) * vp.z, top: (o.y - vp.y) * vp.z, width: Math.max(24, o.w * vp.z), height: Math.max(24, o.h * vp.z) }} />)}
      </View>
      {sticky && <View style={{ flexDirection: 'row', gap: 6 }}>
        <TextInput autoFocus value={sticky.text} onChangeText={(t) => setSticky({ ...sticky, text: t })} placeholder={sticky.kind === 'text' ? 'Text' : 'Sticky note'} accessibilityLabel={sticky.kind === 'text' ? 'Text to place' : 'Sticky note text'} style={{ flex: 1, borderWidth: 1, borderColor: c.border, borderRadius: 10, minHeight: 44, paddingHorizontal: 8, color: c.text }} />
        <Pressable accessibilityRole="button" onPress={() => { if (sticky.text.trim()) board.commit([board.op.put(sticky.kind === 'text'
          ? { kind: 'text', page: 0, x: sticky.x, y: sticky.y, w: 0, h: 0, color: '#17233b', width: 20, z: Date.now() % 1e9, text: sticky.text.slice(0, 4000) }
          : { kind: 'sticky', page: 0, x: sticky.x, y: sticky.y, w: 170, h: 120, color: '#17233b', fill: '#fde68a', width: 1, z: Date.now() % 1e9, text: sticky.text.slice(0, 4000) })]); setSticky(null); }} style={{ justifyContent: 'center', paddingHorizontal: 12 }}><Text style={{ color: c.accent }}>Add</Text></Pressable>
      </View>}
    </View>
  );
}
