import { afterEach, expect, it } from 'vitest';
import { Classroom, openDb, startClassroomServer, type RunningServer } from '../src/index.ts';
import { ClientMessage } from '@classroom/protocol';
import { device, profile, secureJoin, socket, tmp, trustServer } from './helpers.ts';
const servers: RunningServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.close(); });
it('requires approval, deduplicates delivery, bounds changes and never changes permissions', () => {
  const db = openDb(':memory:'); let now = 1000;
  try {
    const c = new Classroom(db, 'Hands', 'lan', { now: () => now }), a = c.join(profile(1));
    const p = { role: 'student' as const, memberId: a.memberId }, h = { role: 'teacher' as const };
    expect(() => c.setHand(p, true)).toThrow('Approved members'); c.setStatus(a.memberId, 'approved');
    const before = c.capabilities(p); c.setHand(p, true); c.setHand(p, true);
    expect(c.handView(h).hands).toHaveLength(1); expect(c.handView(p)).toMatchObject({ mine: true, hands: [] }); expect(c.capabilities(p)).toEqual(before);
    expect(() => c.setHand(p, false)).toThrow('Wait briefly'); now += 1000; c.setHand(p, false); expect(c.handView(h).hands).toEqual([]);
    expect(() => c.setHand(h, true)).toThrow(); expect(() => c.dismissHand(p, a.memberId)).toThrow('Host only');
    expect(ClientMessage.safeParse({ t: 'hand.set', raised: true, memberId: a.memberId }).success).toBe(false);
  } finally { db.close(); }
});
it('clears hands on revocation, last socket departure and session end; session boundaries hold', () => {
  const db = openDb(':memory:'); let now = 1000;
  try {
    const c = new Classroom(db, 'Hands', 'lan', { now: () => now }); c.setPolicy('open'); const a = c.join(profile(1)), p = { role: 'student' as const, memberId: a.memberId }, h = { role: 'teacher' as const };
    c.connected(a.memberId, true); c.connected(a.memberId, true); c.setHand(p, true);
    c.connected(a.memberId, false); expect(c.handView(p).mine).toBe(true); c.connected(a.memberId, false); expect(c.handView(p).mine).toBe(false);
    c.setHand(p, true); c.dismissHand(h, a.memberId); expect(c.handView(p).mine).toBe(false); now += 1000; c.setHand(p, true); c.setStatus(a.memberId, 'removed'); expect(c.handView(h).hands).toEqual([]); expect(() => c.setHand(p, true)).toThrow();
    const other = new Classroom(db, 'Other', 'lan'); expect(() => other.setHand(p, true)).toThrow(); expect(() => other.dismissHand(h, a.memberId)).toThrow();
    const b = c.join(profile(2)); c.setHand({ role: 'student', memberId: b.memberId }, true); c.end(); expect(c.handView(h).hands).toEqual([]); expect(() => c.setHand({ role: 'student', memberId: b.memberId }, true)).toThrow();
  } finally { db.close(); }
});
it('real pinned WSS exposes hands only to the host, acknowledges duplicates, restores own state on reconnect and forbids pending/spoofed control', async () => {
  const s = await startClassroomServer({ title: 'Hands', host: '127.0.0.1', storageDir: tmp('hands-') }); servers.push(s); trustServer(s);
  const a = await secureJoin(s, 1, device()), b = await secureJoin(s, 2, device());
  const host = socket(s.url, s.classroom.teacherToken), one = socket(s.url, a.token), two = socket(s.url, b.token);
  await Promise.all([host.opened, one.opened, two.opened]); await host.next('hello'); await one.next('hello'); await two.next('hello');
  one.send({ t: 'hand.set', raised: true }); expect((await one.next('error')).code).toBe('forbidden');
  host.send({ t: 'member.approve', memberId: a.memberId }); host.send({ t: 'member.approve', memberId: b.memberId }); await one.next('member.status', (m) => m.status === 'approved'); await two.next('member.status', (m) => m.status === 'approved');
  one.send({ t: 'hand.set', raised: true }); expect((await host.next('hands', (m) => m.hands.length === 1)).hands[0]?.memberId).toBe(a.memberId);
  expect(await one.next('hands', (m) => m.mine)).toMatchObject({ mine: true, hands: [] }); expect(await two.next('hands')).toMatchObject({ mine: false, hands: [] });
  one.send({ t: 'hand.set', raised: true }); expect((await one.next('hands', (m) => m.mine)).hands).toEqual([]);
  one.send({ t: 'hand.dismiss', memberId: b.memberId }); expect((await one.next('error')).code).toBe('forbidden');
  const reconnect = socket(s.url, a.token); await reconnect.opened; await reconnect.next('hello'); expect((await reconnect.next('hands')).mine).toBe(true);
  host.send({ t: 'hand.dismiss', memberId: a.memberId }); await one.next('hands', (m) => !m.mine); await reconnect.next('hands', (m) => !m.mine);
  for (const w of [host, one, two, reconnect]) w.close();
});
