// Files in CLANs and Personal Space are Resource Store references owned by this module (no table of its own).
import { z } from 'zod';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Permissions, type Principal, type Scope } from '../../core/permissions.ts';
import type { ResourceStore, RefRow } from '../../core/resources.ts';
import type { Db } from '../../core/db.ts';
import type { Clans } from '../clans/index.ts';
import { adoptClassroomResources, classroomName, classroomNames } from './classroom-adopt.ts';
import type { SyncProvider } from '../../core/syncrows.ts';
import type { CheckpointProvider } from '@classroom/protocol';

export const ResourceShared = defineEvent('ResourceShared', 1, z.object({
  refId: z.string(), objectId: z.string(), scope: z.discriminatedUnion('kind', [z.object({ kind: z.literal('personal'), ownerId: z.string() }), z.object({ kind: z.literal('clan'), clanId: z.string() })]), by: z.string(),
}));
export type FileView = { refId: string; objectId: string; name: string; size: number; mime: string; sha256: string; addedAt: number; source: 'clan' | 'classroom' | 'personal' };

const NAME = z.string().trim().min(1).max(255).refine((n) => !/[\\/\0]/.test(n), 'bad file name');

export class Files {
  private db: Db; private bus: EventBus; private store: ResourceStore; private perms: Permissions; private clans: Clans;
  constructor(db: Db, bus: EventBus, store: ResourceStore, perms: Permissions, clans: Clans) { this.db = db; this.bus = bus; this.store = store; this.perms = perms; this.clans = clans; }

  /** Persistent hosting: files shared into the CLAN (refs + verified bytes). Adopted classroom files travel with the
   *  host server's resources instead and are adopted again on the destination. */
  checkpointProvider(): CheckpointProvider {
    const Row = z.object({ id: z.string().uuid(), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative(), mime: z.string().max(120),
      name: NAME.nullable(), createdBy: z.string().min(1).max(80), createdAt: z.number().int() }).strict();
    type Row = z.infer<typeof Row>;
    const SQL = `SELECT r.id, o.sha256, o.size, o.mime, o.location, r.name, r.created_by, r.created_at FROM resources_refs r JOIN resources_objects o ON o.id = r.object_id
      WHERE r.module = 'files' AND r.entity = 'file' AND r.scope_kind = 'clan' AND r.scope_id = ? ORDER BY r.created_at, r.id`;
    const parse = (raw: unknown[]) => z.array(Row).max(100_000).parse(raw);
    return {
      section: 'files',
      // Any other CLAN-scoped reference would have no section to carry it: stop rather than lose it.
      preflight: (clanId) => {
        const n = (this.db.prepare("SELECT count(*) n FROM resources_refs WHERE scope_kind = 'clan' AND scope_id = ? AND NOT (module = 'files' AND entity IN ('file','classroom-resource'))").get(clanId) as { n: number }).n;
        return n ? [{ code: 'unsupported_data', count: n, blocking: true, message: 'This CLAN holds items a hand-over cannot carry yet.' }] : [];
      },
      export: (clanId) => {
        const rs = this.db.prepare(SQL).all(clanId) as { id: string; sha256: string; size: number; mime: string; location: string; name: string | null; created_by: string; created_at: number }[];
        return { rows: rs.map((r) => ({ id: r.id, sha256: r.sha256, size: r.size, mime: r.mime, name: r.name, createdBy: r.created_by, createdAt: r.created_at })), files: rs.map((r) => ({ sha256: r.sha256, size: r.size, path: r.location })) };
      },
      validate: (_clanId, raw) => parse(raw).map((r) => ({ sha256: r.sha256, size: r.size })),
      materialize: async (_clanId, raw, blob) => {
        for (const r of parse(raw)) {
          if (this.store.bySha(r.sha256)) continue;
          const put = await this.store.put(blob(r.sha256), r.mime); // copies and re-verifies the bytes
          put.release();
          if (put.object.sha256 !== r.sha256 || put.object.size !== r.size) throw new Error('Replicated file does not match its checkpoint entry.');
        }
      },
      import: (clanId, raw) => {
        const rows = parse(raw) as Row[];
        const keep = new Set(rows.map((r) => r.id));
        for (const old of this.store.refsIn({ kind: 'clan', clanId }, 'files')) if (old.entity === 'file' && !keep.has(old.id)) this.store.unref(old.id);
        for (const r of rows) {
          const o = this.store.bySha(r.sha256);
          if (!o) throw new Error('Replicated file bytes are missing.');
          const entityId = `${o.id}:${r.createdBy}`;
          this.db.prepare("DELETE FROM resources_refs WHERE module = 'files' AND entity = 'file' AND entity_id = ? AND scope_kind = 'clan' AND scope_id = ? AND id <> ?").run(entityId, clanId, r.id);
          this.db.prepare(`INSERT INTO resources_refs (id, object_id, module, entity, entity_id, scope_kind, scope_id, name, created_by, created_at) VALUES (?, ?, 'files', 'file', ?, 'clan', ?, ?, ?, ?)
            ON CONFLICT (id) DO UPDATE SET object_id = excluded.object_id, entity_id = excluded.entity_id, name = excluded.name WHERE scope_kind = 'clan' AND scope_id = excluded.scope_id`).run(r.id, o.id, entityId, clanId, r.name, r.createdBy, r.createdAt);
        }
      },
    };
  }

