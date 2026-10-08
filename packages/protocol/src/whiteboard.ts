// Collaborative whiteboard: the object model, the operation format and the one reducer every device runs (host store,
// desktop, phone). Model: an LWW element map — each object is a register keyed by id; an operation sets or patches it,
// or tombstones it, ordered by (clock, author, op id). Ops are small, idempotent (op id), replayable in any order, and the
// host additionally assigns a gap-free `seq` per board so clients can resume from "everything after seq N".
import { z } from 'zod';

export const WB_KINDS = ['stroke', 'line', 'arrow', 'rect', 'ellipse', 'text', 'sticky', 'resource', 'note', 'link'] as const;
export type WbKind = (typeof WB_KINDS)[number];
const N = z.number().finite().min(-1e6).max(1e6);
const Pt = z.tuple([N, N]);
/** One board object. Strokes keep their points relative to (x, y); everything else is a box. */
export const WbObjectData = z.object({
  kind: z.enum(WB_KINDS), page: z.number().int().min(0).max(99).default(0),
  x: N, y: N, w: N.default(0), h: N.default(0),
  points: z.array(Pt).max(4000).optional(), pressure: z.array(z.number().min(0).max(1)).max(4000).optional(),
  color: z.string().regex(/^#[0-9a-f]{6}$/i).default('#17233b'), width: z.number().min(0.5).max(80).default(3), highlighter: z.boolean().optional(),
  text: z.string().max(4000).optional(), fill: z.string().regex(/^#[0-9a-f]{6}$/i).optional(),
  /** Canonical references only (a CLAN resource id, a note/saved id); never file bytes. */
  ref: z.object({ module: z.enum(['resource', 'files', 'notes', 'saved']), id: z.string().min(1).max(64), title: z.string().max(200), mime: z.string().max(120).optional(), url: z.string().max(2048).optional() }).optional(),
  z: z.number().default(0),
});
export type WbObjectData = z.infer<typeof WbObjectData>;
export const WbPatch = WbObjectData.partial().omit({ kind: true });

export const WbOp = z.discriminatedUnion('t', [
  z.object({ t: z.literal('put'), id: z.uuid(), obj: z.uuid(), clock: z.number().int().min(0), data: WbObjectData }),
  z.object({ t: z.literal('patch'), id: z.uuid(), obj: z.uuid(), clock: z.number().int().min(0), data: WbPatch }),
  z.object({ t: z.literal('del'), id: z.uuid(), obj: z.uuid(), clock: z.number().int().min(0) }),
  /** Re-creates a deleted object (undo of a delete); same as put but explicit for readability. */
  z.object({ t: z.literal('restore'), id: z.uuid(), obj: z.uuid(), clock: z.number().int().min(0), data: WbObjectData }),
]);
export type WbOp = z.infer<typeof WbOp>;
/** An op as stored/delivered: who sent it and where the host put it in the board's order. */
export type WbLogged = { seq: number; author: string; at: number; op: WbOp };

type Ver = { clock: number; author: string; op: string };
/**
 * `fv` = version of each field (per-field last-writer-wins), `v` = newest version seen, `pv` = last put/restore,
 * `dv` = last delete. Visible iff it was put and no newer delete exists.
 */
export type WbObject = WbObjectData & { id: string; deleted: boolean; v: Ver; pv: Ver | null; dv: Ver | null; fv: Record<string, Ver> };
export type WbState = { objects: Map<string, WbObject>; seen: Set<string>; clock: number; seq: number };
export const emptyBoard = (): WbState => ({ objects: new Map(), seen: new Set(), clock: 0, seq: 0 });

const newer = (a: Ver | null | undefined, b: Ver) => !a || b.clock > a.clock || (b.clock === a.clock && (b.author > a.author || (b.author === a.author && b.op > a.op)));
const BLANK: WbObjectData = { kind: 'stroke', page: 0, x: 0, y: 0, w: 0, h: 0, color: '#000000', width: 1, z: 0 };

/**
 * Applies one op. Idempotent (an op id applies once) and fully order-independent: every field is its own LWW register
 * ordered by (clock, author, op id), and visibility compares only the latest put/restore with the latest delete — so a
 * patch can never resurrect or block a delete, and every device converges whatever the arrival order.
 */
export function applyOp(s: WbState, author: string, op: WbOp, seq?: number): boolean {
  if (seq !== undefined && seq > s.seq) s.seq = seq;
  if (s.seen.has(op.id)) return false;
  s.seen.add(op.id);
  s.clock = Math.max(s.clock, op.clock);
  const v: Ver = { clock: op.clock, author, op: op.id };
  const o: WbObject = s.objects.get(op.obj) ?? { ...BLANK, id: op.obj, deleted: true, v, pv: null, dv: null, fv: {} };
  const next: WbObject = { ...o, fv: { ...o.fv } };
  if (op.t !== 'del') for (const [k, val] of Object.entries(op.data)) {
    if (val === undefined || !newer(next.fv[k], v)) continue;
    (next as Record<string, unknown>)[k] = val; next.fv[k] = v;
  }
  if ((op.t === 'put' || op.t === 'restore') && newer(next.pv, v)) next.pv = v;
  if (op.t === 'del' && newer(next.dv, v)) next.dv = v;
  if (newer(next.v, v)) next.v = v;
  next.deleted = !next.pv || (!!next.dv && newer(next.pv, next.dv));
  s.objects.set(op.obj, next);
  return true;
}
export function replay(log: WbLogged[], s = emptyBoard()) { for (const l of [...log].sort((a, b) => a.seq - b.seq)) applyOp(s, l.author, l.op, l.seq); return s; }
export const visible = (s: WbState, page = 0) => [...s.objects.values()].filter((o) => !o.deleted && o.page === page).sort((a, b) => a.z - b.z || (a.v.clock - b.v.clock));

/** The inverse of an op given the object as it was before (local undo). */
export function inverse(before: WbObject | undefined, op: WbOp, clock: number, id: string): WbOp | null {
  const base = before ? strip(before) : null;
  if (op.t === 'put' || op.t === 'restore') return before && !before.deleted ? { t: 'put', id, obj: op.obj, clock, data: base! } : { t: 'del', id, obj: op.obj, clock };
  if (op.t === 'patch') return before && !before.deleted ? { t: 'patch', id, obj: op.obj, clock, data: Object.fromEntries(Object.keys(op.data).map((k) => [k, (before as Record<string, unknown>)[k]])) as never } : null;
  return before && !before.deleted ? { t: 'restore', id, obj: op.obj, clock, data: base! } : null;
}
export const strip = (o: WbObject): WbObjectData => { const { id: _i, deleted: _d, v: _v, pv: _p, dv: _x, fv: _f, ...d } = o; return d; };

/** Bounding box of an object (for hit testing, selection and viewport culling). */
export function bounds(o: WbObjectData): { x: number; y: number; w: number; h: number } {
  if (o.points?.length) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [px, py] of o.points) { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); }
    const pad = o.width;
    return { x: o.x + x0 - pad, y: o.y + y0 - pad, w: x1 - x0 + 2 * pad, h: y1 - y0 + 2 * pad };
  }
  const x = Math.min(o.x, o.x + o.w), y = Math.min(o.y, o.y + o.h);
  return { x, y, w: Math.abs(o.w), h: Math.abs(o.h) };
}
export const intersects = (a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) => a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
/** Topmost visible object under a point (eraser, select). */
export function hit(s: WbState, page: number, x: number, y: number, slop = 6) {
  const objs = visible(s, page);
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i]!, b = bounds(o);
    if (!intersects(b, { x: x - slop, y: y - slop, w: 2 * slop, h: 2 * slop })) continue;
    if (!o.points?.length) return o;
    const r = slop + o.width;
    for (let k = 0; k < o.points.length; k++) {
      const [ax, ay] = o.points[k]!, [bx, by] = o.points[Math.min(k + 1, o.points.length - 1)]!;
      const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy, px = x - o.x, py = y - o.y;
      const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
      if (Math.hypot(px - (ax + t * dx), py - (ay + t * dy)) <= r) return o;
    }
  }
  return null;
}
/** Douglas–Peucker simplification keeps stroke ops small without visibly changing the line. */
export function simplify(pts: [number, number][], tol = 0.8): [number, number][] {
  if (pts.length < 3) return pts;
  const [a, b] = [pts[0]!, pts[pts.length - 1]!];
  let idx = -1, max = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!, dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy) || 1;
    const d = Math.abs(dy * p[0] - dx * p[1] + b[0] * a[1] - b[1] * a[0]) / len;
    if (d > max) { max = d; idx = i; }
  }
  return max > tol ? [...simplify(pts.slice(0, idx + 1), tol).slice(0, -1), ...simplify(pts.slice(idx), tol)] : [a, b];
}

