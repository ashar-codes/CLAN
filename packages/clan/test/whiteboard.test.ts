// Whiteboard: the shared reducer (convergence, idempotency, undo) and the host relay over the real pinned WSS
// (authorization, ordering, persistence across hosting again, member editing, resource rules, wall switching).
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { applyOp, emptyBoard, inverse, replay, visible, simplify, hit, type WbLogged, type WbObjectData, type WbOp } from '@classroom/protocol';
import { openDb, startClassroomServer, type RunningServer } from '@classroom/server';
import { makeFile, secureJoin, socket, tmp, trustServer } from '../../server/test/helpers.ts';
import { openClan } from '../src/index.ts';
import { setup, user } from './helpers.ts';

const put = (obj: string, clock: number, data: Partial<WbObjectData> = {}): WbOp => ({ t: 'put', id: randomUUID(), obj, clock, data: { kind: 'rect', page: 0, x: 0, y: 0, w: 10, h: 10, color: '#112233', width: 2, z: 0, ...data } });
const patch = (obj: string, clock: number, data: object): WbOp => ({ t: 'patch', id: randomUUID(), obj, clock, data });
const del = (obj: string, clock: number): WbOp => ({ t: 'del', id: randomUUID(), obj, clock });
const shuffle = <T>(xs: T[], seed: number) => { const a = [...xs]; let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 9301 + 49297) % 233280; const j = Math.floor((s / 233280) * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
const snapshotOf = (s: ReturnType<typeof emptyBoard>) => JSON.stringify(visible(s).map((o) => [o.id, o.x, o.color, o.text ?? '']));

describe('whiteboard reducer', () => {
  it('concurrent edits converge in any arrival order; replays and duplicates change nothing', () => {
    const a = randomUUID(), b = randomUUID();
    const ops: [string, WbOp][] = [
      ['ali', put(a, 1)], ['sara', put(b, 1, { kind: 'sticky', text: 'idea' } as never)],
      ['ali', patch(a, 2, { x: 50 })], ['sara', patch(a, 2, { x: 99, color: '#ff0000' })], // concurrent same-clock patches
      ['ali', del(b, 3)], ['sara', patch(b, 4, { text: 'edited after delete' })], // patch never resurrects
      ['sara', patch(a, 5, { color: '#00ff00' })],
    ];
    const results = new Set<string>();
    for (let seed = 1; seed <= 40; seed++) { const s = emptyBoard(); for (const [who, op] of shuffle(ops, seed)) applyOp(s, who, op); results.add(snapshotOf(s)); }
    expect(results.size).toBe(1);
    const s = emptyBoard(); for (const [who, op] of ops) applyOp(s, who, op);
    expect(visible(s).map((o) => o.id)).toEqual([a]);
    expect(visible(s)[0]).toMatchObject({ x: 99, color: '#00ff00' }); // 'sara' > 'ali' breaks the clock-2 tie
    const before = snapshotOf(s);
    for (const [who, op] of ops) expect(applyOp(s, who, op)).toBe(false); // idempotent
    expect(snapshotOf(s)).toBe(before);
    const log: WbLogged[] = ops.map(([author, op], i) => ({ seq: i + 1, author, at: 0, op }));
    expect(snapshotOf(replay(shuffle(log, 7)))).toBe(before); // replay sorts by seq
  });
  it('undo is an op (inverse), so it syncs like any edit; geometry helpers', () => {
    const s = emptyBoard(), o = randomUUID();
    const p1 = put(o, 1); applyOp(s, 'me', p1);
    const before = s.objects.get(o);
    const mv = patch(o, 2, { x: 30 }); applyOp(s, 'me', mv);
    applyOp(s, 'me', inverse(before, mv, 3, randomUUID())!);
    expect(s.objects.get(o)!.x).toBe(0);
    const d = del(o, 4), pre = s.objects.get(o); applyOp(s, 'me', d);
    expect(visible(s)).toEqual([]);
    applyOp(s, 'me', inverse(pre, d, 5, randomUUID())!); // restore
    expect(visible(s)).toHaveLength(1);
    expect(simplify([[0, 0], [1, 0.01], [2, 0], [3, 0.02], [4, 0]]).length).toBe(2);
    const st = randomUUID(); applyOp(s, 'me', put(st, 6, { kind: 'stroke', x: 100, y: 100, points: [[0, 0], [20, 0]], width: 2 } as never));
    expect(hit(s, 0, 110, 101)?.id).toBe(st);
    expect(hit(s, 0, 500, 500)).toBeNull();
  });
  it('local boards: personal is private, course boards belong to the course owner, CLAN boards to members; agents never', () => {
    const { app } = setup();
    const me = user(app.me), bob = user(app.identity.createUser('Bob'));
    const mine = app.whiteboard.create(me, { kind: 'personal', id: app.me }, 'Ideas');
    app.whiteboard.edit(me, mine.id, [put(randomUUID(), 1)]);
    expect(app.whiteboard.get(bob, mine.id)).toBeNull();
    expect(() => app.whiteboard.edit(bob, mine.id, [put(randomUUID(), 1)])).toThrow();
    expect(app.whiteboard.get({ kind: 'agent', agentId: 'guide', onBehalfOf: app.me, scopes: ['notes:read'] }, mine.id)).toBeNull();
    const c = app.courses.create(me, { name: 'OS' });
    const cb = app.whiteboard.create(me, { kind: 'course', id: c.id }, 'OS board');
    expect(() => app.whiteboard.create(bob, { kind: 'course', id: c.id }, 'x')).toThrow();
    expect(app.whiteboard.read(me, cb.id).snapshot).toBe(true);
    expect(app.whiteboard.read(me, mine.id).ops).toHaveLength(1);
  });
});

const servers: RunningServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });
async function host(db: ReturnType<typeof openDb>, clanId: string, type: 'STUDY_GROUP' | 'CLASSROOM' | 'TEMPORARY' = 'STUDY_GROUP', storageDir = tmp('wb-host-')) {
  const app = openClan(db, { storageDir });
  if (!app.clans.get(clanId)) app.clans.create({ id: clanId, type, name: 'Board CLAN', createdBy: app.me, expiresAt: type === 'TEMPORARY' ? Date.now() + 3600_000 : undefined });
  const s = await startClassroomServer({ title: 'Board CLAN', host: '127.0.0.1', db, storageDir, chat: app.chat, whiteboard: app.whiteboard, hostName: 'Hana', clan: { type, id: clanId } });
  servers.push(s); trustServer(s); s.classroom.setPolicy('open');
  return { s, app, storageDir };
}
async function member(s: RunningServer, n: number) {
  const j = await secureJoin(s, n);
  const ws = socket(s.url, j.token); await ws.opened; await ws.next('hello');
  return { ...j, ws };
}
const hostWs = async (s: RunningServer) => { const w = socket(s.url, s.classroom.teacherToken); await w.opened; await w.next('hello'); return w; };

