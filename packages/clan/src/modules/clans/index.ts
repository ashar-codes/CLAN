// CLANs: groups of people with a type. Behaviour is driven by capabilities, not by type checks elsewhere.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import type { MembershipQuery } from '../../core/permissions.ts';
import type { Identity } from '../../core/identity.ts';
import type { CheckpointProvider } from '@classroom/protocol';
import { importClassrooms, classroomSessions } from './classroom-import.ts';

export const CLAN_TYPES = ['CLASSROOM', 'STUDY_GROUP', 'PROJECT_TEAM', 'FRIENDS', 'TEMPORARY'] as const;
export type ClanType = (typeof CLAN_TYPES)[number];
export type Capability = 'files' | 'notes' | 'chat' | 'studyRoom' | 'screenShare' | 'assignments' | 'teacherAuthority' | 'expires';

/** The only place a type maps to behaviour. */
export const CAPABILITIES: Record<ClanType, readonly Capability[]> = {
  CLASSROOM: ['files', 'notes', 'chat', 'screenShare', 'assignments', 'teacherAuthority'],
  STUDY_GROUP: ['files', 'notes', 'chat', 'studyRoom', 'screenShare'],
  PROJECT_TEAM: ['files', 'notes', 'chat', 'studyRoom', 'screenShare'],
  FRIENDS: ['files', 'chat'],
  TEMPORARY: ['files', 'notes', 'chat', 'expires'],
};

export type Role = 'owner' | 'admin' | 'member';
export type Clan = { id: string; type: ClanType; name: string; createdBy: string; createdAt: number; expiresAt: number | null; archivedAt: number | null };
export type Membership = { clanId: string; userId: string; role: Role; status: 'active' | 'left' | 'removed'; joinedAt: number };

export const schema: ModuleSchema = {
  module: 'clans', prefix: 'clans',
  migrations: [`
    CREATE TABLE clans_clans (id TEXT PRIMARY KEY, type TEXT NOT NULL CHECK (type IN ('CLASSROOM','STUDY_GROUP','PROJECT_TEAM','FRIENDS','TEMPORARY')),
      name TEXT NOT NULL, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER, archived_at INTEGER,
      CHECK (type <> 'TEMPORARY' OR expires_at IS NOT NULL));
    CREATE TABLE clans_memberships (clan_id TEXT NOT NULL REFERENCES clans_clans(id), user_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('owner','admin','member')), status TEXT NOT NULL CHECK (status IN ('active','left','removed')),
      joined_at INTEGER NOT NULL, PRIMARY KEY (clan_id, user_id));
    CREATE INDEX clans_memberships_user ON clans_memberships(user_id, status);
    -- Classroom history stays in the classroom tables; these rows only link it (ids preserved).
    CREATE TABLE clans_classroom_sessions (session_id TEXT PRIMARY KEY, clan_id TEXT NOT NULL REFERENCES clans_clans(id));
    CREATE TABLE clans_classroom_members (member_id TEXT PRIMARY KEY, clan_id TEXT NOT NULL REFERENCES clans_clans(id), user_id TEXT NOT NULL);
  `, `
    -- Device-local presentation preference; never changes CLAN membership or host authorization.
    CREATE TABLE clans_local_preferences (clan_id TEXT NOT NULL REFERENCES clans_clans(id), user_id TEXT NOT NULL,
      archived_at INTEGER NOT NULL, PRIMARY KEY (clan_id, user_id));
  `, `
    -- Durable cleanup intent. Retain canonical identities so startup imports cannot recreate deleted authority.
    CREATE TABLE clans_cleanup (clan_id TEXT PRIMARY KEY REFERENCES clans_clans(id), user_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('remove','delete')), requested_at INTEGER NOT NULL, completed_at INTEGER,
      object_ids TEXT NOT NULL DEFAULT '[]');
  `, `
    -- Authenticated member-side routes may outlive paired transport receipts. No server table dependency.
    CREATE TABLE clans_local_sessions (session_id TEXT PRIMARY KEY, clan_id TEXT NOT NULL REFERENCES clans_clans(id), user_id TEXT NOT NULL);
  `],
};

