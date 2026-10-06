import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Classroom, JoinError, newJoinCode, TOKEN_IDLE_MS } from '../src/classroom.ts';
import { migrate, openDb } from '../src/db.ts';
import { Throttle } from '../src/throttle.ts';
import { StudentProfile } from '@classroom/protocol';
import { profile } from './helpers.ts';

const setup = (code = '123456') => {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  return { c: new Classroom(openDb(':memory:'), 'Operating Systems', 'lan', { now: clock.now, code }), clock };
};
const req = (code: string, p = profile()) => ({ code, profile: p, protocol: 1 as const });

describe('join code', () => {
  it('is always 6 digits and well spread', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = newJoinCode();
      expect(c).toMatch(/^\d{6}$/);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(1990);
  });
});

describe('migrations', () => {
  it('are idempotent', () => {
    const db = new DatabaseSync(':memory:');
    const v = migrate(db);
    expect(migrate(db)).toBe(v);
    expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(v);
  });
});

describe('throttle', () => {
  it('locks after max failures and unlocks after lock period', () => {
    let t = 0;
    const th = new Throttle(3, 1000, 5000, () => t);
    th.fail('a'); th.fail('a');
    expect(th.lockedFor('a')).toBe(0);
    th.fail('a');
    expect(th.lockedFor('a')).toBe(5000);
    expect(th.lockedFor('b')).toBe(0);
    t = 5001;
    expect(th.lockedFor('a')).toBe(0);
  });
  it('forgets failures outside the window', () => {
    let t = 0;
    const th = new Throttle(3, 1000, 5000, () => t);
    th.fail('a'); th.fail('a');
    t = 2000;
    th.fail('a');
    expect(th.lockedFor('a')).toBe(0);
  });
});

describe('profile validation', () => {
  it('rejects control characters, blanks and bad uuids', () => {
    expect(StudentProfile.safeParse({ ...profile(), fullName: 'a\u0000b' }).success).toBe(false);
    expect(StudentProfile.safeParse({ ...profile(), fullName: '   ' }).success).toBe(false);
    expect(StudentProfile.safeParse({ ...profile(), deviceId: 'MacBook' }).success).toBe(false);
    expect(StudentProfile.safeParse({ ...profile(), fullName: 'x'.repeat(81) }).success).toBe(false);
    expect(StudentProfile.safeParse(profile()).success).toBe(true);
  });
});