  /** Personal sync: the student's own files travel by content hash (deduplicated, verified on arrival). A ref keeps the
   *  same id on every device so courses, tasks and tapes that point at it still resolve. CLAN files never sync. */
  syncProviders(): SyncProvider[] {
    type R = { id: string; name: string | null; created_at: number; sha256: string; size: number; mime: string };
    const SELECT = "SELECT r.id, r.name, r.created_at, o.sha256, o.size, o.mime FROM resources_refs r JOIN resources_objects o ON o.id = r.object_id WHERE r.module = 'files' AND r.scope_kind = 'personal' AND r.scope_id = ?";
    const wire = ({ id: _id, ...r }: R) => r;
    const In = z.object({ name: z.string().max(255).nullable(), created_at: z.number().int(), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative(), mime: z.string().max(120) });
    return [{ kind: 'file', policy: 'lww',
      all: (owner) => new Map((this.db.prepare(SELECT).all(owner) as R[]).map((r) => [r.id, wire(r)])),
      one: (owner, id) => { const r = this.db.prepare(`${SELECT} AND r.id = ?`).get(owner, id) as R | undefined; return r ? wire(r) : null; },
      apply: (owner, id, payload) => {
        const cur = this.store.getRef(id);
        if (cur && (cur.module !== 'files' || cur.scope.kind !== 'personal' || cur.scope.ownerId !== owner)) throw new Error('That file belongs to someone else.');
        if (payload === null) { if (cur) this.store.unref(id); return; }
        const f = In.parse(payload), obj = this.store.bySha(f.sha256);
        if (!obj) return { needs: { sha256: f.sha256, size: f.size, mime: f.mime } }; // bytes first; the engine re-applies after
        if (cur && cur.objectId !== obj.id) this.store.unref(id);
        if (cur && cur.objectId === obj.id) { this.db.prepare('UPDATE resources_refs SET name = ? WHERE id = ?').run(f.name, id); return; }
        this.db.prepare(`INSERT INTO resources_refs (id, object_id, module, entity, entity_id, scope_kind, scope_id, name, created_by, created_at) VALUES (?, ?, 'files', 'file', ?, 'personal', ?, ?, ?, ?)`)
          .run(id, obj.id, `sync:${id}`, owner, f.name, owner, f.created_at);
      } }];
  }
  /** Where the bytes of one of `owner`'s own personal files live (served only to their linked devices). */
  personalObject(owner: string, sha256: string) {
    return (this.db.prepare("SELECT o.location FROM resources_objects o JOIN resources_refs r ON r.object_id = o.id WHERE o.sha256 = ? AND r.module = 'files' AND r.scope_kind = 'personal' AND r.scope_id = ? LIMIT 1").get(sha256, owner) as { location: string } | undefined)?.location ?? null;
  }

  /** Adds a file to the caller's Personal Space or a CLAN they belong to (CLAN must have the `files` capability). */
  async add(p: Principal, path: string, name: string, scope: Scope, mime?: string): Promise<FileView> {
    this.assertWrite(p, scope);
    const { object, release } = await this.store.put(path, mime);
    try { return this.attach(p, object.id, NAME.parse(name), scope); } finally { release(); }
  }

  /** Like add, but moves an app-produced file into the store instead of copying it (recordings, captures). */
  async ingest(p: Principal, path: string, name: string, scope: Scope, mime?: string): Promise<FileView> {
    this.assertWrite(p, scope);
    const { object, release } = await this.store.ingest(path, mime);
    try { return this.attach(p, object.id, NAME.parse(name), scope); } finally { release(); }
  }

  /** Shares content the caller can already read into another scope: a new reference, never a copy. */
  share(p: Principal, refId: string, to: Scope): FileView {
    const ref = this.store.getRef(refId);
    if (!ref || !this.perms.canRead(p, ref.scope)) throw new Error('Not found.');
    this.assertWrite(p, to);
    return this.attach(p, ref.objectId, ref.name ?? this.nameOf(ref), to);
  }

