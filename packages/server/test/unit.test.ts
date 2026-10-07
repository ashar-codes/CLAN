import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { Classroom, JoinError, newJoinCode, TOKEN_IDLE_MS } from '../src/classroom.ts';
import { migrate, openDb } from '../src/db.ts';
import { Throttle } from '../src/throttle.ts';
import * as opaque from '@serenity-kit/opaque';
import { StudentProfile, keyFingerprint } from '@classroom/protocol';
import { opaqueIdentifiers } from '@classroom/client';
import { Pairing } from '../src/pairing.ts';
import { ephemeralIdentity } from '../src/server.ts';
import { device, profile } from './helpers.ts';

const setup = (code = '123456') => {
  let t = 1_000_000;
  const clock = { now: () => t, advance: (ms: number) => (t += ms) };
  return { c: new Classroom(openDb(':memory:'), 'Operating Systems', 'lan', { now: clock.now, code }), clock };
};

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
  it('rejects control characters, blanks and bad device keys', () => {
    expect(StudentProfile.safeParse({ ...profile(), fullName: 'a\u0000b' }).success).toBe(false);
    expect(StudentProfile.safeParse({ ...profile(), fullName: '   ' }).success).toBe(false);
    expect(StudentProfile.safeParse({ ...profile(), devicePublicKey: 'MacBook' }).success).toBe(false);
    expect(StudentProfile.safeParse({ ...profile(), devicePublicKey: undefined, deviceId: '0b6f1c8e-5b1a-4c55-9a8b-0f0e1d2c3b4a' }).success).toBe(false);
    expect(StudentProfile.safeParse({ ...profile(), fullName: 'x'.repeat(81) }).success).toBe(false);
    expect(StudentProfile.safeParse(profile()).success).toBe(true);
  });
});

describe('classroom membership', () => {
  it('defaults to pending; approval activates the same token', () => {
    const { c } = setup();
    const j = c.join(profile());
    expect(j.status).toBe('pending');
    expect(c.authenticate(j.token)).toEqual({ role: 'student', memberId: j.memberId });
    c.setStatus(j.memberId, 'approved');
    expect(c.status(j.memberId)).toBe('approved');
  });

  it('wrong code is throttled per source, then globally (each OPAQUE start counts as one guess)', async () => {
    const { c, clock } = setup();
    const pairing = await Pairing.create(c, (await ephemeralIdentity()).opaqueServerSetup, '123456',
      () => ({ httpsPort: 1, spkiSha256: 'x', certificate: 'x', teacherPublicKey: 'x', title: 'OS' }));
    const attempt = (code: string, src: string) => {
      const l = opaque.client.startLogin({ password: code });
      const r = pairing.start(src, c.id, l.startLoginRequest);
      const f = opaque.client.finishLogin({ clientLoginState: l.clientLoginState, loginResponse: r.loginResponse, password: code, identifiers: opaqueIdentifiers(c.id) });
      if (!f) { pairing.abort(src, r.pairingId); throw new Error('Wrong classroom code'); }
      return pairing.finish(src, r.pairingId, f.finishLoginRequest);
    };
    for (let i = 0; i < 5; i++) expect(() => attempt('000000', 'ip1')).toThrow(/Wrong classroom code/);
    // Locked even with the correct code.
    expect(() => attempt('123456', 'ip1')).toThrowError(expect.objectContaining({ status: 429 }));
    expect(attempt('123456', 'ip2').binding.sessionId).toBe(c.id);
    clock.advance(5 * 60_000 + 1);
    expect(attempt('123456', 'ip1').binding.sessionId).toBe(c.id);
    // Successful pairings never count, so a full class can join without tripping the limits.
    for (let i = 0; i < 12; i++) attempt('123456', 'ip3'); // > the 5-per-source limit
    // Distributed guessing: 50 failures across many sources locks the classroom briefly.
    for (let i = 0; i < 50; i++) { try { attempt('000001', `bot${i}`); } catch {} }
    expect(() => attempt('123456', 'fresh-ip')).toThrowError(expect.objectContaining({ code: 'throttled' }));
  });

  it('policies: open auto-approves, known approves previously approved devices', () => {
    const { c } = setup();
    c.setPolicy('open');
    expect(c.join(profile()).status).toBe('approved');
    c.setPolicy('known');
    const p = profile(7);
    expect(c.join(p).status).toBe('pending');
    // 'known' spans sessions of the same course on one teacher database.
    const db = openDb(':memory:');
    const s1 = new Classroom(db, 'OS', 'lan', { code: '111111' });
    const m = s1.join(p);
    s1.setStatus(m.memberId, 'approved');
    const s2 = new Classroom(db, 'OS', 'lan', { code: '222222' });
    s2.setPolicy('known');
    // Known = the exact device key approved before.
    expect(s2.join(p).status).toBe('approved');
    expect(s2.roster()[0]).toMatchObject({ trust: 'known', deviceFingerprint: keyFingerprint(p.devicePublicKey) });
    expect(s2.join(profile()).status).toBe('pending');
    // Same name + roll number from a different key: not trusted, flagged as a new device.
    const thief = s2.join({ ...p, devicePublicKey: device().publicKey });
    expect(thief.status).toBe('pending');
    expect(s2.roster().find((x) => x.id === thief.memberId)!.trust).toBe('new_device');
  });

  it('locked and ended classrooms refuse joins', () => {
    const { c } = setup();
    c.setLocked(true);
    expect(() => c.join(profile())).toThrowError(expect.objectContaining({ status: 423 }));
    c.setLocked(false);
    c.end();
    expect(() => c.join(profile())).toThrowError(expect.objectContaining({ status: 410 }));
  });

  it('removed must be re-approved; blocked cannot rejoin; both lose their token', () => {
    const { c } = setup();
    c.setPolicy('open');
    const p = profile();
    const j = c.join(p);
    c.setStatus(j.memberId, 'removed');
    expect(c.authenticate(j.token)).toBeNull();
    const again = c.join(p);
    expect(again.memberId).toBe(j.memberId);
    expect(again.status).toBe('pending');
    c.setStatus(again.memberId, 'blocked');
    expect(() => c.join(p)).toThrowError(expect.objectContaining({ code: 'blocked' }));
  });

  it('rejoin rotates the token (old one dies) and keeps approved status', () => {
    const { c } = setup();
    const p = profile();
    const j = c.join(p);
    c.setStatus(j.memberId, 'approved');
    const j2 = c.join(p);
    expect(j2.status).toBe('approved');
    expect(c.authenticate(j.token)).toBeNull();
    expect(c.authenticate(j2.token)).not.toBeNull();
  });

  it('tokens expire after idle period, activity slides expiry', () => {
    const { c, clock } = setup();
    const j = c.join(profile());
    clock.advance(TOKEN_IDLE_MS - 1000);
    expect(c.authenticate(j.token)).not.toBeNull(); // slides
    clock.advance(TOKEN_IDLE_MS - 1000);
    expect(c.authenticate(j.token)).not.toBeNull();
    clock.advance(TOKEN_IDLE_MS + 1);
    expect(c.authenticate(j.token)).toBeNull();
  });

  it('state transitions: only pending can be approved/rejected', () => {
    const { c } = setup();
    const j = c.join(profile());
    c.setStatus(j.memberId, 'rejected');
    expect(() => c.setStatus(j.memberId, 'approved')).toThrow(JoinError);
    expect(() => c.setStatus('nope', 'removed')).toThrowError(expect.objectContaining({ status: 404 }));
  });

  it('presence logs connect/disconnect/reconnect once per transition', () => {
    const { c } = setup();
    const j = c.join(profile());
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
    const j = c.join(profile());
    c.setStatus(j.memberId, 'approved');
    c.setLocked(true);
    c.end();
    expect(c.timeline().map((e) => e.type)).toEqual(['class.started', 'member.requested', 'member.approved', 'class.locked', 'class.ended']);
  });
});

