// Files in CLANs and Personal Space are Resource Store references owned by this module (no table of its own).
import { z } from 'zod';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Permissions, type Principal, type Scope } from '../../core/permissions.ts';
import type { ResourceStore, RefRow } from '../../core/resources.ts';
import type { Db } from '../../core/db.ts';
import type { Clans } from '../clans/index.ts';
import { adoptClassroomResources, classroomName, classroomNames } from './classroom-adopt.ts';

export const ResourceShared = defineEvent('ResourceShared', 1, z.object({
  refId: z.string(), objectId: z.string(), scope: z.discriminatedUnion('kind', [z.object({ kind: z.literal('personal'), ownerId: z.string() }), z.object({ kind: z.literal('clan'), clanId: z.string() })]), by: z.string(),
}));
export type FileView = { refId: string; objectId: string; name: string; size: number; mime: string; sha256: string; addedAt: number; source: 'clan' | 'classroom' | 'personal' };

const NAME = z.string().trim().min(1).max(255).refine((n) => !/[\\/\0]/.test(n), 'bad file name');

export class Files {
  private db: Db; private bus: EventBus; private store: ResourceStore; private perms: Permissions; private clans: Clans;
  constructor(db: Db, bus: EventBus, store: ResourceStore, perms: Permissions, clans: Clans) { this.db = db; this.bus = bus; this.store = store; this.perms = perms; this.clans = clans; }

  /** Adds a file to the caller's Personal Space or a CLAN they belong to (CLAN must have the `files` capability). */
  async add(p: Principal, path: string, name: string, scope: Scope, mime?: string): Promise<FileView> {
    this.assertWrite(p, scope);
    const { object } = await this.store.put(path, mime);
    return this.attach(p, object.id, NAME.parse(name), scope);
  }

  /** Like add, but moves an app-produced file into the store instead of copying it (recordings, captures). */
  async ingest(p: Principal, path: string, name: string, scope: Scope, mime?: string): Promise<FileView> {
    this.assertWrite(p, scope);
    const { object } = await this.store.ingest(path, mime);
    return this.attach(p, object.id, NAME.parse(name), scope);
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

  private attach(p: Principal, objectId: string, name: string, scope: Scope) {
    const ref = this.store.ref(objectId, { module: 'files', entity: 'file', entityId: `${objectId}:${userOf(p)}`, scope, name, createdBy: userOf(p) });
    this.bus.publish(ResourceShared, 'files', { refId: ref.id, objectId, scope, by: userOf(p) });
    return this.view(ref, new Map());
  }
  private assertWrite(p: Principal, scope: Scope) {
    if (p.kind !== 'user' || !this.perms.canRead(p, scope)) throw new Error('Not allowed.');
    if (scope.kind === 'clan' && !this.clans.has(scope.clanId, 'files')) throw new Error('This CLAN does not share files.');
  }
  private nameOf(r: RefRow) { return r.name ?? classroomName(this.db, r.entityId) ?? 'file'; }
  private view(r: RefRow, names: Map<string, string>): FileView {
    const o = this.store.object(r.objectId)!;
    return { refId: r.id, objectId: o.id, name: r.name ?? names.get(r.entityId) ?? 'file', size: o.size, mime: o.mime, sha256: o.sha256, addedAt: r.createdAt,
      source: r.entity === 'classroom-resource' ? 'classroom' : r.scope.kind === 'personal' ? 'personal' : 'clan' };
  }
}
