// Resource Store: every piece of content exists once (object = SHA-256 + size + MIME + location). Modules hold
// references (refs) that say who uses it, under which scope. Identical content is stored once; legacy classroom files are
// adopted in place (no copy) so the classroom protocol's paths, manifests and SHA checks stay valid.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { tx, type Db, type ModuleSchema } from './db.ts';
import { defineEvent, type EventBus } from './events.ts';
import type { Scope } from './permissions.ts';

export const resourcesSchema: ModuleSchema = {
  module: 'resources', prefix: 'resources',
  migrations: [`
    CREATE TABLE resources_objects (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, mime TEXT NOT NULL,
      location TEXT NOT NULL, origin TEXT NOT NULL CHECK (origin IN ('store','adopted')), created_at INTEGER NOT NULL);
    CREATE TABLE resources_refs (id TEXT PRIMARY KEY, object_id TEXT NOT NULL REFERENCES resources_objects(id),
      module TEXT NOT NULL, entity TEXT NOT NULL, entity_id TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK (scope_kind IN ('personal','clan')), scope_id TEXT NOT NULL,
      name TEXT, created_by TEXT NOT NULL, created_at INTEGER NOT NULL,
      UNIQUE (module, entity, entity_id, scope_kind, scope_id));
    CREATE INDEX resources_refs_object ON resources_refs(object_id);
    CREATE INDEX resources_refs_scope ON resources_refs(scope_kind, scope_id);
  `],
};

export const ResourceAdded = defineEvent('ResourceAdded', 1, z.object({ objectId: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/), size: z.number().int().nonnegative(), origin: z.enum(['store', 'adopted']) }));

export type ObjectRow = { id: string; sha256: string; size: number; mime: string; location: string; origin: 'store' | 'adopted' };
export type RefRow = { id: string; objectId: string; module: string; entity: string; entityId: string; scope: Scope; name: string | null; createdBy: string; createdAt: number };
export type RefOwner = { module: string; entity: string; entityId: string; scope: Scope; name?: string | null; createdBy: string };

export async function sha256File(path: string) {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) { h.update(chunk as Buffer); size += (chunk as Buffer).length; }
  return { sha256: h.digest('hex'), size };
}

const scopeCols = (s: Scope) => (s.kind === 'personal' ? ['personal', s.ownerId] : ['clan', s.clanId]);
type RawRef = { id: string; object_id: string; module: string; entity: string; entity_id: string; scope_kind: 'personal' | 'clan'; scope_id: string; name: string | null; created_by: string; created_at: number };
const toRef = (r: RawRef): RefRow => ({ id: r.id, objectId: r.object_id, module: r.module, entity: r.entity, entityId: r.entity_id,
  scope: r.scope_kind === 'personal' ? { kind: 'personal', ownerId: r.scope_id } : { kind: 'clan', clanId: r.scope_id }, name: r.name, createdBy: r.created_by, createdAt: r.created_at });

export class ResourceStore {
  private db: Db; private bus: EventBus; private dir: string; private now: () => number;
  constructor(db: Db, bus: EventBus, storageDir: string, now = () => Date.now()) { this.db = db; this.bus = bus; this.dir = join(storageDir, 'objects'); this.now = now; }

  object(id: string) { return this.db.prepare('SELECT id, sha256, size, mime, location, origin FROM resources_objects WHERE id = ?').get(id) as ObjectRow | undefined; }
  bySha(sha256: string) { return this.db.prepare('SELECT id, sha256, size, mime, location, origin FROM resources_objects WHERE sha256 = ?').get(sha256) as ObjectRow | undefined; }

