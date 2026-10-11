// Whiteboard: boards that belong to a CLAN, a Course, a Study Session or Personal Space; their append-only operation
// log (ordered per board by `seq`, idempotent by op id) and periodic snapshots for fast loading. The editable board IS
// the op log + objects — never a picture. CLAN boards are keyed by CLAN id, so they survive hosting again; the host
// relay (@classroom/server whiteboard.ts) uses this store through a structural interface.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { applyOp, emptyBoard, replay, strip, tableSection, WbOp, type CheckpointProvider, type WbLogged, type WbState } from '@classroom/protocol';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Permissions, type Principal } from '../../core/permissions.ts';
import { SyncDefer, type SyncProvider } from '../../core/syncrows.ts';

export const schema: ModuleSchema = {
  module: 'whiteboard', prefix: 'wb',
  migrations: [`
    CREATE TABLE wb_boards (id TEXT PRIMARY KEY, owner_kind TEXT NOT NULL CHECK (owner_kind IN ('clan','course','session','personal')), owner_id TEXT NOT NULL,
      title TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, head_seq INTEGER NOT NULL DEFAULT 0,
      member_edit INTEGER NOT NULL DEFAULT 0, archived_at INTEGER);
    CREATE INDEX wb_boards_owner ON wb_boards(owner_kind, owner_id);
    CREATE TABLE wb_ops (board_id TEXT NOT NULL REFERENCES wb_boards(id), seq INTEGER NOT NULL, op_id TEXT NOT NULL, author TEXT NOT NULL, at INTEGER NOT NULL, op TEXT NOT NULL,
      PRIMARY KEY (board_id, seq), UNIQUE (board_id, op_id));
    -- compacted state at a seq (rebuildable from the log); loading = snapshot + the ops after it
    CREATE TABLE wb_snapshots (board_id TEXT PRIMARY KEY REFERENCES wb_boards(id), seq INTEGER NOT NULL, objects TEXT NOT NULL, at INTEGER NOT NULL);
  `],
};

export const BoardChanged = defineEvent('BoardChanged', 1, z.object({ boardId: z.string(), ownerKind: z.string(), ownerId: z.string() }));
export type BoardOwner = { kind: 'clan' | 'course' | 'session' | 'personal'; id: string };
export type Board = { id: string; owner: BoardOwner; title: string; headSeq: number; memberEdit: boolean; updatedAt: number };
type Row = { id: string; owner_kind: BoardOwner['kind']; owner_id: string; title: string; head_seq: number; member_edit: number; updated_at: number };
const toBoard = (r: Row): Board => ({ id: r.id, owner: { kind: r.owner_kind, id: r.owner_id }, title: r.title, headSeq: r.head_seq, memberEdit: !!r.member_edit, updatedAt: r.updated_at });
const SNAPSHOT_EVERY = 500;
const MAX_CATCHUP = 2000;

export class Whiteboard {
  private db: Db; private bus: EventBus; private perms: Permissions; private courseOwner: (courseId: string) => string | null; private sessionOwner: (sessionId: string) => string | null; private now: () => number;
  constructor(db: Db, bus: EventBus, perms: Permissions, o: { courseOwner(id: string): string | null; sessionOwner(id: string): string | null }, now = () => Date.now()) {
    this.db = db; this.bus = bus; this.perms = perms; this.courseOwner = o.courseOwner; this.sessionOwner = o.sessionOwner; this.now = now;
  }

