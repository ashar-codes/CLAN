// Reads (never writes) the classroom `resources` table so classroom files appear in their CLAN without copying bytes or
// names. The classroom keeps serving them with its own paths, manifests and SHA-256 checks.
import { join } from 'node:path';
import { tableExists, type Db } from '../../core/db.ts';
import type { ResourceStore } from '../../core/resources.ts';
import type { Clans } from '../clans/index.ts';

type Res = { id: string; session_id: string; mime: string; size: number; sha256: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function adoptClassroomResources(db: Db, store: ResourceStore, clans: Clans, storageRoot: string) {
  if (!tableExists(db, 'resources')) return 0;
  let n = 0;
  // Files sent to one CLANmate (audience set) belong to that conversation, never to the CLAN's shared files.
  const direct = (db.prepare("SELECT 1 FROM pragma_table_info('resources') WHERE name = 'audience'").get() ? 'AND audience IS NULL' : '');
  const rows = db.prepare(`SELECT id, session_id, mime, size, sha256 FROM resources WHERE status = 'ready' AND sha256 IS NOT NULL ${direct}
    AND NOT EXISTS (SELECT 1 FROM resources_refs r WHERE r.module = 'files' AND r.entity = 'classroom-resource' AND r.entity_id = resources.id)`).all() as Res[];
  for (const r of rows) {
    const clanId = clans.clanOfSession(r.session_id);
    if (!clanId || !UUID.test(r.id)) continue;
    const owner = clans.get(clanId)!.createdBy;
    const o = store.adopt({ sha256: r.sha256, size: r.size, mime: r.mime, location: join(storageRoot, 'resources', r.id) });
    store.ref(o.id, { module: 'files', entity: 'classroom-resource', entityId: r.id, scope: { kind: 'clan', clanId }, name: null, createdBy: owner });
    n++;
  }
  return n;
}

/** Display names of classroom files, read from the classroom table (their single source of truth). */
export function classroomNames(db: Db, sessionIds: string[]): Map<string, string> {
  if (!sessionIds.length || !tableExists(db, 'resources')) return new Map();
  const rows = db.prepare("SELECT id, original_name n FROM resources WHERE session_id IN (SELECT value FROM json_each(?)) AND status = 'ready'").all(JSON.stringify(sessionIds)) as { id: string; n: string }[];
  return new Map(rows.map((r) => [r.id, r.n]));
}

export function classroomName(db: Db, resourceId: string) {
  if (!tableExists(db, 'resources')) return null;
  return (db.prepare('SELECT original_name n FROM resources WHERE id = ?').get(resourceId) as { n: string } | undefined)?.n ?? null;
}
