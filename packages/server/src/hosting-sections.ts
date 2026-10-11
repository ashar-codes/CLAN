// Host-server rows that belong to one CLAN, for a persistent-hosting checkpoint (docs/PHASE_14_2_HOSTING_DESIGN.md).
// Carried: the CLAN's ended sessions (settings), members with approval/removal/block status and device keys, trusted
// devices of the CLAN's trust scope, presence and timeline logs, resources with verified bytes and transfer states,
// assignments, upload attempts, submissions with their bytes and receipts, share uploads including quarantined bytes
// awaiting host review, and presentation history. Never carried (secrets/derivable): join codes, member tokens, host
// TLS/teacher keys, OPAQUE setup and signed manifests (the new host signs its own). `SERVER_TABLES` classifies every
// host-server table; the coverage test fails when a new table is not classified.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { safeFileName, tableSection, type CheckpointProvider } from '@classroom/protocol';
import type { Db } from './db.ts';

/** Every host-server table: carried in the `server` section, or why not. */
export const SERVER_TABLES: Record<string, string> = {
  sessions: 'carried', members: 'carried', trusted_devices: 'carried', presence: 'carried', events: 'carried', resources: 'carried',
  transfers: 'carried', assignments: 'carried', uploads: 'carried', submissions: 'carried', share_uploads: 'carried', presentations: 'carried',
  known_devices: 'excluded: legacy UUID-based trust is deliberately never carried into cryptographic trust (migration 3); those devices are approved once again',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const SESSIONS = 'session_id IN (SELECT id FROM sessions WHERE clan_id = ?)';
const S = { table: 'sessions', column: 'id' }, M = { table: 'members', column: 'id' };
const sha256File = async (p: string) => { const h = createHash('sha256'); for await (const c of createReadStream(p)) h.update(c as Buffer); return h.digest('hex'); };
type Tagged = { t: string; r: Record<string, unknown> };

export function serverCheckpointSection(db: Db, storageDir: string): CheckpointProvider {
  const rows = tableSection(db, [
    { table: 'sessions', where: 'clan_id = ?', scope: { clan_id: 'clan' }, exclude: ['join_code', 'teacher_key', 'tls_spki'], fill: { join_code: () => '' }, upsertKey: ['id'] },
    { table: 'members', where: SESSIONS, scope: { session_id: S }, exclude: ['token_hash', 'token_expires', 'token_issued_at'],
      fill: { token_hash: () => `replicated:${randomUUID()}`, token_expires: () => 0 }, upsertKey: ['id'] },
    { table: 'trusted_devices', where: "course = 'clan:' || ? OR course IN (SELECT title FROM sessions WHERE clan_id = ? AND clan_type = 'CLASSROOM')",
      // trust scope: `clan:<id>`, or a legacy Classroom's course title (classroom.ts trustScope)
      scope: { course: (v, clanId, s) => v === `clan:${clanId}` || (s.get('sessions') ?? []).some((x) => x.clan_type === 'CLASSROOM' && x.title === v) }, upsertKey: ['course', 'fingerprint'] }, // trust scope
    // Logs keyed by local autoincrement ids: the CLAN's rows are replaced as a whole and renumbered.
    { table: 'presence', where: SESSIONS, scope: { session_id: S, member_id: M }, exclude: ['id'] },
    { table: 'events', where: SESSIONS, scope: { session_id: S }, exclude: ['id'] },
    { table: 'resources', where: SESSIONS, scope: { session_id: S }, exclude: ['manifest', 'chunk_size'], upsertKey: ['id'] },
    { table: 'transfers', where: `resource_id IN (SELECT id FROM resources WHERE ${SESSIONS})`, scope: { resource_id: { table: 'resources', column: 'id' }, member_id: M }, upsertKey: ['resource_id', 'member_id'] },
    { table: 'assignments', where: SESSIONS, scope: { session_id: S }, upsertKey: ['id'] },
    { table: 'uploads', where: SESSIONS, scope: { session_id: S, assignment_id: { table: 'assignments', column: 'id' }, member_id: M }, upsertKey: ['id'] },
    { table: 'submissions', where: SESSIONS, scope: { session_id: S, assignment_id: { table: 'assignments', column: 'id' }, member_id: M, upload_id: { table: 'uploads', column: 'id' } }, upsertKey: ['id'] },
    { table: 'share_uploads', where: SESSIONS, scope: { session_id: S, member_id: M }, upsertKey: ['id'] },
    { table: 'presentations', where: SESSIONS, scope: { session_id: S }, upsertKey: ['id'] },
  ]);
  const of = (raw: unknown[], t: string) => (raw as Tagged[]).filter((x) => x.t === t).map((x) => x.r);
  const uuid = (v: unknown) => { if (typeof v !== 'string' || !UUID.test(v)) throw new Error('Invalid id in checkpoint.'); return v; };
  const sha = (v: unknown) => { if (typeof v !== 'string' || !SHA.test(v)) throw new Error('Missing or invalid file hash.'); return v; };
  const size = (v: unknown) => { if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) throw new Error('Invalid file size.'); return v; };
  /** Every byte-carrying row and where its bytes live under the storage root (same layout on both ends). */
  const placed = (raw: unknown[]) => [
    ...of(raw, 'resources').filter((r) => r.status === 'ready').map((r) => ({ sha256: sha(r.sha256), size: size(r.size), rel: ['resources', uuid(r.id)] })),
    ...of(raw, 'submissions').map((r) => {
      const parts = String(r.stored_path).split('/');
      if (parts.length !== 4 || parts[0] !== 'submissions' || parts[1] !== uuid(r.session_id) || parts[2] !== uuid(r.id) || parts[3] !== safeFileName(parts[3]!) || !parts[3]) throw new Error('Invalid submission path.');
      return { sha256: sha(r.sha256), size: size(r.size), rel: parts };
    }),
    // quarantined bytes awaiting the host's review (Shares keeps them at tmp/<id>.part until approved or declined)
    ...of(raw, 'share_uploads').filter((r) => r.state === 'complete' && r.approval === 'pending').map((r) => ({ sha256: sha(r.sha256), size: size(r.size), rel: ['tmp', `${uuid(r.id)}.part`] })),
  ];
  const abs = (rel: string[]) => join(storageDir, ...rel);

  return {
    section: 'server',
    optional: true, // phones (no host-server tables) hand over without it; nothing on the destination is removed
    preflight(clanId) {
      const n = (sql: string) => (db.prepare(sql).get(clanId) as { n: number }).n;
      const issues = [];
      const live = n('SELECT count(*) n FROM sessions WHERE clan_id = ? AND ended_at IS NULL');
      if (live) issues.push({ code: 'live_session', count: live, blocking: true, message: 'End the live CLAN session first.' });
      const uploads = (db.prepare(`SELECT (SELECT count(*) FROM uploads WHERE state = 'uploading' AND ${SESSIONS}) + (SELECT count(*) FROM share_uploads WHERE state = 'uploading' AND ${SESSIONS}) n`).get(clanId, clanId) as { n: number }).n;
      if (uploads) issues.push({ code: 'interrupted_uploads', count: uploads, blocking: false, message: 'Uploads interrupted when an earlier session ended are recorded, but their partial bytes cannot continue; members must send them again.' });
      const importing = n(`SELECT count(*) n FROM resources WHERE status = 'importing' AND ${SESSIONS}`);
      if (importing) issues.push({ code: 'interrupted_imports', count: importing, blocking: false, message: 'Files whose import was interrupted have no complete bytes; they are recorded as unfinished.' });
      let missing = 0;
      for (const f of placed(rows.export(clanId))) { try { if (statSync(abs(f.rel)).size !== f.size) missing++; } catch { missing++; } }
      if (missing) issues.push({ code: 'missing_files', count: missing, blocking: true, message: 'Some CLAN files are missing or changed on this device; the CLAN cannot be handed over intact.' });
      return issues;
    },
    export(clanId) {
      if (this.preflight!(clanId).some((i) => i.code === 'live_session')) throw new Error('End the live CLAN session before handing hosting over.');
      const out = rows.export(clanId);
      return { rows: out, files: placed(out).map((f) => ({ sha256: f.sha256, size: f.size, path: abs(f.rel) })) };
    },
    validate(clanId, raw) {
      const by = rows.validate(clanId, raw);
      for (const s of by.get('sessions')!) if (s.ended_at === null) throw new Error('Checkpoint sessions must be ended.');
      for (const t of ['sessions', 'members', 'resources', 'assignments', 'uploads', 'submissions', 'share_uploads', 'presentations']) for (const r of by.get(t)!) uuid(r.id);
      return placed(raw).map(({ sha256, size }) => ({ sha256, size }));
    },
    async materialize(_clanId, raw, blob) {
      for (const f of placed(raw)) {
        const dest = abs(f.rel);
        const have = await stat(dest).then((s) => s.isFile() && s.size === f.size, () => false);
        if (have && await sha256File(dest) === f.sha256) continue;
        await mkdir(dirname(dest), { recursive: true });
        const tmp = `${dest}.${randomUUID()}.tmp`;
        try {
          await copyFile(blob(f.sha256), tmp);
          if (await sha256File(tmp) !== f.sha256) throw new Error('Replicated file changed while being placed.');
          await rename(tmp, dest);
        } finally { await rm(tmp, { force: true }); }
      }
    },
    import(clanId, raw) { rows.import(clanId, raw); },
  };
}
