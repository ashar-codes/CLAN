// Host-side whiteboard relay: authorizes every whiteboard action against the live session, stores ops through the
// injected store (@clan/core modules/whiteboard, keyed by CLAN — so the board survives hosting again), orders them
// (seq) and decides who receives them. It also owns the room wall: DEFAULT, SCREEN_SHARE (a presentation) or
// WHITEBOARD — never two at once; switching away from a presentation needs an explicit takeover by someone allowed.
import { WbOp, type WallMode, type WbBoardView, type WbLogged } from '@classroom/protocol';
import type { Classroom, Principal } from './classroom.ts';
import type { Presentations } from './presentation.ts';
import type { Resources } from './resources.ts';
import { ApiError, RateLimit } from './storage.ts';

/** The subset of @clan/core's Whiteboard the host needs (structural, so the server does not depend on @clan/core). */
export type WhiteboardStore = {
  boardFor(clanId: string, title?: string): { id: string; title: string; headSeq: number; memberEdit: boolean };
  append(boardId: string, author: string, ops: unknown[]): WbLogged[];
  since(boardId: string, since: number): { ops: WbLogged[]; snapshot: boolean; head: number };
  memberEdit(boardId: string): boolean;
  setMemberEdit(boardId: string, on: boolean): void;
};

export class WhiteboardRelay {
  wall: 'DEFAULT' | 'WHITEBOARD' = 'DEFAULT';
  wallBy: string | null = null;
  readonly boardId: string; readonly title: string;
  private store: WhiteboardStore; private classroom: Classroom; private resources: Resources; private presentations: Presentations;
  private author: (p: Principal) => string; private name: (p: Principal) => string;
  private opRate = new RateLimit(60, 1000);
  private cursorRate = new RateLimit(20, 1000);

  constructor(o: { store: WhiteboardStore; classroom: Classroom; resources: Resources; presentations: Presentations; author(p: Principal): string; name(p: Principal): string }) {
    this.store = o.store; this.classroom = o.classroom; this.resources = o.resources; this.presentations = o.presentations; this.author = o.author; this.name = o.name;
    const b = this.store.boardFor(o.classroom.clan.id ?? o.classroom.id, `${o.classroom.title} board`);
    this.boardId = b.id; this.title = b.title;
  }
  private approved(p: Principal) { return p.role === 'teacher' || this.classroom.status(p.memberId) === 'approved'; }
  canView(p: Principal) { return this.approved(p) && this.classroom.can(p, 'VIEW_WHITEBOARD'); }
  canManage(p: Principal) { return this.approved(p) && this.classroom.can(p, 'MANAGE_WHITEBOARD'); }
  /** EDIT by capability, or — where members only view by default (Classroom) — when the host switched member editing on. */
  canEdit(p: Principal) { return this.canView(p) && (this.classroom.can(p, 'EDIT_WHITEBOARD') || (p.role === 'student' && this.store.memberEdit(this.boardId))); }
  wallMode(): WallMode { return this.presentations.current ? 'SCREEN_SHARE' : this.wall; }
  view(p: Principal): WbBoardView {
    return { id: this.boardId, title: this.title, headSeq: this.store.since(this.boardId, Number.MAX_SAFE_INTEGER).head, wall: this.wallMode(), canEdit: this.canEdit(p), canManage: this.canManage(p), memberEdit: this.store.memberEdit(this.boardId) };
  }

  sync(p: Principal, since: number) {
    if (!this.canView(p)) throw new ApiError(403, 'forbidden', 'You cannot see this board.');
    const r = this.store.since(this.boardId, since);
    return { board: this.view(p), ops: r.ops, snapshot: r.snapshot };
  }
  /** Validates and appends; resource references must point at a file on this CLAN's table (never a private one). */
  ops(p: Principal, raw: unknown[]): WbLogged[] {
    if (!this.canEdit(p)) throw new ApiError(403, 'forbidden', 'You can view this board but not edit it.');
    if (!this.opRate.take(`${p.role}:${(p as { memberId?: string }).memberId ?? 'host'}`)) throw new ApiError(429, 'rate', 'Too many whiteboard changes at once.');
    const ops = raw.map((o) => WbOp.parse(o));
    const table = new Map(this.resources.listForStudent().map((r) => [r.id, r]));
    for (const op of ops) {
      const ref = op.t === 'del' ? undefined : op.data.ref;
      if (ref?.module === 'resource' && !table.has(ref.id)) throw new ApiError(403, 'not_shared', 'Put the file on the table first; only shared files can be placed on the board.');
      if (ref?.module === 'files') throw new ApiError(403, 'not_shared', 'Personal files cannot be placed on a CLAN board.');
    }
    return this.store.append(this.boardId, this.author(p), ops);
  }
  cursor(p: Principal) { return this.canEdit(p) && this.cursorRate.take(this.author(p)) ? { who: this.author(p), name: this.name(p) } : null; }
  setMemberEdit(p: Principal, on: boolean) {
    if (!this.canManage(p)) throw new ApiError(403, 'forbidden', 'Only the host can change who edits the board.');
    this.store.setMemberEdit(this.boardId, on);
  }
  /**
   * Room wall. Whiteboard on: needs EDIT (or MANAGE). If someone is presenting, it needs an explicit takeover by a board
   * manager — or the presenter themselves — and stops that presentation cleanly (membership is untouched).
   */
  async setWall(p: Principal, mode: 'WHITEBOARD' | 'DEFAULT', takeover = false) {
    if (mode === 'DEFAULT') { if (!this.canManage(p) && this.wallBy !== this.author(p)) throw new ApiError(403, 'forbidden', 'Only the host can take the board off the wall.'); this.wall = 'DEFAULT'; this.wallBy = null; return; }
    if (!this.canEdit(p) && !this.canManage(p)) throw new ApiError(403, 'forbidden', 'You cannot put the board on the wall.');
    const cur = this.presentations.current;
    if (cur) {
      const own = cur.identity === (p.role === 'teacher' ? 'host' : p.memberId);
      if (!takeover) throw new ApiError(409, 'presenting', `${cur.presenterName} is presenting`);
      if (!own && !this.canManage(p)) throw new ApiError(403, 'forbidden', `Ask the host to switch from ${cur.presenterName}’s screen.`);
      await this.presentations.stop('switched_to_whiteboard');
    }
    this.wall = 'WHITEBOARD'; this.wallBy = this.author(p);
  }
  /** A presentation is starting: the wall leaves whiteboard mode only by explicit takeover of someone allowed. */
  beforePresent(p: Principal, takeover: boolean) {
    if (this.wall !== 'WHITEBOARD') return;
    if (!takeover) throw new ApiError(409, 'whiteboard', 'The whiteboard is on the wall.');
    if (!this.canManage(p) && !this.classroom.can(p, 'MANAGE_PRESENTERS') && this.wallBy !== this.author(p)) throw new ApiError(403, 'forbidden', 'Ask the host to switch the wall.');
    this.wall = 'DEFAULT'; this.wallBy = null;
  }
}