import { contentDisposition, parseRange, Storage } from '../src/storage.ts';
import { safeFileName, extensionOf } from '@classroom/protocol';

describe('file primitives', () => {
  it('parseRange', () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=90-', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-5', 100)).toEqual({ start: 95, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=50-1000', 100)).toEqual({ start: 50, end: 99 });
    for (const bad of ['bytes=100-', 'bytes=9-0', 'bytes=0-1,3-4', 'bytes=-0', 'bytes=-', 'chars=0-1', 'bytes=a-b', ' bytes = 0-1', 'bytes=1234567890123456-']) expect(parseRange(bad, 100), bad).toBe('invalid');
    expect(parseRange('bytes=0-0', 0)).toBe('invalid');
  });

  it('safeFileName handles traversal, reserved names, unicode and length', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd');
    expect(safeFileName('..\\..\\boot.ini')).toBe('boot.ini');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName('/')).toBe('file');
    expect(safeFileName('')).toBe('file');
    expect(safeFileName('nul.txt')).toBe('_nul.txt');
    expect(safeFileName('COM1')).toBe('_COM1');
    expect(safeFileName('lpt9.pdf')).toBe('_lpt9.pdf');
    expect(safeFileName('a\u0000b')).toBe('a_b');
    expect(safeFileName('report‮fdp.exe')).toBe('report_fdp.exe');
    expect(safeFileName('name. . .')).toBe('name');
    expect(safeFileName('é.txt')).toBe('é.txt'); // NFC
    const long = safeFileName('😀'.repeat(200) + '.pdf');
    expect(new TextEncoder().encode(long).length).toBeLessThanOrEqual(120);
    expect(long.endsWith('.pdf')).toBe(true);
    expect(safeFileName('x'.repeat(5_000_000)).length).toBeLessThanOrEqual(120); // bounded work
    expect(extensionOf('Lab.ZIP')).toBe('zip');
    expect(extensionOf('archive.tar.gz')).toBe('gz');
    expect(extensionOf('.bashrc')).toBe('');
  });

  it('contentDisposition cannot inject headers or quotes', () => {
    const v = contentDisposition('a"b\r\nSet-Cookie: x=1;é.pdf');
    expect(v).not.toMatch(/[\r\n]/);
    expect(v.match(/"/g)).toHaveLength(2);
    expect(v).toContain("filename*=UTF-8''a%22b%0D%0ASet-Cookie%3A%20x%3D1%3B%C3%A9.pdf");
  });

  it('Storage refuses ids and names that would leave the root', () => {
    const st = new Storage('/srv/storage');
    expect(st.resource('0b6f1c8e-5b1a-4c55-9a8b-0f0e1d2c3b4a')).toBe('/srv/storage/resources/0b6f1c8e-5b1a-4c55-9a8b-0f0e1d2c3b4a');
    for (const bad of ['../x', '..', '/etc/passwd', 'a/b', '0B6F1C8E-5B1A-4C55-9A8B-0F0E1D2C3B4A ']) expect(() => st.resource(bad)).toThrow();
    const sid = '0b6f1c8e-5b1a-4c55-9a8b-0f0e1d2c3b4a';
    expect(() => st.submissionFile(sid, sid, '../x')).toThrow();
    expect(() => st.submissionFile(sid, sid, '..')).toThrow();
    expect(() => st.abs('../../etc/passwd')).toThrow();
    expect(st.abs('submissions/x/y')).toBe('/srv/storage/submissions/x/y');
  });
});
