import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { keyFingerprint, type ClassroomInfo, type DeviceTrust, type JoinPolicy, type Member, type MemberStatus, type StudentProfile, type TimelineEvent } from '@classroom/protocol';
import type { Db } from './db.ts';
import { Throttle } from './throttle.ts';

export const TOKEN_IDLE_MS = 30 * 60_000;
/** Absolute token lifetime; afterwards the device re-proves its key (reconnect) to get a new one. */
export const TOKEN_MAX_MS = 8 * 60 * 60_000;
const MAX_PENDING = 200;

export type NetworkMode = 'lan' | 'direct';
export type Principal = { role: 'teacher' } | { role: 'student'; memberId: string };

export class JoinError extends Error {
  status: number; code: string; retryAfterMs: number;
  constructor(status: number, code: string, message: string, retryAfterMs = 0) {
    super(message);
    this.status = status; this.code = code; this.retryAfterMs = retryAfterMs;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const newToken = () => randomBytes(32).toString('base64url');
/** Uniform over 000000–999999 via CSPRNG. */
export const newJoinCode = () => String(randomInt(0, 1_000_000)).padStart(6, '0');

type MemberRow = {
  id: string; device_id: string; trust: DeviceTrust; full_name: string; roll_no: string; device_name: string;
  status: MemberStatus; token_expires: number; joined_at: number; last_seen: number;
};

/**
 * One live classroom session: the authority for membership, tokens and permissions.
 * Emits 'roster', 'state', 'timeline', ('member', memberId, status).
 */
export class Classroom extends EventEmitter {
  readonly id = randomUUID();
  /** Shown to the teacher; held in memory only (never stored), and only an OPAQUE record is derived from it. */
  readonly code: string;
  readonly teacherToken = newToken();
  private teacherTokenHash = Buffer.from(sha256(this.teacherToken), 'hex');
  private connections = new Map<string, number>();
  // Per-source lockout plus a classroom-wide limit so a distributed guesser can't sweep the 10^6 space.
  readonly ipThrottle: Throttle;
  readonly globalThrottle: Throttle;

  private db: Db;
  private now: () => number;
  readonly title: string;
  readonly networkMode: NetworkMode;

  constructor(db: Db, title: string, networkMode: NetworkMode, opts: { now?: () => number; code?: string } = {}) {
    super();
    this.db = db; this.title = title; this.networkMode = networkMode;
    this.now = opts.now ?? Date.now;
    this.code = opts.code ?? newJoinCode();
    this.ipThrottle = new Throttle(5, 5 * 60_000, 5 * 60_000, this.now);
    this.globalThrottle = new Throttle(50, 60_000, 60_000, this.now);
    db.prepare('INSERT INTO sessions (id, title, join_code, network_mode, started_at) VALUES (?, ?, ?, ?, ?)')
      .run(this.id, title, '', networkMode, this.now());
    this.log('class.started', null, { title, networkMode });
  }

  info(): ClassroomInfo {
    const r = this.db.prepare('SELECT title, locked, join_policy, started_at, ended_at FROM sessions WHERE id = ?').get(this.id) as
      { title: string; locked: number; join_policy: JoinPolicy; started_at: number; ended_at: number | null };
    return { sessionId: this.id, title: r.title, locked: !!r.locked, joinPolicy: r.join_policy, startedAt: r.started_at, ended: r.ended_at !== null };
  }

  /** Pre-checks shared by pairing and joining (no secrets involved). */
  assertJoinable() {
    const info = this.info();
    if (info.ended) throw new JoinError(410, 'ended', 'This class has ended.');
    if (info.locked) throw new JoinError(423, 'locked', 'The teacher has locked joining.');
  }

  /**
   * Admit a device whose code knowledge (OPAQUE) and key possession (signed challenge) were already verified by
   * Pairing. Identity is the device public key; names are display data.
   */
  join(p: StudentProfile): { memberId: string; token: string; status: MemberStatus } {
    this.assertJoinable();
    const fingerprint = keyFingerprint(p.devicePublicKey);
    const existing = this.db.prepare('SELECT id, status FROM members WHERE session_id = ? AND device_id = ?').get(this.id, fingerprint) as
      { id: string; status: MemberStatus } | undefined;
    if (existing?.status === 'blocked') throw new JoinError(403, 'blocked', 'This device has been blocked from the class.');

    const trust = this.trustOf(fingerprint, p.rollNo);
    const info = this.info();
    const auto = info.joinPolicy === 'open' || (info.joinPolicy === 'known' && trust === 'known');
    // The same proven key that the teacher already let in keeps its place.
    let status: MemberStatus = existing?.status === 'approved' || auto ? 'approved' : 'pending';
    if (existing?.status === 'removed') status = 'pending'; // removed students must be re-approved

    if (status === 'pending' && !existing) {
      const n = (this.db.prepare("SELECT count(*) n FROM members WHERE session_id = ? AND status = 'pending'").get(this.id) as { n: number }).n;
      if (n >= MAX_PENDING) throw new JoinError(429, 'too_many_pending', 'Too many pending join requests. Ask the teacher.');
    }

    const token = newToken();
    const t = this.now();
    const memberId = existing?.id ?? randomUUID();
    if (existing) {
      this.db.prepare('UPDATE members SET full_name=?, roll_no=?, device_name=?, status=?, trust=?, token_hash=?, token_expires=?, token_issued_at=?, last_seen=? WHERE id=?')
        .run(p.fullName, p.rollNo, p.deviceName, status, trust, sha256(token), t + TOKEN_IDLE_MS, t, t, memberId);
    } else {
      this.db.prepare('INSERT INTO members (id, session_id, device_id, device_key, trust, full_name, roll_no, device_name, status, token_hash, token_expires, token_issued_at, joined_at, last_seen) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(memberId, this.id, fingerprint, p.devicePublicKey, trust, p.fullName, p.rollNo, p.deviceName, status, sha256(token), t + TOKEN_IDLE_MS, t, t, t);
    }
    this.log(status === 'approved' ? 'member.joined' : 'member.requested', memberId, { name: p.fullName, rollNo: p.rollNo, trust });
    if (status === 'approved') this.remember(memberId);
    this.emit('roster');
    return { memberId, token, status };
  }

  /** Cryptographic trust: only an exact previously approved device key counts as known. */
  private trustOf(fingerprint: string, rollNo: string): DeviceTrust {
    if (this.db.prepare('SELECT 1 FROM trusted_devices WHERE course = ? AND fingerprint = ?').get(this.title, fingerprint)) return 'known';
    if (this.db.prepare('SELECT 1 FROM trusted_devices WHERE course = ? AND lower(roll_no) = lower(?)').get(this.title, rollNo)) return 'new_device';
    return 'first';
  }

  /**
   * Device-key reconnect (after token expiry or app restart) for a device already in this session. The caller has
   * verified a fresh signed challenge for `fingerprint`. Issues a new token; never changes approval state.
   */
  reconnect(fingerprint: string): { memberId: string; token: string; status: MemberStatus } {
    if (this.info().ended) throw new JoinError(410, 'ended', 'This class has ended.');
    const m = this.db.prepare('SELECT id, status FROM members WHERE session_id = ? AND device_id = ?').get(this.id, fingerprint) as { id: string; status: MemberStatus } | undefined;
    if (!m) throw new JoinError(404, 'not_member', 'This device has not joined this class. Join with the code.');
    if (m.status !== 'approved' && m.status !== 'pending') throw new JoinError(403, m.status, 'This device is not allowed in this class.');
    const token = newToken();
    const t = this.now();
    this.db.prepare('UPDATE members SET token_hash = ?, token_expires = ?, token_issued_at = ?, last_seen = ? WHERE id = ?').run(sha256(token), t + TOKEN_IDLE_MS, t, t, m.id);
    this.log('member.reconnected', m.id, {});
    return { memberId: m.id, token, status: m.status };
  }

  /** Resolve a bearer token. Slides the idle expiry on success. */
  authenticate(token: string): Principal | null {
    const h = Buffer.from(sha256(token), 'hex');
    if (timingSafeEqual(h, this.teacherTokenHash)) return { role: 'teacher' };
    const t = this.now();
    const r = this.db.prepare('SELECT id, status, token_expires, token_issued_at FROM members WHERE token_hash = ? AND session_id = ?').get(h.toString('hex'), this.id) as
      { id: string; status: MemberStatus; token_expires: number; token_issued_at: number } | undefined;
    if (!r || r.token_expires < t || r.token_issued_at + TOKEN_MAX_MS < t || r.status === 'blocked' || r.status === 'removed' || r.status === 'rejected') return null;
    this.touch(r.id);
    return { role: 'student', memberId: r.id };
  }

  touch(memberId: string) {
    const t = this.now();
    this.db.prepare('UPDATE members SET token_expires = ?, last_seen = ? WHERE id = ?').run(t + TOKEN_IDLE_MS, t, memberId);
  }

  status(memberId: string): MemberStatus | null {
    const r = this.db.prepare('SELECT status FROM members WHERE id = ? AND session_id = ?').get(memberId, this.id) as { status: MemberStatus } | undefined;
    return r?.status ?? null;
  }

  setStatus(memberId: string, status: Exclude<MemberStatus, 'pending'>) {
    const cur = this.status(memberId);
    if (!cur) throw new JoinError(404, 'no_member', 'No such student in this class.');
    if (status === 'approved' && cur !== 'pending') throw new JoinError(409, 'not_pending', 'Only pending requests can be approved.');
    if (status === 'rejected' && cur !== 'pending') throw new JoinError(409, 'not_pending', 'Only pending requests can be rejected.');
    this.db.prepare('UPDATE members SET status = ? WHERE id = ?').run(status, memberId);
    if (status === 'approved') this.remember(memberId);
    this.log(`member.${status}`, memberId, {});
    this.emit('member', memberId, status);
    this.emit('roster');
  }

  setLocked(locked: boolean) {
    if (this.info().locked === locked) return;
    this.db.prepare('UPDATE sessions SET locked = ? WHERE id = ?').run(locked ? 1 : 0, this.id);
    this.log(locked ? 'class.locked' : 'class.unlocked', null, {});
    this.emit('state');
  }

  setPolicy(policy: JoinPolicy) {
    if (this.info().joinPolicy === policy) return;
    this.db.prepare('UPDATE sessions SET join_policy = ? WHERE id = ?').run(policy, this.id);
    this.log('class.policy', null, { policy });
    this.emit('state');
  }

  end() {
    if (this.info().ended) return;
    this.db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(this.now(), this.id);
    this.log('class.ended', null, {});
    this.emit('state');
  }

  /** Called by the realtime layer per socket open/close so presence is logged once per transition. */
  connected(memberId: string, open: boolean) {
    const before = this.connections.get(memberId) ?? 0;
    const after = Math.max(0, before + (open ? 1 : -1));
    this.connections.set(memberId, after);
    if ((before === 0) === (after === 0)) return;
    const seenBefore = !!this.db.prepare('SELECT 1 FROM presence WHERE member_id = ? LIMIT 1').get(memberId);
    const kind = open ? (seenBefore ? 'reconnected' : 'connected') : 'disconnected';
    this.db.prepare('INSERT INTO presence (session_id, member_id, kind, ts) VALUES (?,?,?,?)').run(this.id, memberId, kind, this.now());
    this.emit('roster');
  }

  member(memberId: string): { id: string; deviceId: string; fullName: string; rollNo: string; status: MemberStatus } | null {
    const r = this.db.prepare('SELECT id, device_id, full_name, roll_no, status FROM members WHERE id = ? AND session_id = ?').get(memberId, this.id) as
      { id: string; device_id: string; full_name: string; roll_no: string; status: MemberStatus } | undefined;
    return r ? { id: r.id, deviceId: r.device_id, fullName: r.full_name, rollNo: r.roll_no, status: r.status } : null;
  }

  roster(): Member[] {
    const rows = this.db.prepare('SELECT id, device_id, trust, full_name, roll_no, device_name, status, token_expires, joined_at, last_seen FROM members WHERE session_id = ? ORDER BY joined_at').all(this.id) as MemberRow[];
    return rows.map((r) => ({
      id: r.id, deviceFingerprint: r.device_id, trust: r.trust, fullName: r.full_name, rollNo: r.roll_no, deviceName: r.device_name,
      status: r.status, connected: (this.connections.get(r.id) ?? 0) > 0, joinedAt: r.joined_at, lastSeen: r.last_seen,
    }));
  }

  timeline(limit = 200): TimelineEvent[] {
    const rows = this.db.prepare('SELECT id, ts, type, actor, data FROM events WHERE session_id = ? ORDER BY id DESC LIMIT ?').all(this.id, limit) as
      { id: number; ts: number; type: string; actor: string | null; data: string }[];
    return rows.reverse().map((r) => ({ ...r, data: JSON.parse(r.data) }));
  }

  /** Record the approved device key for this course (history: first/last approval). */
  private remember(memberId: string) {
    const t = this.now();
    this.db.prepare(`INSERT INTO trusted_devices (course, fingerprint, public_key, full_name, roll_no, first_approved_at, last_approved_at)
      SELECT ?, device_id, device_key, full_name, roll_no, ?, ? FROM members WHERE id = ? AND device_key IS NOT NULL
      ON CONFLICT (course, fingerprint) DO UPDATE SET full_name = excluded.full_name, roll_no = excluded.roll_no, last_approved_at = excluded.last_approved_at`)
      .run(this.title, t, t, memberId);
  }

  log(type: string, actor: string | null, data: Record<string, unknown>) {
    this.db.prepare('INSERT INTO events (session_id, ts, type, actor, data) VALUES (?,?,?,?,?)').run(this.id, this.now(), type, actor, JSON.stringify(data));
    this.emit('timeline');
  }
}