export const CLANCreated = defineEvent('CLANCreated', 1, z.object({ clanId: z.string(), type: z.enum(CLAN_TYPES), createdBy: z.string(), importedFrom: z.literal('classroom').optional() }));
export const MemberJoined = defineEvent('MemberJoined', 1, z.object({ clanId: z.string(), userId: z.string(), role: z.enum(['owner', 'admin', 'member']) }));

type Raw = { id: string; type: ClanType; name: string; created_by: string; created_at: number; expires_at: number | null; archived_at: number | null };
const toClan = (r: Raw): Clan => ({ id: r.id, type: r.type, name: r.name, createdBy: r.created_by, createdAt: r.created_at, expiresAt: r.expires_at, archivedAt: r.archived_at });

export class Clans implements MembershipQuery {
  private db: Db; private bus: EventBus; private identity: Identity; private now: () => number;
  constructor(db: Db, bus: EventBus, identity: Identity, now = () => Date.now()) { this.db = db; this.bus = bus; this.identity = identity; this.now = now; }

  create(o: { type: ClanType; name: string; createdBy: string; expiresAt?: number; id?: string; importedFrom?: 'classroom'; createdAt?: number }): Clan {
    const type = z.enum(CLAN_TYPES).parse(o.type);
    const name = z.string().trim().min(1).max(80).parse(o.name);
    const expiresAt = CAPABILITIES[type].includes('expires') ? z.number().int().positive().parse(o.expiresAt) : null;
    const c: Clan = { id: o.id ?? randomUUID(), type, name, createdBy: o.createdBy, createdAt: o.createdAt ?? this.now(), expiresAt, archivedAt: null };
    return tx(this.db, () => {
      this.db.prepare('INSERT INTO clans_clans (id, type, name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(c.id, c.type, c.name, c.createdBy, c.createdAt, c.expiresAt);
      this.bus.publish(CLANCreated, 'clans', { clanId: c.id, type: c.type, createdBy: c.createdBy, ...(o.importedFrom ? { importedFrom: o.importedFrom } : {}) });
      this.addMember(c.id, c.createdBy, 'owner', c.createdAt);
      return c;
    });
  }

  get(id: string) { const r = this.db.prepare('SELECT * FROM clans_clans WHERE id = ?').get(id) as Raw | undefined; return r && toClan(r); }
  has(clanId: string, cap: Capability) { const c = this.get(clanId); return !!c && !this.cleanup(clanId) && CAPABILITIES[c.type].includes(cap); }

  /** CLANs the user is an active member of (expired TEMPORARY CLANs drop out). */
  list(userId: string, options: { archived?: boolean; includeArchived?: boolean } = {}): Clan[] {
    return (this.db.prepare(`SELECT c.* FROM clans_clans c JOIN clans_memberships m ON m.clan_id = c.id
      WHERE m.user_id = ? AND m.status = 'active' AND c.archived_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?)
      AND NOT EXISTS (SELECT 1 FROM clans_cleanup x WHERE x.clan_id = c.id)
      ${options.includeArchived ? '' : `AND ${options.archived ? '' : 'NOT'} EXISTS (SELECT 1 FROM clans_local_preferences p WHERE p.clan_id = c.id AND p.user_id = m.user_id)`}
      ORDER BY c.created_at DESC`)
      .all(userId, this.now()) as Raw[]).map(toClan);
  }
  members(clanId: string) {
    return (this.db.prepare('SELECT clan_id clanId, user_id userId, role, status, joined_at joinedAt FROM clans_memberships WHERE clan_id = ? ORDER BY joined_at').all(clanId) as Membership[])
      .map((m) => ({ ...m, displayName: this.identity.displayName(m.userId) }));
  }
  /** Local metadata for cleanup after leave/expiry. This never restores permission to read the CLAN's content. */
  storedCopies(userId: string): (Clan & { mine: boolean })[] {
    return (this.db.prepare(`SELECT c.*, m.role FROM clans_clans c JOIN clans_memberships m ON m.clan_id = c.id
      WHERE m.user_id = ? AND NOT EXISTS (SELECT 1 FROM clans_cleanup x WHERE x.clan_id = c.id) ORDER BY c.created_at DESC`).all(userId) as (Raw & { role: Role })[])
      .map((r) => ({ ...toClan(r), mine: r.role === 'owner' }));
  }

  addMember(clanId: string, userId: string, role: Role = 'member', joinedAt = this.now()) {
    if (this.cleanup(clanId)) throw new Error('This CLAN copy is removed or awaiting cleanup.');
    const r = this.db.prepare(`INSERT INTO clans_memberships (clan_id, user_id, role, status, joined_at) VALUES (?, ?, ?, 'active', ?)
      ON CONFLICT DO UPDATE SET status = 'active' WHERE status <> 'active'`).run(clanId, userId, role, joinedAt);
    if (r.changes) this.bus.publish(MemberJoined, 'clans', { clanId, userId, role });
  }
  /** Destination of a hosting hand-over that has never seen the CLAN: a bare record without membership (invisible in
   *  lists) so authority/staging rows can reference it. The verified checkpoint import fills in the canonical record. */
  ensureKnown(o: { id: string; type: ClanType; name: string; expiresAt: number | null; createdBy: string }) {
    if (this.get(o.id)) return;
    const type = z.enum(CLAN_TYPES).parse(o.type), name = z.string().trim().min(1).max(80).parse(o.name);
    this.db.prepare('INSERT INTO clans_clans (id, type, name, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)').run(z.string().uuid().parse(o.id), type, name, o.createdBy, this.now(), type === 'TEMPORARY' ? z.number().int().positive().parse(o.expiresAt) : null);
  }

  /** Persistent hosting: the canonical CLAN record and its hosted-session links. The destination is the owner's own
   *  linked device (enforced by the hosting module), so its local user becomes the active owner. */
  checkpointProvider(): CheckpointProvider {
    const Row = z.discriminatedUnion('t', [
      z.object({ t: z.literal('clan'), id: z.string().uuid(), type: z.enum(CLAN_TYPES), name: z.string().trim().min(1).max(80), createdAt: z.number().int(), expiresAt: z.number().int().nullable(), archivedAt: z.number().int().nullable() }).strict(),
      z.object({ t: z.literal('session'), sessionId: z.string().uuid() }).strict(),
    ]);
    const parse = (clanId: string, raw: unknown[]) => {
      const rows = z.array(Row).max(100_000).parse(raw);
      const c = rows.filter((r) => r.t === 'clan');
      if (c.length !== 1 || c[0]!.id !== clanId) throw new Error('Checkpoint must carry exactly this CLAN.');
      return { clan: c[0] as Extract<z.infer<typeof Row>, { t: 'clan' }>, sessions: rows.filter((r) => r.t === 'session').map((r) => (r as { sessionId: string }).sessionId) };
    };
    return {
      section: 'clans',
      export: (clanId) => {
        const c = this.get(clanId);
        if (!c) throw new Error('Unknown CLAN.');
        return { rows: [{ t: 'clan', id: c.id, type: c.type, name: c.name, createdAt: c.createdAt, expiresAt: c.expiresAt, archivedAt: c.archivedAt }, ...this.sessionsOf(clanId).map((sessionId) => ({ t: 'session', sessionId }))], files: [] };
      },
      validate: (clanId, raw) => { parse(clanId, raw); return []; },
      import: (clanId, raw, ctx) => {
        const { clan, sessions } = parse(clanId, raw);
        const have = this.get(clanId);
        if (have && have.type !== clan.type) throw new Error('CLAN type differs from the checkpoint.');
        if (!have) this.db.prepare('INSERT INTO clans_clans (id, type, name, created_by, created_at, expires_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(clan.id, clan.type, clan.name, ctx.me, clan.createdAt, clan.expiresAt, clan.archivedAt);
        else this.db.prepare('UPDATE clans_clans SET name = ?, expires_at = ?, archived_at = ? WHERE id = ?').run(clan.name, clan.expiresAt, clan.archivedAt, clanId);
        this.db.prepare(`INSERT INTO clans_memberships (clan_id, user_id, role, status, joined_at) VALUES (?, ?, 'owner', 'active', ?)
          ON CONFLICT DO UPDATE SET role = 'owner', status = 'active'`).run(clanId, ctx.me, this.now());
        for (const s of sessions) {
          const at = this.clanOfSession(s);
          if (at && at !== clanId) throw new Error('A checkpoint session belongs to another CLAN here.');
          if (!at) this.db.prepare('INSERT INTO clans_classroom_sessions (session_id, clan_id) VALUES (?, ?)').run(s, clanId);
        }
      },
    };
  }

  setStatus(clanId: string, userId: string, status: 'left' | 'removed') {
    this.db.prepare('UPDATE clans_memberships SET status = ? WHERE clan_id = ? AND user_id = ?').run(status, clanId, userId);
  }

  isActiveMember(clanId: string, userId: string) {
    return !!this.db.prepare(`SELECT 1 FROM clans_memberships m JOIN clans_clans c ON c.id = m.clan_id WHERE m.clan_id = ? AND m.user_id = ? AND m.status = 'active'
      AND c.archived_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > ?)
      AND NOT EXISTS (SELECT 1 FROM clans_cleanup x WHERE x.clan_id = c.id)`).get(clanId, userId, this.now());
  }
  clansOf(userId: string) { return this.list(userId, { includeArchived: true }).map((c) => c.id); }

  /** Local list preference only. Archived CLANs remain readable and can be restored. */
  setLocalArchive(clanId: string, userId: string, on: boolean) {
    if (!this.isActiveMember(clanId, userId)) throw new Error('Not allowed.');
    if (on) this.db.prepare('INSERT OR IGNORE INTO clans_local_preferences (clan_id, user_id, archived_at) VALUES (?, ?, ?)').run(clanId, userId, this.now());
    else this.db.prepare('DELETE FROM clans_local_preferences WHERE clan_id = ? AND user_id = ?').run(clanId, userId);
  }

  /** The local member leaves; owners must retain authority until an explicit authorized handoff or deletion. */
  leave(clanId: string, userId: string) {
    if (!this.isActiveMember(clanId, userId)) throw new Error('Not allowed.');
    if (this.members(clanId).some((m) => m.userId === userId && m.role === 'owner')) throw new Error('The owner cannot leave without transferring hosting authority or deleting the CLAN.');
    tx(this.db, () => {
      this.setStatus(clanId, userId, 'left');
      this.db.prepare('DELETE FROM clans_local_preferences WHERE clan_id = ? AND user_id = ?').run(clanId, userId);
    });
  }

  /** A member device records a CLAN it joined (same id as on the host). The host's device key identifies the host user. */
  recordJoined(o: { id: string; type: ClanType; name: string; hostDeviceId: string; hostName: string; expiresAt?: number | null; me: string; sessionId?: string }) {
    return tx(this.db, () => {
      const cleanup = this.cleanup(o.id);
      if (cleanup?.kind === 'delete') throw new Error('This CLAN was deleted on this device.');
      if (cleanup && (cleanup.userId !== o.me || cleanup.completedAt === null)) throw new Error('Finish removing this CLAN copy before joining again.');
      if (cleanup) this.db.prepare('DELETE FROM clans_cleanup WHERE clan_id = ?').run(o.id);
      if (!this.get(o.id)) {
        const host = this.identity.userForDevice(o.hostDeviceId, o.hostName);
        this.create({ id: o.id, type: o.type, name: o.name, createdBy: host, expiresAt: o.expiresAt ?? undefined });
      }
      this.addMember(o.id, o.me, 'member');
      if (o.sessionId) {
        const session = z.uuid().parse(o.sessionId);
        const existing = this.db.prepare('SELECT clan_id c, user_id u FROM clans_local_sessions WHERE session_id = ?').get(session) as { c: string; u: string } | undefined;
        if (existing && (existing.c !== o.id || existing.u !== o.me)) throw new Error('This session is already associated with a different CLAN.');
        this.db.prepare('INSERT OR IGNORE INTO clans_local_sessions (session_id, clan_id, user_id) VALUES (?, ?, ?)').run(session, o.id, o.me);
      }
      return this.get(o.id)!;
    });
  }
  /** Ended CLANs (e.g. a finished Temporary session) leave "My CLANs"; their history and files stay. */
  archive(id: string) { this.db.prepare('UPDATE clans_clans SET archived_at = ? WHERE id = ? AND archived_at IS NULL').run(this.now(), id); }

  /** Internal lifecycle controller: commit intent before any filesystem or network work. Not an erasure receipt. */
  private cleanupGuard: (clanId: string) => string | null = () => null;
  /** Persistent hosting: a reason this device's copy must not be removed (e.g. it is the live host of another device's CLAN). */
  setCleanupGuard(f: (clanId: string) => string | null) { this.cleanupGuard = f; }
  requestCleanup(clanId: string, userId: string, kind: 'remove' | 'delete') {
    const guarded = this.cleanupGuard(clanId);
    if (guarded) throw new Error(guarded);
    const member = this.members(clanId).find((m) => m.userId === userId);
    if (!member || !this.get(clanId)) throw new Error('Not allowed.');
    if (kind !== 'remove' && kind !== 'delete') throw new Error('Invalid cleanup action.');
    if (kind === 'delete' ? member.role !== 'owner' : member.role === 'owner') throw new Error(kind === 'delete' ? 'Only the owner can delete the CLAN.' : 'The owner must hand off authority or explicitly delete the CLAN.');
    const previous = this.cleanup(clanId);
    if (previous && (previous.userId !== userId || previous.kind !== kind)) throw new Error('A different cleanup is already recorded.');
    tx(this.db, () => {
      this.db.prepare('INSERT OR IGNORE INTO clans_cleanup (clan_id, user_id, kind, requested_at) VALUES (?, ?, ?, ?)').run(clanId, userId, kind, this.now());
      if (kind === 'delete') this.db.prepare("UPDATE clans_memberships SET status = 'removed' WHERE clan_id = ?").run(clanId);
      else this.setStatus(clanId, userId, 'left');
      this.db.prepare('DELETE FROM clans_local_preferences WHERE clan_id = ?').run(clanId);
    });
    return this.cleanup(clanId)!;
  }

  cleanup(clanId: string) {
    return this.db.prepare('SELECT clan_id clanId, user_id userId, kind, requested_at requestedAt, completed_at completedAt FROM clans_cleanup WHERE clan_id = ?').get(clanId) as
      { clanId: string; userId: string; kind: 'remove' | 'delete'; requestedAt: number; completedAt: number | null } | undefined;
  }
  pendingCleanup(userId: string) {
    return (this.db.prepare('SELECT clan_id id FROM clans_cleanup WHERE user_id = ? AND completed_at IS NULL').all(userId) as { id: string }[]).map((r) => this.cleanup(r.id)!);
  }
  /** Preserve candidate IDs across crashes; retaining this journal is not a claim that bytes have been erased. */
  recordCleanupObjects(clanId: string, ids: string[]) {
    if (!this.cleanup(clanId)) throw new Error('Cleanup intent is required.');
    const previous = this.cleanupObjects(clanId);
    this.db.prepare('UPDATE clans_cleanup SET object_ids = ? WHERE clan_id = ?').run(JSON.stringify([...new Set([...previous, ...ids])]), clanId);
  }
  cleanupObjects(clanId: string): string[] {
    const row = this.db.prepare('SELECT object_ids ids FROM clans_cleanup WHERE clan_id = ?').get(clanId) as { ids: string } | undefined;
    return row ? z.array(z.string()).parse(JSON.parse(row.ids)) : [];
  }
  /** Only the coordinator calls this after all required scoped cleanup has succeeded. */
  completeCleanup(clanId: string, userId: string) {
    this.db.prepare('UPDATE clans_cleanup SET completed_at = ? WHERE clan_id = ? AND user_id = ? AND completed_at IS NULL').run(this.now(), clanId, userId);
  }

  /** Classroom sessions (meetings) of a CLASSROOM CLAN, oldest first. */
  sessionsOf(clanId: string): string[] { return classroomSessions(this.db, clanId); }
  /** Exact authenticated session IDs for device-local download cleanup; never infer scope from a class title. */
  localSessionsOf(clanId: string, userId: string) {
    return (this.db.prepare('SELECT session_id id FROM clans_local_sessions WHERE clan_id = ? AND user_id = ?').all(clanId, userId) as { id: string }[]).map((r) => r.id);
  }
  clanOfSession(sessionId: string) { return (this.db.prepare('SELECT clan_id c FROM clans_classroom_sessions WHERE session_id = ?').get(sessionId) as { c: string } | undefined)?.c ?? null; }

  /** Maps classroom history into CLASSROOM CLANs. Idempotent; run at startup and after a class ends. */
  importClassrooms(ownerId: string) { return importClassrooms(this.db, this, this.identity, ownerId); }
}
