// Internal device lifecycle API, never an HTTP endpoint. The composition root authorizes the CLAN owner and stops
// the host first. This module alone removes server-owned history; trusted-device/signing records remain intact.
import { rm } from 'node:fs/promises';
import type { Db } from './db.ts';
import { Storage, UUID_RE } from './storage.ts';

export async function purgeStoppedSessions(db: Db, storageDir: string, sessionIds: string[], resources: {
  preserve: (managedPath: string) => Promise<void>;
  removed: (managedPath: string) => void;
}) {
  const ids = [...new Set(sessionIds)];
  if (ids.some((id) => !UUID_RE.test(id))) throw new Error('Invalid session cleanup scope.');
  const storage = new Storage(storageDir);
  // Validate the complete scope before any filesystem mutation. Live hosts must never lose their backing files.
  for (const id of ids) {
    const session = db.prepare('SELECT ended_at ended FROM sessions WHERE id = ?').get(id) as { ended: number | null } | undefined;
    if (session?.ended === null) throw new Error('Stop the CLAN host before removing its local history.');
  }
  const queryIds = JSON.stringify(ids);
  const files = db.prepare('SELECT id FROM resources WHERE session_id IN (SELECT value FROM json_each(?))').all(queryIds) as { id: string }[];
  const uploads = db.prepare(`SELECT id FROM uploads WHERE session_id IN (SELECT value FROM json_each(?))
    UNION SELECT id FROM share_uploads WHERE session_id IN (SELECT value FROM json_each(?))`).all(queryIds, queryIds) as { id: string }[];
  const submissions = db.prepare('SELECT id, session_id sessionId FROM submissions WHERE session_id IN (SELECT value FROM json_each(?))').all(queryIds) as { id: string; sessionId: string }[];
  // All paths come from validated UUIDs. Never use stored_path, class titles or caller-supplied directory names.
  const paths = files.map((f) => storage.resource(f.id));
  const temporary = uploads.map((u) => storage.tmp(u.id));
  const submitted = submissions.map((s) => storage.submissionDir(s.sessionId, s.id));
  for (const path of paths) await resources.preserve(path); // failure leaves history pending and prevents erasure
  for (const path of paths) { await rm(path, { force: true }); resources.removed(path); }
  for (const path of temporary) await rm(path, { force: true });
  for (const path of submitted) await rm(path, { recursive: true, force: true });
  db.exec('SAVEPOINT server_clan_cleanup');
  try {
    db.prepare('DELETE FROM transfers WHERE resource_id IN (SELECT id FROM resources WHERE session_id IN (SELECT value FROM json_each(?)))').run(queryIds);
    for (const table of ['share_uploads', 'submissions', 'uploads', 'assignments', 'presentations', 'presence', 'events', 'members', 'resources', 'sessions']) {
      const column = table === 'sessions' ? 'id' : 'session_id';
      db.prepare(`DELETE FROM ${table} WHERE ${column} IN (SELECT value FROM json_each(?))`).run(queryIds);
    }
    db.exec('RELEASE server_clan_cleanup');
  } catch (e) { db.exec('ROLLBACK TO server_clan_cleanup'); db.exec('RELEASE server_clan_cleanup'); throw e; }
  return { sessions: ids.length, resources: paths.length, temporary: temporary.length, submissions: submitted.length };
}
