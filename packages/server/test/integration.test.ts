import { afterEach, describe, expect, it } from 'vitest';
import * as opaque from '@serenity-kit/opaque';
import { WS_CLOSE } from '@classroom/protocol';
import { ClassroomConnection, pairAndJoin, type Quality } from '@classroom/client';
import { pinnedTransport } from '@classroom/client/node';
import { startClassroomServer, type RunningServer } from '../src/index.ts';
import { device, names, postJoin, profile, secureJoin, socket, trFor, trustServer } from './helpers.ts';

const servers: RunningServer[] = [];
const start = async (title = 'Operating Systems') => {
  const s = await startClassroomServer({ title, host: '127.0.0.1', code: title === 'Other' ? '654321' : '482915' });
  servers.push(s);
  trustServer(s);
  return s;
};
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });
const pairStart = (s: RunningServer, body: unknown) => fetch(`${s.bootstrapUrl}/api/pair/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('join + approve over the network', () => {
  it('student joins by code, teacher sees request, approves, student is notified', async () => {
    const s = await start();
    const teacher = socket(s.url, s.classroom.teacherToken);
    expect((await teacher.next('hello')).role).toBe('teacher');

    const joined = await secureJoin(s, 1);
    expect(joined.status).toBe('pending');
    expect(joined.classroom.title).toBe('Operating Systems');
    expect(joined.url).toBe(s.url);

    const student = socket(s.url, joined.token);
    expect((await student.next('hello')).status).toBe('pending');
    const roster = await teacher.next('roster', (m) => m.members.some((x) => x.id === joined.memberId && x.connected));
    expect(roster.members[0]).toMatchObject({ fullName: 'Student 1', rollNo: 'FA23-CS-101', deviceName: 'Laptop-1', status: 'pending', trust: 'first' });

    teacher.send({ t: 'member.approve', memberId: joined.memberId });
    expect((await student.next('member.status')).status).toBe('approved');
    student.close(); teacher.close();
  });

  it('pairing picks the matching classroom among several on the LAN', async () => {
    const a = await start('Other');
    const b = await start();
    await opaque.ready;
    const cands = [{ url: a.bootstrapUrl, sid: a.classroom.id }, { url: b.bootstrapUrl, sid: b.classroom.id }];
    const r = await pairAndJoin({ candidates: cands, code: '482915', profile: names(), device: device(), opaque: opaque.client, transportFor: pinnedTransport });
    expect(r.url).toBe(b.url);
    await expect(pairAndJoin({ candidates: cands, code: '999999', profile: names(), device: device(), opaque: opaque.client, transportFor: pinnedTransport })).rejects.toMatchObject({ code: 'bad_code' });
  });

  it('reconnecting client restores session and presence shows reconnected', async () => {
    const s = await start();
    s.classroom.setPolicy('open');
    const j = await secureJoin(s);
    const qualities: Quality[] = [];
    let hellos = 0;
    const conn = new ClassroomConnection(s.url, j.token, { onMessage: (m) => { if (m.t === 'hello') hellos++; }, onQuality: (q) => qualities.push(q) }, 200, trFor(s.url));
    await until(() => hellos === 1 && qualities.includes('excellent'));
    // Simulate Wi-Fi drop: the socket dies with a non-fatal code.
    (conn as unknown as { ws: { close(c: number): void } }).ws.close(4999);
    await until(() => hellos === 2);
    const presence = (s.classroom as unknown as { db: import('node:sqlite').DatabaseSync }).db.prepare('SELECT kind FROM presence').all() as { kind: string }[];
    expect(presence.map((p) => p.kind)).toEqual(['connected', 'disconnected', 'reconnected']);
    conn.close();
  });
});

describe('security', () => {
  it('student cannot perform teacher actions', async () => {
    const s = await start();
    s.classroom.setPolicy('open');
    const j = await secureJoin(s, 1);
    const victim = await secureJoin(s, 2);
    const st = socket(s.url, j.token);
    await st.next('hello');
    for (const m of [{ t: 'member.remove', memberId: victim.memberId }, { t: 'class.lock', locked: true }, { t: 'class.end' }, { t: 'class.policy', policy: 'open' }]) {
      st.send(m);
      expect((await st.next('error')).code).toBe('forbidden');
    }
    expect(s.classroom.status(victim.memberId)).toBe('approved');
    expect(s.classroom.info()).toMatchObject({ locked: false, ended: false });
    // A client-claimed role field is ignored entirely.
    st.send({ t: 'class.end', role: 'teacher' });
    expect((await st.next('error')).code).toBe('forbidden');
    st.close();
  });

  it('invalid token, missing auth and garbage are rejected', async () => {
    const s = await start();
    const bad = socket(s.url, 'x'.repeat(43));
    expect((await bad.closed()).code).toBe(WS_CLOSE.authFailed);
    const noAuth = socket(s.url);
    await noAuth.opened;
    noAuth.send({ t: 'class.end' });
    expect((await noAuth.closed()).code).toBe(WS_CLOSE.authFailed);
    const garbage = socket(s.url);
    await garbage.opened;
    garbage.send('{not json');
    expect((await garbage.closed()).code).toBe(WS_CLOSE.badMessage);
    expect(s.classroom.info().ended).toBe(false);
  });

  it('tokens do not cross classrooms', async () => {
    const a = await start('Other');
    const b = await start();
    a.classroom.setPolicy('open');
    const j = await secureJoin(a);
    const s = socket(b.url, j.token);
    expect((await s.closed()).code).toBe(WS_CLOSE.authFailed);
    const t = socket(b.url, a.classroom.teacherToken);
    expect((await t.closed()).code).toBe(WS_CLOSE.authFailed);
  });

  it('code guessing is throttled at the pairing endpoint with Retry-After', async () => {
    const s = await start();
    for (let i = 0; i < 5; i++) await expect(secureJoin(s, 1, device(), String(100000 + i))).rejects.toMatchObject({ code: 'bad_code' });
    await expect(secureJoin(s)).rejects.toMatchObject({ code: 'throttled' });
    const res = await pairStart(s, { v: 1, sessionId: s.classroom.id, startLoginRequest: 'AAAA' });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('rejects malformed and oversized pairing / join bodies', async () => {
    const s = await start();
    expect((await pairStart(s, { v: 1, sessionId: 'nope', startLoginRequest: 'AAAA' })).status).toBe(400);
    expect((await pairStart(s, { v: 2, sessionId: s.classroom.id, startLoginRequest: 'AAAA' })).status).toBe(400);
    expect((await pairStart(s, { v: 1, sessionId: s.classroom.id, startLoginRequest: 'x'.repeat(20_000) })).status).toBe(413);
    expect((await postJoin(s.url, { v: 1, pairingId: crypto.randomUUID(), profile: { ...profile(), fullName: '<b>\u0007</b>' }, proof: { mac: 'a'.repeat(43), signature: 'a'.repeat(86) } })).status).toBe(400);
    expect((await postJoin(s.url, '{"v":', true)).status).toBe(400);
    expect((await postJoin(s.url, { v: 1, pairingId: crypto.randomUUID(), profile: { ...profile(), fullName: 'x'.repeat(100_000) } })).status).toBe(413);
    // Well-formed but never paired: refused.
    expect((await postJoin(s.url, { v: 1, pairingId: crypto.randomUUID(), profile: profile(), proof: { mac: 'a'.repeat(43), signature: 'a'.repeat(86) } })).status).toBe(403);
  });

  it('removed student is disconnected and cannot reconnect with the old token', async () => {
    const s = await start();
    s.classroom.setPolicy('open');
    const teacher = socket(s.url, s.classroom.teacherToken);
    await teacher.next('hello');
    const j = await secureJoin(s);
    const st = socket(s.url, j.token);
    await st.next('hello');
    teacher.send({ t: 'member.remove', memberId: j.memberId });
    expect((await st.next('member.status')).status).toBe('removed');
    expect((await st.closed()).code).toBe(WS_CLOSE.removed);
    expect((await socket(s.url, j.token).closed()).code).toBe(WS_CLOSE.authFailed);
    teacher.close();
  });

  it('locking blocks new joins; ending closes every socket', async () => {
    const s = await start();
    const teacher = socket(s.url, s.classroom.teacherToken);
    await teacher.next('hello');
    teacher.send({ t: 'class.lock', locked: true });
    await teacher.next('class.state', (m) => m.classroom.locked);
    await expect(secureJoin(s)).rejects.toMatchObject({ code: 'locked' });
    teacher.send({ t: 'class.end' });
    expect((await teacher.closed()).code).toBe(WS_CLOSE.ended);
  });
});

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not met');
    await new Promise((r) => setTimeout(r, 20));
  }
}