// ---- wire (pinned WSS; host authority) ----
export const WALL_MODES = ['DEFAULT', 'SCREEN_SHARE', 'WHITEBOARD'] as const;
export type WallMode = (typeof WALL_MODES)[number];
export const WhiteboardClientMessage = [
  /** Resume the CLAN board from `since` (0 = full state). */
  z.object({ t: z.literal('wb.sync'), since: z.number().int().min(0) }),
  z.object({ t: z.literal('wb.ops'), ops: z.array(WbOp).min(1).max(200) }),
  z.object({ t: z.literal('wb.cursor'), x: N, y: N, page: z.number().int().min(0).max(99) }),
  /** Put the board on the room wall (or back to default). `takeover` confirms switching away from a presentation. */
  z.object({ t: z.literal('wb.wall'), mode: z.enum(['WHITEBOARD', 'DEFAULT']), takeover: z.boolean().optional() }),
  /** Classroom: the host lets members edit (or not). */
  z.object({ t: z.literal('wb.memberEdit'), on: z.boolean() }),
] as const;
export type WbBoardView = { id: string; title: string; headSeq: number; wall: WallMode; canEdit: boolean; canManage: boolean; memberEdit: boolean };
export type WhiteboardServerMessage =
  /** Either all ops after `since` or, if far behind, a compacted snapshot (`snapshot: true`, ops = one put per live object). */
  | { t: 'wb.state'; board: WbBoardView; ops: WbLogged[]; snapshot: boolean }
  | { t: 'wb.op'; ops: WbLogged[] }
  | { t: 'wb.ack'; ids: string[]; headSeq: number }
  | { t: 'wb.nack'; ids: string[]; code: string; message: string }
  | { t: 'wb.cursor'; who: string; name: string; x: number; y: number; page: number }
  | { t: 'wb.wall'; mode: WallMode; by: string | null; board: WbBoardView };

/** Transcription boundary (no provider ships in this phase; Study Tapes work fully without one). */
export type TranscriptSegment = { startMs: number; endMs: number; text: string; speaker?: string | null };
export interface TranscriptionProvider {
  readonly id: string; readonly label: string; readonly local: boolean;
  /** Called only after the student explicitly chose to transcribe this tape (and, for remote providers, saw the upload disclosure). */
  transcribe(audioPath: string, o: { language?: string; signal?: AbortSignal; onProgress?(f: number): void }): Promise<TranscriptSegment[]>;
}
