// Screen sharing over the local SFU (self-hosted LiveKit) with the real CLAN server, real joins, real WebRTC media.
// Headless participants use @livekit/rtc-node. Bound to this machine's LAN interface (libwebrtc ignores loopback).
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dispose, LocalVideoTrack, Room, RoomEvent, TrackPublishOptions, TrackSource, VideoBufferType, VideoFrame, VideoSource, VideoStream } from '@livekit/rtc-node';
import { candidateInterfaces, MediaService, startClassroomServer, type RunningServer } from '../src/index.ts';
import { device, secureJoin, socket, tmp, trFor, trustServer } from './helpers.ts';

const lan = candidateInterfaces().find((i) => i.private)?.address;
const binary = join(import.meta.dirname, '../../../native/livekit/bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
const servers: RunningServer[] = [];
const rooms: Room[] = [];
afterEach(async () => { await Promise.all(rooms.splice(0).map((r) => r.disconnect().catch(() => {}))); await Promise.all(servers.splice(0).map((s) => s.close())); });
afterAll(async () => { await dispose(); });

async function clan(type: 'CLASSROOM' | 'STUDY_GROUP' | 'FRIENDS', graceMs = 20_000) {
  const s = await startClassroomServer({ title: `${type} media`, host: lan!, storageDir: tmp('media-'), clan: { type, id: randomUUID() }, hostName: 'Ayesha',
    media: { binary, workDir: tmp('lk-'), presenterGraceMs: graceMs } });
  servers.push(s); trustServer(s);
  s.classroom.setPolicy('open');
  return s;
}
async function member(s: RunningServer, n: number) {
  const j = await secureJoin(s, n, device());
  const ws = socket(s.url, j.token); await ws.opened; await ws.next('hello');
  return { ...j, ws };
}
const host = async (s: RunningServer) => { const ws = socket(s.url, s.classroom.teacherToken); await ws.opened; await ws.next('hello'); return ws; };
const mediaToken = async (s: RunningServer, token: string) => (await (await trFor(s.url).fetch(`${s.url}/api/media/token`, { method: 'POST', headers: { authorization: `Bearer ${token}` } })).json()) as { token: string; identity: string; expiresAt: number };
const jwt = (t: string) => JSON.parse(Buffer.from(t.split('.')[1]!, 'base64url').toString()) as { sub: string; exp: number; nbf?: number; video: { room: string; canPublish: boolean; canSubscribe: boolean; canPublishSources?: string[] } };
const lastReason = (s: RunningServer) => ((s.classroom as unknown as { db: { prepare(q: string): { get(): unknown } } }).db.prepare('SELECT stop_reason r FROM presentations ORDER BY started_at DESC LIMIT 1').get() as { r: string }).r;
const until = async (f: () => boolean | Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (!(await f())) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 50)); } };
async function connect(url: string, token: string) { const r = new Room(); rooms.push(r); await r.connect(url, token, { autoSubscribe: true, dynacast: true }); return r; }
/** Deterministic test-only capture source: a moving block + frame counter encoded in pixels. */
function pattern(room: Room) {
  const W = 480, H = 270, src = new VideoSource(W, H);
  let f = 0, stop = false;
  const tick = () => { if (stop) return; const d = new Uint8Array(W * H * 4); const x = (f * 11) % (W - 60); for (let y = 0; y < H; y++) for (let i = x; i < x + 60; i++) { const k = (y * W + i) * 4; d[k] = 255; d[k + 1] = f & 255; d[k + 3] = 255; } src.captureFrame(new VideoFrame(d, W, H, VideoBufferType.RGBA)); f++; setTimeout(tick, 66); };
  const opts = new TrackPublishOptions(); opts.source = TrackSource.SOURCE_SCREENSHARE;
  return { publish: async () => { await room.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack('screen', src), opts); tick(); }, stop: () => { stop = true; } };
}
function frameCounter(room: Room) {
  const seen = new Set<number>(); let frames = 0;
  room.on(RoomEvent.TrackSubscribed, async (track) => { for await (const ev of new VideoStream(track)) { frames++; const d = ev.frame.data; let h = 0; for (let i = 0; i < d.length; i += 811) h = (h * 31 + d[i]!) >>> 0; seen.add(h); } });
  return { get frames() { return frames; }, get distinct() { return seen.size; } };
}

