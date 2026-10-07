// Classroom → CLAN mapping. The ONLY code outside @classroom/server that reads the classroom tables, and it only reads.
// One CLASSROOM CLAN per course (sessions with the same title, as the classroom's own "known devices" policy groups them);
// the CLAN keeps the id of the course's first session. Every session and member row is linked by its original id, so
// files, assignments, submissions, receipts and attendance stay exactly where they are.
import { keyFingerprint } from '@classroom/protocol';
import { tableExists, tx, type Db } from '../../core/db.ts';
import type { Identity } from '../../core/identity.ts';
import type { Clans } from './index.ts';

type Session = { id: string; title: string; started_at: number; clan_id: string | null; clan_type: string };
type Member = { id: string; session_id: string; device_id: string; device_key: string | null; full_name: string; status: string; joined_at: number };

export const courseKey = (title: string) => title.trim().toLowerCase().replace(/\s+/g, ' ');

export function importClassrooms(db: Db, clans: Clans, identity: Identity, ownerId: string) {
  if (!tableExists(db, 'sessions') || !tableExists(db, 'members')) return { clans: 0, sessions: 0, members: 0 };
  const result = { clans: 0, sessions: 0, members: 0 };
  tx(db, () => {
    const sessions = db.prepare('SELECT id, title, started_at, clan_id, clan_type FROM sessions ORDER BY started_at, id').all() as Session[];
    const clanFor = new Map<string, string>();
    for (const s of sessions) {
      const linked = clans.clanOfSession(s.id);
      if (linked) { if (s.clan_type === 'CLASSROOM') clanFor.set(courseKey(s.title), linked); continue; }
      // Sessions hosted for a CLAN created in CLAN (any type) link straight to it.
      if (s.clan_id) {
        if (clans.get(s.clan_id)) { db.prepare('INSERT OR IGNORE INTO clans_classroom_sessions (session_id, clan_id) VALUES (?, ?)').run(s.id, s.clan_id); result.sessions++; }
        continue;
      }
      let clanId = clanFor.get(courseKey(s.title));
      if (!clanId) {
        clanId = s.id; // keep an existing id: the course's first session
        if (!clans.get(clanId)) { clans.create({ id: clanId, type: 'CLASSROOM', name: s.title.trim() || 'Classroom', createdBy: ownerId, createdAt: s.started_at, importedFrom: 'classroom' }); result.clans++; }
        clanFor.set(courseKey(s.title), clanId);
      }
      db.prepare('INSERT OR IGNORE INTO clans_classroom_sessions (session_id, clan_id) VALUES (?, ?)').run(s.id, clanId);
      result.sessions++;
    }
    const members = db.prepare(`SELECT m.id, m.session_id, m.device_id, m.device_key, m.full_name, m.status, m.joined_at FROM members m
      WHERE NOT EXISTS (SELECT 1 FROM clans_classroom_members x WHERE x.member_id = m.id) ORDER BY m.joined_at`).all() as Member[];
    for (const m of members) {
      const clanId = clans.clanOfSession(m.session_id);
      if (!clanId) continue;
      const device = m.device_key ? keyFingerprint(m.device_key) : `legacy-device:${m.device_id}`;
      const userId = identity.userForDevice(device, m.full_name, m.device_key ?? undefined);
      db.prepare('INSERT INTO clans_classroom_members (member_id, clan_id, user_id) VALUES (?, ?, ?)').run(m.id, clanId, userId);
      if (m.status === 'approved') clans.addMember(clanId, userId, 'member', m.joined_at);
      else if (m.status === 'removed' || m.status === 'blocked') { if (clans.isActiveMember(clanId, userId)) clans.setStatus(clanId, userId, 'removed'); }
      result.members++;
    }
  });
  return result;
}

export function classroomSessions(db: Db, clanId: string): string[] {
  if (!tableExists(db, 'sessions')) return [];
  return (db.prepare('SELECT x.session_id id FROM clans_classroom_sessions x JOIN sessions s ON s.id = x.session_id WHERE x.clan_id = ? ORDER BY s.started_at').all(clanId) as { id: string }[]).map((r) => r.id);
}