  /** One file the caller can read (by ref id), or null — the same check as listing its scope. */
  get(p: Principal, refId: string): (FileView & { scope: Scope; createdBy: string }) | null {
    const ref = this.store.getRef(refId);
    if (!ref || ref.module !== 'files' || !this.perms.canRead(p, ref.scope) || !this.perms.agentMay(p, 'files')) return null;
    const names = ref.scope.kind === 'clan' ? classroomNames(this.db, this.clans.sessionsOf(ref.scope.clanId)) : new Map<string, string>();
    return { ...this.view(ref, names), scope: ref.scope, createdBy: ref.createdBy };
  }

  list(p: Principal, scope: Scope): FileView[] {
    if (!this.perms.canRead(p, scope) || !this.perms.agentMay(p, 'files')) return [];
    const names = scope.kind === 'clan' ? classroomNames(this.db, this.clans.sessionsOf(scope.clanId)) : new Map<string, string>();
    return this.store.refsIn(scope, 'files').map((r) => this.view(r, names));
  }

  remove(p: Principal, refId: string) {
    const ref = this.store.getRef(refId);
    if (!ref || ref.module !== 'files') return;
    if (ref.createdBy !== userOf(p) && !(ref.scope.kind === 'clan' && this.clans.members(ref.scope.clanId).some((m) => m.userId === userOf(p) && m.role !== 'member'))) throw new Error('Only the person who added it or a CLAN owner can remove it.');
    this.store.unref(refId);
  }

  /** Registers classroom files (already on disk, already hashed + manifested) as references of their CLAN. Idempotent. */
  adoptClassroomFiles(storageRoot: string) { return adoptClassroomResources(this.db, this.store, this.clans, storageRoot); }

  /** Lifecycle coordinator: release this CLAN's references. Bytes shared with personal data/other CLANs remain. */
  forgetClan(clanId: string, retain?: { ownerId: string; refIds: string[] }) {
    const refs = this.store.refsIn({ kind: 'clan', clanId }, 'files');
    const kept = new Set(retain?.refIds);
    for (const ref of refs) {
      if (retain && kept.has(ref.id)) {
        // Keep the stable ref ID used by a personal Course; only its scope changes on this device.
        this.db.prepare("UPDATE resources_refs SET scope_kind = 'personal', scope_id = ?, entity = 'file', entity_id = ?, name = ?, created_by = ? WHERE id = ?")
          .run(retain.ownerId, `retained:${ref.id}`, this.nameOf(ref), retain.ownerId, ref.id);
      } else this.store.unref(ref.id);
    }
    return [...new Set(refs.map((r) => r.objectId))];
  }

  private attach(p: Principal, objectId: string, name: string, scope: Scope) {
    // Copying/hashing yields: membership may have been revoked while bytes were being stored.
    // Recheck at publication, including shares and future lifecycle cleanup.
    this.assertWrite(p, scope);
    const ref = this.store.ref(objectId, { module: 'files', entity: 'file', entityId: `${objectId}:${userOf(p)}`, scope, name, createdBy: userOf(p) });
    this.bus.publish(ResourceShared, 'files', { refId: ref.id, objectId, scope, by: userOf(p) });
    return this.view(ref, new Map());
  }
  private hostGate: (clanId: string) => string | null = () => null;
  /** Persistent hosting: a reason this device may not make authoritative writes to a CLAN (paused, handed over, conflicted
   *  or revoked host), or null. Member-side caching is never gated. */
  guardHostWrites(f: (clanId: string) => string | null) { this.hostGate = f; }
  private assertWrite(p: Principal, scope: Scope) {
    if (p.kind !== 'user' || !this.perms.canRead(p, scope)) throw new Error('Not allowed.');
    const why = scope.kind === 'clan' ? this.hostGate(scope.clanId) : null;
    if (why) throw new Error(why);
    if (scope.kind === 'clan' && !this.clans.has(scope.clanId, 'files')) throw new Error('This CLAN does not share files.');
  }
  private nameOf(r: RefRow) { return r.name ?? classroomName(this.db, r.entityId) ?? 'file'; }
  private view(r: RefRow, names: Map<string, string>): FileView {
    const o = this.store.object(r.objectId)!;
    return { refId: r.id, objectId: o.id, name: r.name ?? names.get(r.entityId) ?? 'file', size: o.size, mime: o.mime, sha256: o.sha256, addedAt: r.createdAt,
      source: r.entity === 'classroom-resource' ? 'classroom' : r.scope.kind === 'personal' ? 'personal' : 'clan' };
  }
}
