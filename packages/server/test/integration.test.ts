import { afterEach, describe, expect, it } from 'vitest';
import { WS_CLOSE } from '@classroom/protocol';
import { joinByCode, ClassroomConnection, type Quality } from '@classroom/client';
import { startClassroomServer, type RunningServer } from '../src/index.ts';
import { post, profile, socket } from './helpers.ts';

const servers: RunningServer[] = [];
const start = async (title = 'Operating Systems') => {
  const s = await startClassroomServer({ title, host: '127.0.0.1', code: title === 'Other' ? '654321' : '482915' });
  servers.push(s);
  return s;
};
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

describe('join + approve over the network', () => {
  it('student joins by code, teacher sees request, approves, student is notified', async () => {
    const s = await start();
    const teacher = socket(s.url, s.classroom.teacherToken);
    expect((await teacher.next('hello')).role).toBe('teacher');

    const joined = await joinByCode([{ url: s.url }], '482915', profile(1));
    expect(joined.status).toBe('pending');
    expect(joined.classroom.title).toBe('Operating Systems');

    const student = socket(s.url, joined.token);
    expect((await student.next('hello')).status).toBe('pending');
    const roster = await teacher.next('roster', (m) => m.members.some((x) => x.id === joined.memberId && x.connected));
    expect(roster.members[0]).toMatchObject({ fullName: 'Student 1', rollNo: 'FA23-CS-101', deviceName: 'Laptop-1', status: 'pending' });

    teacher.send({ t: 'member.approve', memberId: joined.memberId });
    expect((await student.next('member.status')).status).toBe('approved');
    student.close(); teacher.close();
  });

  it('joinByCode picks the matching classroom among several on the LAN', async () => {
    const a = await start('Other');
    const b = await start();
    const r = await joinByCode([{ url: a.url }, { url: b.url }], '482915', profile());
    expect(r.url).toBe(b.url);
    await expect(joinByCode([{ url: a.url }, { url: b.url }], '999999', profile())).rejects.toMatchObject({ code: 'bad_code' });
  });

  it('reconnecting client restores session and presence shows reconnected', async () => {
    const s = await start();
    s.classroom.setPolicy('open');
    const j = await joinByCode([{ url: s.url }], '482915', profile());
    const qualities: Quality[] = [];
    let hellos = 0;
    const conn = new ClassroomConnection(s.url, j.token, { onMessage: (m) => { if (m.t === 'hello') hellos++; }, onQuality: (q) => qualities.push(q) }, 200);
    await until(() => hellos === 1 && qualities.includes('excellent'));
    // Simulate Wi-Fi drop: server side kills the socket abruptly.
    (conn as unknown as { ws: WebSocket }).ws.close(4999);
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
    const j = await joinByCode([{ url: s.url }], '482915', profile());
    const victim = await joinByCode([{ url: s.url }], '482915', profile(2));
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
    const j = await joinByCode([{ url: a.url }], '654321', profile());
    const s = socket(b.url, j.token);
    expect((await s.closed()).code).toBe(WS_CLOSE.authFailed);
    const t = socket(b.url, a.classroom.teacherToken);
    expect((await t.closed()).code).toBe(WS_CLOSE.authFailed);
  });

  it('code guessing is throttled over HTTP with Retry-After', async () => {
    const s = await start();
    for (let i = 0; i < 5; i++) expect((await post(s.url, { code: String(100000 + i), profile: profile(), protocol: 1 })).status).toBe(403);
    const r = await post(s.url, { code: '482915', profile: profile(), protocol: 1 });
    expect(r.status).toBe(429);
    expect(r.body.code).toBe('throttled');
  });

  it('rejects malformed and oversized join bodies', async () => {
    const s = await start();
    expect((await post(s.url, { code: '12345', profile: profile(), protocol: 1 })).status).toBe(400);
    expect((await post(s.url, { code: '482915', profile: { ...profile(), fullName: '<b>\u0007</b>' }, protocol: 1 })).status).toBe(400);
    expect((await post(s.url, '{"code":', true)).status).toBe(400);
    expect((await post(s.url, { code: '482915', profile: { ...profile(), fullName: 'x'.repeat(100_000) }, protocol: 1 })).status).toBe(413);
  });

  it('removed student is disconnected and cannot reconnect with the old token', async () => {
    const s = await start();
    s.classroom.setPolicy('open');
    const teacher = socket(s.url, s.classroom.teacherToken);
    await teacher.next('hello');
    const j = await joinByCode([{ url: s.url }], '482915', profile());
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
    expect((await post(s.url, { code: '482915', profile: profile(), protocol: 1 })).status).toBe(423);
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