describe('classroom membership', () => {
  it('defaults to pending; approval activates the same token', () => {
    const { c } = setup();
    const j = c.join(req('123456'), 'ip1');
    expect(j.status).toBe('pending');
    expect(c.authenticate(j.token)).toEqual({ role: 'student', memberId: j.memberId });
    c.setStatus(j.memberId, 'approved');
    expect(c.status(j.memberId)).toBe('approved');
  });

  it('wrong code throws and is throttled per source, then globally', () => {
    const { c, clock } = setup();
    for (let i = 0; i < 5; i++) expect(() => c.join(req('000000'), 'ip1')).toThrow(/Wrong classroom code/);
    // Locked even with the correct code.
    expect(() => c.join(req('123456'), 'ip1')).toThrowError(expect.objectContaining({ status: 429 }));
    expect(c.join(req('123456'), 'ip2').status).toBe('pending');
    clock.advance(5 * 60_000 + 1);
    expect(c.join(req('123456'), 'ip1').status).toBe('pending');
    // Distributed guessing: 50 failures across many sources locks the classroom briefly.
    for (let i = 0; i < 50; i++) { try { c.join(req('000001'), `bot${i}`); } catch {} }
    expect(() => c.join(req('123456'), 'fresh-ip')).toThrowError(expect.objectContaining({ code: 'throttled' }));
  });

  it('policies: open auto-approves, known approves previously approved devices', () => {
    const { c } = setup();
    c.setPolicy('open');
    expect(c.join(req('123456'), 'a').status).toBe('approved');
    c.setPolicy('known');
    const p = profile(7);
    expect(c.join(req('123456', p), 'a').status).toBe('pending');
    // 'known' spans sessions of the same course on one teacher database.
    const db = openDb(':memory:');
    const s1 = new Classroom(db, 'OS', 'lan', { code: '111111' });
    const m = s1.join(req('111111', p), 'a');
    s1.setStatus(m.memberId, 'approved');
    const s2 = new Classroom(db, 'OS', 'lan', { code: '222222' });
    s2.setPolicy('known');
    expect(s2.join(req('222222', p), 'a').status).toBe('approved');
    expect(s2.join(req('222222'), 'a').status).toBe('pending');
  });

  it('locked and ended classrooms refuse joins', () => {
    const { c } = setup();
    c.setLocked(true);
    expect(() => c.join(req('123456'), 'a')).toThrowError(expect.objectContaining({ status: 423 }));
    c.setLocked(false);
    c.end();
    expect(() => c.join(req('123456'), 'a')).toThrowError(expect.objectContaining({ status: 410 }));
  });

  it('removed must be re-approved; blocked cannot rejoin; both lose their token', () => {
    const { c } = setup();
    c.setPolicy('open');
    const p = profile();
    const j = c.join(req('123456', p), 'a');
    c.setStatus(j.memberId, 'removed');
    expect(c.authenticate(j.token)).toBeNull();
    const again = c.join(req('123456', p), 'a');
    expect(again.memberId).toBe(j.memberId);
    expect(again.status).toBe('pending');
    c.setStatus(again.memberId, 'blocked');
    expect(() => c.join(req('123456', p), 'a')).toThrowError(expect.objectContaining({ code: 'blocked' }));
  });

  it('rejoin rotates the token (old one dies) and keeps approved status', () => {
    const { c } = setup();
    const p = profile();
    const j = c.join(req('123456', p), 'a');
    c.setStatus(j.memberId, 'approved');
    const j2 = c.join(req('123456', p), 'a');
    expect(j2.status).toBe('approved');
    expect(c.authenticate(j.token)).toBeNull();
    expect(c.authenticate(j2.token)).not.toBeNull();
  });

  it('tokens expire after idle period, activity slides expiry', () => {
    const { c, clock } = setup();
    const j = c.join(req('123456'), 'a');
    clock.advance(TOKEN_IDLE_MS - 1000);
    expect(c.authenticate(j.token)).not.toBeNull(); // slides
    clock.advance(TOKEN_IDLE_MS - 1000);
    expect(c.authenticate(j.token)).not.toBeNull();
    clock.advance(TOKEN_IDLE_MS + 1);
    expect(c.authenticate(j.token)).toBeNull();
  });

  it('state transitions: only pending can be approved/rejected', () => {
    const { c } = setup();
    const j = c.join(req('123456'), 'a');
    c.setStatus(j.memberId, 'rejected');
    expect(() => c.setStatus(j.memberId, 'approved')).toThrow(JoinError);
    expect(() => c.setStatus('nope', 'removed')).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it('presence logs connect/disconnect/reconnect once per transition', () => {
    const { c } = setup();
    const j = c.join(req('123456'), 'a');
    c.connected(j.memberId, true);
    c.connected(j.memberId, true); // second tab: no new row
    c.connected(j.memberId, false);
    c.connected(j.memberId, false);
    c.connected(j.memberId, true);
    const db = (c as unknown as { db: DatabaseSync }).db;
    const kinds = (db.prepare('SELECT kind FROM presence ORDER BY id').all() as { kind: string }[]).map((r) => r.kind);
    expect(kinds).toEqual(['connected', 'disconnected', 'reconnected']);
  });

  it('timeline records the class lifecycle', () => {
    const { c } = setup();
    const j = c.join(req('123456'), 'a');
    c.setStatus(j.memberId, 'approved');
    c.setLocked(true);
    c.end();
    expect(c.timeline().map((e) => e.type)).toEqual(['class.started', 'member.requested', 'member.approved', 'class.locked', 'class.ended']);
  });
});