describe.skipIf(!lan || !existsSync(binary))('screen sharing (local SFU)', () => {
  it('Classroom: members must ask; the host approves; the approved member presents; the host stops it (server-side)', async () => {
    const s = await clan('CLASSROOM');
    const h = await host(s), a = await member(s, 1);
    a.ws.send({ t: 'present.start', source: 'screen', audio: false });
    expect((await a.ws.next('error')).message).toMatch(/Ask the host/);
    a.ws.send({ t: 'present.request' });
    expect((await h.next('presentation', (m) => m.requests.length === 1)).requests[0]!.name).toBe('Student 1');
    h.send({ t: 'present.approve', memberId: a.memberId });
    expect((await a.ws.next('presentation', (m) => m.mine === 'approved')).mine).toBe('approved');
    a.ws.send({ t: 'present.start', source: 'window', audio: false });
    const live = await h.next('presentation', (m) => m.state?.presenter === a.memberId);
    expect(live.state).toMatchObject({ presenterName: 'Student 1', source: 'window', state: 'live' });
    h.send({ t: 'present.stop' });
    await until(() => s.presentations.current === null);
    expect(s.presentations.mine({ role: 'student', memberId: a.memberId })).toBe('none'); // approval covered one presentation
    const db = (s.classroom as unknown as { db: { prepare(q: string): { all(...a: unknown[]): unknown[] } } }).db;
    expect(db.prepare('SELECT presenter, source, stop_reason FROM presentations').all()).toEqual([{ presenter: a.memberId, source: 'window', stop_reason: 'stopped_by_host' }]);
    h.close(); a.ws.close();
  });

  it('a member approved after connecting is told they may now present (state is pushed on approval)', async () => {
    const s = await clan('STUDY_GROUP');
    s.classroom.setPolicy('approval');
    const h = await host(s);
    const j = await secureJoin(s, 1, device());
    const ws = socket(s.url, j.token); await ws.opened; await ws.next('hello');
    expect((await ws.next('presentation')).mine).toBe('none'); // pending
    h.send({ t: 'member.approve', memberId: j.memberId });
    expect((await ws.next('presentation', (m) => m.mine === 'approved')).mine).toBe('approved');
    h.close(); ws.close();
  });

  it('one presenter at a time; a host may stop them and switch', async () => {
    const s = await clan('STUDY_GROUP');
    const h = await host(s), a = await member(s, 1), b = await member(s, 2);
    a.ws.send({ t: 'present.start', source: 'screen', audio: false });
    await h.next('presentation', (m) => m.state?.presenter === a.memberId);
    b.ws.send({ t: 'present.start', source: 'screen', audio: false });
    expect((await b.ws.next('error')).message).toBe('Student 1 is currently presenting');
    h.send({ t: 'present.start', source: 'screen', audio: false, takeover: true });
    await h.next('presentation', (m) => m.state?.presenter === 'host');
    h.close(); a.ws.close(); b.ws.close();
  });

  it('media tokens: random room (never the CLAN name), member identity, subscribe-only unless presenting, short-lived', async () => {
    const s = await clan('FRIENDS');
    const a = await member(s, 1), b = await member(s, 2);
    const before = jwt((await mediaToken(s, a.token)).token);
    expect(before.video).toMatchObject({ room: s.media!.room, canPublish: false, canSubscribe: true });
    expect(before.video.room).not.toContain('FRIENDS');
    expect(before.sub).toBe(a.memberId);
    expect(before.exp - Date.now() / 1000).toBeLessThanOrEqual(600);
    a.ws.send({ t: 'present.start', source: 'screen', audio: false });
    await a.ws.next('presentation', (m) => m.state?.presenter === a.memberId);
    expect(jwt((await mediaToken(s, a.token)).token).video.canPublish).toBe(true);
    expect(jwt((await mediaToken(s, b.token)).token).video.canPublish).toBe(false);
    const nope = await trFor(s.url).fetch(`${s.url}/api/media/token`, { method: 'POST' });
    expect(nope.status).toBe(401);
    a.ws.close(); b.ws.close();
  });

  it('the SFU enforces publishing; viewers receive live, changing frames; a host stop revokes publishing', async () => {
    const s = await clan('STUDY_GROUP');
    const h = await host(s), a = await member(s, 1), b = await member(s, 2);
    const vt = (await mediaToken(s, b.token)).token;
    const viewer = await connect(s.media!.signalUrl, vt);
    const seen = frameCounter(viewer);
    const sneaky = pattern(viewer); // a viewer trying to publish without permission
    await expect(sneaky.publish()).rejects.toThrow();
    sneaky.stop();
    a.ws.send({ t: 'present.start', source: 'screen', audio: false });
    await a.ws.next('presentation', (m) => m.state?.presenter === a.memberId);
    const pt = (await mediaToken(s, a.token)).token;
    const presenter = await connect(s.media!.signalUrl, pt);
    const p = pattern(presenter);
    await p.publish();
    await until(() => seen.distinct >= 8);
    let unpublished = false;
    viewer.on(RoomEvent.TrackUnpublished, () => { unpublished = true; });
    h.send({ t: 'present.stop' });
    await until(() => unpublished);
    p.stop();
    h.close(); a.ws.close(); b.ws.close();
  });

  it('a credential for CLAN A cannot join CLAN B’s media room', async () => {
    const A = await clan('STUDY_GROUP'), B = await clan('STUDY_GROUP');
    const a = await member(A, 1);
    const t = (await mediaToken(A, a.token)).token;
    await B.media!.ensure();
    await expect(connect(B.media!.signalUrl, t)).rejects.toThrow();
    a.ws.close();
  });

  it('a removed presenter stops presenting and is dropped from media at once (not just at token expiry)', async () => {
    const s = await clan('STUDY_GROUP');
    const h = await host(s), a = await member(s, 1);
    a.ws.send({ t: 'present.start', source: 'screen', audio: false });
    await h.next('presentation', (m) => m.state?.presenter === a.memberId);
    const at = (await mediaToken(s, a.token)).token;
    const r = await connect(s.media!.signalUrl, at);
    let dropped = false;
    r.on(RoomEvent.Disconnected, () => { dropped = true; });
    h.send({ t: 'member.remove', memberId: a.memberId });
    await until(() => s.presentations.current === null);
    await until(() => dropped);
    expect(lastReason(s)).toBe('member_removed');
    h.close();
  });

  it('presenter connection lost: “reconnecting” for a grace period, kept if they return, ended cleanly if not', async () => {
    const s = await clan('STUDY_GROUP', 600);
    const h = await host(s), a = await member(s, 1);
    a.ws.send({ t: 'present.start', source: 'screen', audio: false });
    await h.next('presentation', (m) => m.state?.presenter === a.memberId);
    a.ws.close();
    await h.next('presentation', (m) => m.state?.state === 'reconnecting');
    const back = socket(s.url, a.token); await back.opened; await back.next('hello');
    await h.next('presentation', (m) => m.state?.state === 'live');
    back.close();
    await until(() => s.presentations.current === null, 4000);
    expect(lastReason(s)).toBe('presenter_disconnected');
    h.close();
  });

  it('media server crash: the presentation ends cleanly and the SFU restarts', async () => {
    const s = await clan('STUDY_GROUP');
    const h = await host(s), a = await member(s, 1);
    a.ws.send({ t: 'present.start', source: 'screen', audio: false });
    await h.next('presentation', (m) => m.state?.presenter === a.memberId);
    process.kill(s.media!.pid!, 'SIGKILL');
    await until(() => s.presentations.current === null);
    expect(lastReason(s)).toBe('media_failed');
    await until(() => s.media!.state === 'ready', 10_000);
    h.close(); a.ws.close();
  });

  it('signalling goes through the pinned CLAN TLS server; without a valid media token the SFU refuses', async () => {
    const s = await clan('STUDY_GROUP');
    const a = await member(s, 1);
    expect((await trFor(s.url).fetch(`${s.url}/media/rtc/validate`)).status).toBe(503); // SFU not started yet: lazy
    const t = (await mediaToken(s, a.token)).token;
    const ok = await new Promise<string>((res) => { const w = trFor(s.url).openWebSocket(`${s.url.replace('https', 'wss')}/media/rtc?access_token=${t}&protocol=16&sdk=js&version=2.22.3`); w.onmessage = () => { res('signal'); w.close(); }; w.onclose = () => res('closed'); });
    expect(ok).toBe('signal');
    const bad = await trFor(s.url).fetch(`${s.url}/media/rtc/validate?access_token=nonsense`);
    expect(bad.status).toBeGreaterThanOrEqual(400);
    a.ws.close();
  });

  it('CLAN end closes the media room and the SFU process; nothing is left running', async () => {
    const s = await clan('STUDY_GROUP');
    const a = await member(s, 1);
    a.ws.send({ t: 'present.start', source: 'screen', audio: false });
    await a.ws.next('presentation', (m) => m.state?.presenter === a.memberId);
    const pid = s.media!.pid!;
    await s.close(); servers.splice(servers.indexOf(s), 1);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(s.media!.state).toBe('stopped');
  });

  it('a media process left by a crashed host is killed on next start', async () => {
    const dir = tmp('lk-stale-'); mkdirSync(dir, { recursive: true });
    const orphan = spawn('sleep', ['30']);
    writeFileSync(join(dir, 'livekit.pid'), String(orphan.pid));
    expect(MediaService.cleanStale(dir)).toBe(true);
    await until(() => orphan.exitCode !== null || orphan.signalCode !== null, 3000);
  });
});