  /** Stores a copy of `srcPath` (never moves or deletes the user's file). Same bytes → the existing object. */
  async put(srcPath: string, mime = 'application/octet-stream'): Promise<{ object: ObjectRow; deduped: boolean }> {
    const { sha256, size } = await sha256File(srcPath);
    const hit = this.bySha(sha256);
    if (hit) return { object: hit, deduped: true };
    const dest = join(this.dir, sha256.slice(0, 2), sha256);
    await mkdir(join(this.dir, sha256.slice(0, 2)), { recursive: true });
    const tmp = `${dest}.${randomUUID()}.tmp`;
    await copyFile(srcPath, tmp);
    const check = await sha256File(tmp);
    if (check.sha256 !== sha256) { await rm(tmp, { force: true }); throw new Error('File changed while it was being added; try again.'); }
    await rename(tmp, dest);
    const again = this.bySha(sha256); // a concurrent put of the same bytes won the race
    if (again) return { object: again, deduped: true };
    return { object: this.insert({ sha256, size, mime: mime.slice(0, 120), location: dest, origin: 'store' }), deduped: false };
  }

  /** Registers an existing file in place (legacy classroom storage). The caller vouches for sha256/size; verify() rechecks. */
  adopt(o: { sha256: string; size: number; mime: string; location: string }): ObjectRow {
    return this.bySha(o.sha256) ?? this.insert({ ...o, origin: 'adopted' });
  }

  private insert(o: Omit<ObjectRow, 'id'>): ObjectRow {
    const row = { id: randomUUID(), ...o };
    tx(this.db, () => {
      this.db.prepare('INSERT INTO resources_objects (id, sha256, size, mime, location, origin, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(row.id, row.sha256, row.size, row.mime, row.location, row.origin, this.now());
      this.bus.publish(ResourceAdded, 'resources', { objectId: row.id, sha256: row.sha256, size: row.size, origin: row.origin });
    });
    return row;
  }

  /** Idempotent: the same owner + scope always maps to one ref. */
  ref(objectId: string, o: RefOwner): RefRow {
    if (!this.object(objectId)) throw new Error('Unknown resource object.');
    const [kind, sid] = scopeCols(o.scope);
    this.db.prepare(`INSERT OR IGNORE INTO resources_refs (id, object_id, module, entity, entity_id, scope_kind, scope_id, name, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(randomUUID(), objectId, o.module, o.entity, o.entityId, kind!, sid!, o.name ?? null, o.createdBy, this.now());
    return toRef(this.db.prepare('SELECT * FROM resources_refs WHERE module = ? AND entity = ? AND entity_id = ? AND scope_kind = ? AND scope_id = ?')
      .get(o.module, o.entity, o.entityId, kind!, sid!) as RawRef);
  }
  unref(refId: string) { this.db.prepare('DELETE FROM resources_refs WHERE id = ?').run(refId); }
  getRef(refId: string) { const r = this.db.prepare('SELECT * FROM resources_refs WHERE id = ?').get(refId) as RawRef | undefined; return r && toRef(r); }
  refsOf(objectId: string) { return (this.db.prepare('SELECT * FROM resources_refs WHERE object_id = ? ORDER BY created_at').all(objectId) as RawRef[]).map(toRef); }
  refsIn(scope: Scope, module?: string) {
    const [kind, sid] = scopeCols(scope);
    return (this.db.prepare(`SELECT * FROM resources_refs WHERE scope_kind = ? AND scope_id = ? ${module ? 'AND module = ?' : ''} ORDER BY created_at DESC`)
      .all(...[kind!, sid!, ...(module ? [module] : [])]) as RawRef[]).map(toRef);
  }
  /** Objects nothing refers to any more (garbage-collection candidates; adopted files are never deleted here). */
  orphans() { return this.db.prepare('SELECT o.id, o.sha256, o.size, o.mime, o.location, o.origin FROM resources_objects o WHERE NOT EXISTS (SELECT 1 FROM resources_refs r WHERE r.object_id = o.id)').all() as ObjectRow[]; }

  /** Re-hashes the stored bytes. */
  async verify(objectId: string) {
    const o = this.object(objectId);
    if (!o) return false;
    try { return (await sha256File(o.location)).sha256 === o.sha256; } catch { return false; }
  }
}