describe('whiteboard over the CLAN connection', () => {
  it('two members draw at once; everyone gets the same ordered ops; duplicates are idempotent; reconnect resumes; hosting again keeps the board', async () => {
    const db = openDb(':memory:'), clanId = randomUUID();
    const { s, storageDir } = await host(db, clanId);
    const a = await member(s, 1), b = await member(s, 2);
    for (const w of [a.ws, b.ws]) { w.send({ t: 'wb.sync', since: 0 }); expect((await w.next('wb.state')).board).toMatchObject({ canEdit: true, canManage: false }); }
    const sa = put(randomUUID(), 1, { kind: 'stroke', points: [[0, 0], [10, 10]] } as never), sb = put(randomUUID(), 1, { kind: 'sticky', text: 'Deadlock?' } as never);
    a.ws.send({ t: 'wb.ops', ops: [sa] }); b.ws.send({ t: 'wb.ops', ops: [sb] });
    const got: WbLogged[] = [];
    while (got.length < 2) got.push(...(await a.ws.next('wb.op')).ops);
    const gotB: WbLogged[] = [];
    while (gotB.length < 2) gotB.push(...(await b.ws.next('wb.op')).ops);
    expect(got.map((x) => x.seq)).toEqual([1, 2]);
    expect(gotB.map((x) => x.op.id)).toEqual(got.map((x) => x.op.id)); // same order for everyone
    a.ws.send({ t: 'wb.ops', ops: [sa] }); // retry of an already-stored op
    expect((await a.ws.next('wb.ack', (x) => x.headSeq === 2)).ids).toEqual([sa.id]); // acknowledged, nothing new logged
    // disconnect → more edits → reconnect from the last seq seen
    a.ws.close();
    b.ws.send({ t: 'wb.ops', ops: [patch(sb.obj, 2, { text: 'Deadlock: 4 conditions' })] }); await b.ws.next('wb.ack');
    const a2 = socket(s.url, a.token); await a2.opened; await a2.next('hello');
    a2.send({ t: 'wb.sync', since: 2 });
    const resumed = await a2.next('wb.state');
    expect(resumed).toMatchObject({ snapshot: false });
    expect(resumed.ops.map((x: WbLogged) => x.seq)).toEqual([3]);
    // host again (same CLAN, new session): the board and its history are still there
    await s.close(); servers.splice(servers.indexOf(s), 1);
    const again = await host(db, clanId, 'STUDY_GROUP', storageDir);
    const c = await member(again.s, 3);
    c.ws.send({ t: 'wb.sync', since: 0 });
    const st = await c.ws.next('wb.state');
    expect(st.snapshot).toBe(true);
    const board = replay(st.ops);
    expect(visible(board).map((o) => o.text ?? o.kind).sort()).toEqual(['Deadlock: 4 conditions', 'stroke']);
  });

  it('Classroom: members view only until the host enables editing; private files cannot be placed; removal revokes', async () => {
    const { s } = await host(openDb(':memory:'), randomUUID(), 'CLASSROOM');
    const h = await hostWs(s), m = await member(s, 1);
    m.ws.send({ t: 'wb.sync', since: 0 });
    expect((await m.ws.next('wb.state')).board).toMatchObject({ canEdit: false, memberEdit: false });
    const op = put(randomUUID(), 1);
    m.ws.send({ t: 'wb.ops', ops: [op] });
    expect((await m.ws.next('wb.nack')).code).toBe('forbidden');
    m.ws.send({ t: 'wb.memberEdit', on: true }); // members can't change it
    expect((await m.ws.next('error')).code).toBe('forbidden');
    h.send({ t: 'wb.memberEdit', on: true });
    expect((await m.ws.next('wb.wall', (x) => x.board.canEdit)).board.memberEdit).toBe(true);
    m.ws.send({ t: 'wb.ops', ops: [op] });
    expect((await h.next('wb.op')).ops[0]!.op.id).toBe(op.id);
    // resource references: only files on the table
    const ref = put(randomUUID(), 2, { kind: 'resource', ref: { module: 'resource', id: randomUUID(), title: 'secret.pdf' } } as never);
    m.ws.send({ t: 'wb.ops', ops: [ref] });
    expect((await m.ws.next('wb.nack')).code).toBe('not_shared');
    const shared = await s.resources.importFile(makeFile(1000, 'slides.pdf').path, 'slides.pdf');
    m.ws.send({ t: 'wb.ops', ops: [put(randomUUID(), 3, { kind: 'resource', ref: { module: 'resource', id: shared.id, title: 'slides.pdf' } } as never)] });
    await m.ws.next('wb.ack');
    // removed: socket closed; the token no longer works
    s.classroom.setStatus(m.memberId, 'removed');
    expect((await m.ws.closed()).code).toBe(4003);
    const again = socket(s.url, m.token); await again.opened;
    expect((await again.closed()).code).toBeGreaterThan(4000);
  });

  it('the wall: whiteboard vs a presentation needs an explicit, authorized switch; cross-CLAN sockets never see the board', async () => {
    const { s } = await host(openDb(':memory:'), randomUUID(), 'STUDY_GROUP');
    const h = await hostWs(s), a = await member(s, 1), b = await member(s, 2);
    // Sara (b) is presenting
    s.presentations.current = { id: randomUUID(), presenter: b.memberId, presenterName: 'Sara', identity: b.memberId, source: 'screen', audio: false, state: 'live', startedAt: Date.now() } as never;
    a.ws.send({ t: 'wb.wall', mode: 'WHITEBOARD' });
    expect((await a.ws.next('error')).code).toBe('presenting');
    a.ws.send({ t: 'wb.wall', mode: 'WHITEBOARD', takeover: true }); // a member may not stop someone else's presentation
    expect((await a.ws.next('error')).message).toMatch(/Ask the host to switch from Sara/);
    h.send({ t: 'wb.wall', mode: 'WHITEBOARD', takeover: true });
    expect((await b.ws.next('wb.wall', (x) => x.mode === 'WHITEBOARD')).by).toBe(s.chat!.hostHandle);
    expect(s.presentations.current).toBeNull();
    expect(s.classroom.status(b.memberId)).toBe('approved'); // membership untouched
    // presenting while the board is on the wall needs a takeover too
    b.ws.send({ t: 'present.start', source: 'screen', audio: false });
    expect((await b.ws.next('error')).code).toBe('whiteboard');
    // another CLAN's session: separate board, and its sockets get nothing from this one
    const other = await host(openDb(':memory:'), randomUUID());
    const x = await member(other.s, 1);
    x.ws.send({ t: 'wb.sync', since: 0 });
    expect((await x.ws.next('wb.state')).board.id).not.toBe(s.whiteboard!.boardId);
    a.ws.send({ t: 'wb.ops', ops: [put(randomUUID(), 1)] }); await a.ws.next('wb.ack');
    await expect(x.ws.next('wb.op', () => true, 400)).rejects.toThrow();
  });
});
