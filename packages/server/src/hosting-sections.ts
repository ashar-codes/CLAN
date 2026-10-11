// Host-server rows that belong to one CLAN, for a persistent-hosting checkpoint (docs/PHASE_14_2_HOSTING_DESIGN.md).
// Carried: the CLAN's ended sessions (settings only), members with their approval/removal/block status and device keys,
// trusted devices of the CLAN's trust scope, and resource metadata + verified bytes (chat attachments resolve across the
// CLAN's sessions). Never carried: join codes, member tokens, host TLS/teacher keys, OPAQUE setup, signed manifests (the
// new host signs its own), presence/events/transfers, assignments/submissions and pending share reviews (they stay on
// the previous host). Existing rows on the destination keep their own secrets; new members get unusable token hashes.
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tableSection, type CheckpointProvider } from '@classroom/protocol';
import type { Db } from './db.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const SESSIONS = 'session_id IN (SELECT id FROM sessions WHERE clan_id = ?)';
const sha256File = async (p: string) => { const h = createHash('sha256'); for await (const c of createReadStream(p)) h.update(c as Buffer); return h.digest('hex'); };

export function serverCheckpointSection(db: Db, storageDir: string): CheckpointProvider {
  const rows = tableSection(db, [
    { table: 'sessions', where: 'clan_id = ?', scope: { clan_id: 'clan' }, exclude: ['join_code', 'teacher_key', 'tls_spki'], fill: { join_code: () => '' }, upsertKey: ['id'] },
    { table: 'members', where: SESSIONS, scope: { session_id: { table: 'sessions', column: 'id' } }, exclude: ['token_hash', 'token_expires', 'token_issued_at'],
      fill: { token_hash: () => `replicated:${randomUUID()}`, token_expires: () => 0 }, upsertKey: ['id'] },
    { table: 'trusted_devices', where: "course = 'clan:' || ? OR course IN (SELECT title FROM sessions WHERE clan_id = ? AND clan_type = 'CLASSROOM')",
      // trust scope: `clan:<id>`, or a legacy Classroom's course title (classroom.ts trustScope)
      scope: { course: (v, clanId, s) => v === `clan:${clanId}` || (s.get('sessions') ?? []).some((x) => x.clan_type === 'CLASSROOM' && x.title === v) }, upsertKey: ['course', 'fingerprint'] }, // trust scope
    { table: 'resources', where: `${SESSIONS} AND status IN ('ready','removed')`, scope: { session_id: { table: 'sessions', column: 'id' } }, exclude: ['manifest', 'chunk_size'], upsertKey: ['id'] },
  ]);
  const ready = (raw: unknown[]) => raw.map((x) => (x as { t: string; r: Record<string, unknown> })).filter((x) => x.t === 'resources' && x.r.status === 'ready').map((x) => x.r);
  const resourcePath = (id: string) => { if (!UUID.test(id)) throw new Error('Invalid resource id.'); return join(storageDir, 'resources', id); };

  return {
    section: 'server',
    export(clanId) {
      const live = db.prepare('SELECT count(*) n FROM sessions WHERE clan_id = ? AND ended_at IS NULL').get(clanId) as { n: number };
      if (live.n) throw new Error('End the live CLAN session before handing hosting over.');
      const out = rows.export(clanId);
      return { rows: out, files: ready(out).map((r) => ({ sha256: String(r.sha256), size: Number(r.size), path: resourcePath(String(r.id)) })) };
    },
    validate(clanId, raw) {
      const by = rows.validate(clanId, raw);
      for (const s of by.get('sessions')!) if (s.ended_at === null || typeof s.id !== 'string' || !UUID.test(s.id)) throw new Error('Checkpoint sessions must be ended.');
      for (const r of by.get('resources')!) if (typeof r.id !== 'string' || !UUID.test(r.id)) throw new Error('Invalid resource id.');
      return ready(raw).map((r) => {
        if (typeof r.sha256 !== 'string' || !SHA.test(r.sha256) || typeof r.size !== 'number' || !Number.isInteger(r.size) || r.size < 0) throw new Error('Ready resource without a valid hash.');
        return { sha256: r.sha256, size: r.size };
      });
    },
    async materialize(_clanId, raw, blob) {
      await mkdir(join(storageDir, 'resources'), { recursive: true });
      for (const r of ready(raw)) {
        const dest = resourcePath(String(r.id));
        const have = await stat(dest).then((s) => s.isFile() && s.size === r.size, () => false);
        if (have && await sha256File(dest) === r.sha256) continue;
        const tmp = `${dest}.${randomUUID()}.tmp`;
        try {
          await copyFile(blob(String(r.sha256)), tmp);
          if (await sha256File(tmp) !== r.sha256) throw new Error('Replicated file changed while being placed.');
          await rename(tmp, dest);
        } finally { await rm(tmp, { force: true }); }
      }
    },
    import(clanId, raw) { rows.import(clanId, raw); },
  };
}
