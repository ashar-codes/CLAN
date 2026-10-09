// Closed-beta hardening: resource exhaustion and malformed input on the live servers (classroom WSS, personal sync).
import { afterEach, describe, expect, it } from 'vitest';
import { createClassroomTls, startSyncServer, type SyncHost } from '../src/index.ts';
import { WS_CLOSE } from '@classroom/protocol';
import { pinnedTransport } from '@classroom/client/node';
import { classWith, socket } from './helpers.ts';

const closers: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); });

describe('classroom WSS', () => {
  it('a socket flooding messages is closed; a normal one is unaffected', async () => {
    const { s, students } = await classWith(2); closers.push(() => s.close());
    const flood = socket(s.url, students[0]!.token), calm = socket(s.url, students[1]!.token);
    await flood.next('hello'); await calm.next('hello');
    for (let i = 0; i < 400; i++) flood.send({ t: 'ping', n: i, at: Date.now() });
    expect((await flood.closed()).code).toBe(WS_CLOSE.badMessage);
    calm.send({ t: 'ping', n: 1, at: Date.now() });
    await calm.next('pong');
    calm.close();
  });
  it('malformed frames: bad JSON closes; unknown or invalid messages are answered with an error, not acted on', async () => {
    const { s, students } = await classWith(1); closers.push(() => s.close());
    const a = socket(s.url, students[0]!.token); await a.next('hello');
    a.send({ t: 'member.approve', memberId: students[0]!.memberId }); // host-only
    a.send({ t: 'nope', x: '\u0000'.repeat(100) });
    expect((await a.next('error')).code).toBeTruthy();
    a.send('{"t":');
    expect((await a.closed()).code).toBe(WS_CLOSE.badMessage);
  });
  it('a member whose network vanished (no close, no pong) is dropped and shown offline; a quiet but live one stays', async () => {
    const { s, students } = await classWith(2, { limits: { socketHeartbeatMs: 150 } }); closers.push(() => s.close());
    const lost = socket(s.url, students[0]!.token), quiet = socket(s.url, students[1]!.token);
    await lost.next('hello'); await quiet.next('hello');
    const online = () => Object.fromEntries(s.classroom.roster().map((m) => [m.id, m.connected]));
    expect(online()).toEqual({ [students[0]!.memberId]: true, [students[1]!.memberId]: true });
    (lost.ws as unknown as { _socket: { pause(): void } })._socket.pause(); // packets stop: like Wi-Fi gone, no FIN ever arrives
    await new Promise((r) => setTimeout(r, 600));
    expect(online()).toEqual({ [students[0]!.memberId]: false, [students[1]!.memberId]: true }); // quiet: its stack answers pings
    quiet.close();
  });
});

describe('personal sync server', () => {
  const host = (calls: string[]): SyncHost => ({
    verifyRequest: () => { calls.push('verify'); throw Object.assign(new Error('nope'), { code: 'bad_auth' }); }, bodySha: () => 'x',
    changes: () => ({ records: [], next: 0, more: false }), applyBatch: async () => ({ accepted: 0 }),
    linkStart: () => ({ sessionId: 's', nonceA: 'n' }), linkHello: () => { throw Object.assign(new Error('bad code'), { code: 'bad_code' }); }, linkStatus: () => ({ status: 'pending' }),
  });
  it('refuses oversized bodies before parsing, unsigned requests, garbage JSON and path tricks; link guessing locks out', async () => {
    const calls: string[] = [];
    const tls = await createClassroomTls('hardening', Date.now(), 3600_000);
    const srv = await startSyncServer({ host: host(calls), tls, bind: '127.0.0.1', objectPath: () => null });
    closers.push(srv.close);
    const base = `https://127.0.0.1:${srv.port}`, f = pinnedTransport(tls).fetch;
    const post = (path: string, body: string) => f(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    const big = await post('/sync/changes', 'x'.repeat(33 * 1024 * 1024)).then((r) => r.status, () => 'connection closed early');
    expect([413, 'connection closed early']).toContain(big); // refused at the Content-Length, before reading the body
    expect(calls).toEqual([]); // never reached authentication, never parsed
    expect((await post('/sync/changes', '{"records":[')).status).toBe(400);
    expect((await f(`${base}/sync/changes?since=0&limit=10`)).status).toBe(401);
    expect((await f(`${base}/sync/objects/..%2F..%2Fetc%2Fpasswd`)).status).toBe(401);
    let locked = false;
    for (let i = 0; i < 15 && !locked; i++) locked = (await post('/link/hello', '{}')).status === 429;
    expect(locked).toBe(true);
  }, 60_000);
});