  /** Personal sync: personal and course boards. Boards merge (union of ops by op id; the reducer converges), so
   *  drawing on two devices while apart keeps both. CLAN boards stay with the CLAN host and never sync. */
  syncProviders(): SyncProvider[] {
    type B = Row & { created_at: number; archived_at: number | null };
    const mine = (owner: string, b: Pick<B, 'owner_kind' | 'owner_id'>) => b.owner_kind === 'personal' ? b.owner_id === owner : b.owner_kind === 'course' && this.courseOwner(b.owner_id) === owner;
    const wire = (b: B) => ({ archived_at: b.archived_at, created_at: b.created_at, owner_id: b.owner_kind === 'personal' ? null : b.owner_id, owner_kind: b.owner_kind, title: b.title,
      ops: (this.db.prepare('SELECT op FROM wb_ops WHERE board_id = ? ORDER BY op_id').all(b.id) as { op: string }[]).map((r) => JSON.parse(r.op) as unknown) });
    const In = z.object({ archived_at: z.number().int().nullable(), created_at: z.number().int(), owner_id: z.string().max(80).nullable(), owner_kind: z.enum(['personal', 'course']), title: z.string().trim().min(1).max(120), ops: z.array(z.unknown()).max(200_000) });
    const get = (id: string) => this.db.prepare("SELECT * FROM wb_boards WHERE id = ? AND owner_kind IN ('personal','course')").get(id) as B | undefined;
    return [{ kind: 'board', policy: 'union',
      all: (owner) => new Map((this.db.prepare("SELECT * FROM wb_boards WHERE owner_kind IN ('personal','course')").all() as B[]).filter((b) => mine(owner, b)).map((b) => [b.id, wire(b)])),
      one: (owner, id) => { const b = get(id); return b && mine(owner, b) ? wire(b) : null; },
      apply: (owner, id, payload, o) => tx(this.db, () => {
        const cur = this.db.prepare('SELECT * FROM wb_boards WHERE id = ?').get(id) as B | undefined;
        if (cur && !mine(owner, cur)) throw new Error('That board belongs to someone else.');
        if (payload === null) { if (cur) this.purgeBoard(id); return; }
        const b = In.parse(payload), ownerId = b.owner_kind === 'personal' ? owner : b.owner_id ?? '';
        if (b.owner_kind === 'course' && this.courseOwner(ownerId) !== owner) throw new SyncDefer('course not here yet');
        if (!cur) this.db.prepare('INSERT INTO wb_boards (id, owner_kind, owner_id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, b.owner_kind, ownerId, b.title, owner, b.created_at, b.created_at);
        else if (!o.merge) this.db.prepare('UPDATE wb_boards SET title = ?, archived_at = NULL WHERE id = ?').run(b.title, id);
        else this.db.prepare('UPDATE wb_boards SET archived_at = NULL WHERE id = ?').run(id);
        this.append(id, owner, b.ops); // duplicates (same op id) are skipped
        const archived = o.merge && cur ? cur.archived_at ?? b.archived_at : b.archived_at;
        if (archived) this.db.prepare('UPDATE wb_boards SET archived_at = ? WHERE id = ?').run(archived, id);
      }) }];
  }
  private purgeBoard(id: string) { this.db.prepare('DELETE FROM wb_ops WHERE board_id = ?').run(id); this.db.prepare('DELETE FROM wb_snapshots WHERE board_id = ?').run(id); this.db.prepare('DELETE FROM wb_boards WHERE id = ?').run(id); }
  private row(id: string) { return this.db.prepare('SELECT * FROM wb_boards WHERE id = ? AND archived_at IS NULL').get(id) as Row | undefined; }

  // ---- host side (structural WhiteboardStore for the relay; the relay has already authorized the principal) ----
  /** The CLAN's board (one per CLAN, created on first use), or a specific one. */
  boardFor(clanId: string, title = 'CLAN board'): Board {
    const r = this.db.prepare("SELECT * FROM wb_boards WHERE owner_kind = 'clan' AND owner_id = ? AND archived_at IS NULL ORDER BY created_at LIMIT 1").get(clanId) as Row | undefined;
    if (r) return toBoard(r);
    const id = randomUUID(), t = this.now();
    this.db.prepare("INSERT INTO wb_boards (id, owner_kind, owner_id, title, created_by, created_at, updated_at) VALUES (?, 'clan', ?, ?, 'host', ?, ?)").run(id, clanId, title.slice(0, 120), t, t);
    return toBoard(this.row(id)!);
  }
  /** Appends ops in one transaction; duplicates (same op id) are skipped. Returns only the newly logged ops. */
  private hostGate: (clanId: string) => string | null = () => null;
  /** Persistent hosting: a reason this device may not make authoritative writes to a CLAN (paused, handed over, conflicted
   *  or revoked host), or null. Member-side caching is never gated. */
  guardHostWrites(f: (clanId: string) => string | null) { this.hostGate = f; }
  private hostWrite(b: { owner_kind: string; owner_id: string }) { const why = b.owner_kind === 'clan' ? this.hostGate(b.owner_id) : null; if (why) throw new Error(why); }

  append(boardId: string, author: string, raw: unknown[]): WbLogged[] {
    const ops = raw.map((o) => WbOp.parse(o));
    return tx(this.db, () => {
      const b = this.row(boardId); if (!b) throw new Error('Board not found.');
      this.hostWrite(b);
      let seq = b.head_seq; const t = this.now(), out: WbLogged[] = [];
      const ins = this.db.prepare('INSERT OR IGNORE INTO wb_ops (board_id, seq, op_id, author, at, op) VALUES (?, ?, ?, ?, ?, ?)');
      for (const op of ops) { if (ins.run(boardId, seq + 1, op.id, author, t, JSON.stringify(op)).changes) { seq++; out.push({ seq, author, at: t, op }); } }
      if (out.length) {
        this.db.prepare('UPDATE wb_boards SET head_seq = ?, updated_at = ? WHERE id = ?').run(seq, t, boardId);
        const snap = this.db.prepare('SELECT seq FROM wb_snapshots WHERE board_id = ?').get(boardId) as { seq: number } | undefined;
        if (seq - (snap?.seq ?? 0) >= SNAPSHOT_EVERY) this.snapshot(boardId);
        this.bus.publish(BoardChanged, 'whiteboard', { boardId, ownerKind: b.owner_kind, ownerId: b.owner_id });
      }
      return out;
    });
  }
  /** Ops after `since`, or — when far behind / from scratch — a compact snapshot (one put per live object) + head. */
  since(boardId: string, since: number): { ops: WbLogged[]; snapshot: boolean; head: number } {
    const b = this.row(boardId); if (!b) throw new Error('Board not found.');
    if (since > 0 && b.head_seq - since <= MAX_CATCHUP) return { ops: this.tail(boardId, since), snapshot: false, head: b.head_seq };
    const s = this.state(boardId);
    let clock = 0;
    const ops: WbLogged[] = [...s.objects.values()].filter((o) => !o.deleted && o.pv).map((o) => ({ seq: b.head_seq, author: o.v.author, at: 0, op: { t: 'put' as const, id: o.v.op, obj: o.id, clock: (clock = Math.max(clock, o.v.clock), o.v.clock), data: strip(o) } }));
    return { ops, snapshot: true, head: b.head_seq };
  }
  private tail(boardId: string, since: number) {
    return (this.db.prepare('SELECT seq, author, at, op FROM wb_ops WHERE board_id = ? AND seq > ? ORDER BY seq').all(boardId, since) as { seq: number; author: string; at: number; op: string }[])
      .map((r) => ({ seq: r.seq, author: r.author, at: r.at, op: JSON.parse(r.op) as WbOp }));
  }
  /** Current state = latest snapshot + the ops after it. */
  state(boardId: string): WbState {
    const snap = this.db.prepare('SELECT seq, objects FROM wb_snapshots WHERE board_id = ?').get(boardId) as { seq: number; objects: string } | undefined;
    const s = emptyBoard();
    if (snap) { for (const o of JSON.parse(snap.objects) as WbState['objects'] extends Map<string, infer V> ? V[] : never) s.objects.set(o.id, o); s.seq = snap.seq; }
    return replay(this.tail(boardId, snap?.seq ?? 0), s);
  }
  private snapshot(boardId: string) {
    const s = this.state(boardId);
    this.db.prepare('INSERT INTO wb_snapshots (board_id, seq, objects, at) VALUES (?, ?, ?, ?) ON CONFLICT (board_id) DO UPDATE SET seq = excluded.seq, objects = excluded.objects, at = excluded.at')
      .run(boardId, s.seq, JSON.stringify([...s.objects.values()]), this.now());
  }
  memberEdit(boardId: string) { return !!this.row(boardId)?.member_edit; }
  setMemberEdit(boardId: string, on: boolean) { const b = this.row(boardId); if (b) this.hostWrite(b); this.db.prepare('UPDATE wb_boards SET member_edit = ? WHERE id = ?').run(on ? 1 : 0, boardId); }
  /** Temporary CLAN ended: its boards go with it (retention rule for Temporary CLANs). */
  /** Persistent hosting: the CLAN's boards with their full op log and snapshots (never personal/course boards). */
  checkpointProvider(): CheckpointProvider {
    const BOARDS = "board_id IN (SELECT id FROM wb_boards WHERE owner_kind = 'clan' AND owner_id = ?)";
    const rows = tableSection(this.db, [
      { table: 'wb_boards', where: "owner_kind = 'clan' AND owner_id = ?", scope: { owner_id: 'clan', owner_kind: (v) => v === 'clan' } },
      { table: 'wb_ops', where: BOARDS, scope: { board_id: { table: 'wb_boards', column: 'id' } } },
      { table: 'wb_snapshots', where: BOARDS, scope: { board_id: { table: 'wb_boards', column: 'id' } } },
    ]);
    return { section: 'whiteboard', export: (clanId) => ({ rows: rows.export(clanId), files: [] }), validate: (clanId, raw) => { rows.validate(clanId, raw); return []; }, import: (clanId, raw) => rows.import(clanId, raw) };
  }

  purgeOwner(kind: BoardOwner['kind'], id: string) {
    tx(this.db, () => {
      for (const b of this.db.prepare('SELECT id FROM wb_boards WHERE owner_kind = ? AND owner_id = ?').all(kind, id) as { id: string }[]) {
        this.db.prepare('DELETE FROM wb_ops WHERE board_id = ?').run(b.id); this.db.prepare('DELETE FROM wb_snapshots WHERE board_id = ?').run(b.id); this.db.prepare('DELETE FROM wb_boards WHERE id = ?').run(b.id);
      }
    });
  }

  // ---- this device's person (Personal / Course / Study Session boards, and reading CLAN boards kept on this device) ----
  /** May `p` use this board? Personal/course/session: only their owner. CLAN: active members. */
  may(p: Principal, b: Board) {
    if (p.kind === 'agent') return false; // AI never edits or reads boards directly
    const u = userOf(p);
    if (b.owner.kind === 'personal') return b.owner.id === u;
    if (b.owner.kind === 'course') return this.courseOwner(b.owner.id) === u;
    if (b.owner.kind === 'session') return this.sessionOwner(b.owner.id) === u;
    return this.perms.canRead(p, { kind: 'clan', clanId: b.owner.id });
  }
  get(p: Principal, id: string) { const r = this.row(id); const b = r && toBoard(r); return b && this.may(p, b) ? b : null; }
  list(p: Principal, owner: BoardOwner) { return (this.db.prepare('SELECT * FROM wb_boards WHERE owner_kind = ? AND owner_id = ? AND archived_at IS NULL ORDER BY updated_at DESC LIMIT 100').all(owner.kind, owner.id) as Row[]).map(toBoard).filter((b) => this.may(p, b)); }
  create(p: Principal, owner: BoardOwner, title: string): Board {
    if (p.kind !== 'user') throw new Error('Only you can create a board.');
    if (owner.kind === 'clan') throw new Error('CLAN boards live with the CLAN’s host.');
    const probe: Board = { id: '', owner, title, headSeq: 0, memberEdit: false, updatedAt: 0 };
    if (!this.may(p, probe)) throw new Error('Not found.');
    const id = randomUUID(), t = this.now();
    this.db.prepare('INSERT INTO wb_boards (id, owner_kind, owner_id, title, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, owner.kind, owner.id, z.string().trim().min(1).max(120).parse(title), p.userId, t, t);
    this.bus.publish(BoardChanged, 'whiteboard', { boardId: id, ownerKind: owner.kind, ownerId: owner.id });
    return toBoard(this.row(id)!);
  }
  /** Local boards: the owner's edits go straight into the same log (author = the person). */
  edit(p: Principal, boardId: string, ops: unknown[]) {
    const b = this.get(p, boardId);
    if (!b || p.kind !== 'user' || b.owner.kind === 'clan') throw new Error('Not found.');
    return this.append(boardId, p.userId, ops);
  }
  read(p: Principal, boardId: string, since = 0) { if (!this.get(p, boardId)) throw new Error('Not found.'); return this.since(boardId, since); }
  rename(p: Principal, boardId: string, title: string) { if (!this.get(p, boardId)) throw new Error('Not found.'); this.db.prepare('UPDATE wb_boards SET title = ? WHERE id = ?').run(z.string().trim().min(1).max(120).parse(title), boardId); }
  remove(p: Principal, boardId: string) { const b = this.get(p, boardId); if (!b || b.owner.kind === 'clan') throw new Error('Not found.'); this.db.prepare('UPDATE wb_boards SET archived_at = ? WHERE id = ?').run(this.now(), boardId); }
  /** Applies ops to a state the caller holds (renderers do this too); exported for symmetry with the protocol reducer. */
  static apply(s: WbState, l: WbLogged) { return applyOp(s, l.author, l.op, l.seq); }
}
