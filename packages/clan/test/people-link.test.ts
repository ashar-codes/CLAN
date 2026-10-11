// People over clan-link/1 on real TCP sockets (as on a hotspot, Wi-Fi Direct or Aware network, where nobody runs a
// TLS server): QR-style first contact, visibility, friends, chat, receipts, verified files that resume after the link
// drops, one session per pair when both dial at once, live call signaling, blocking, and switching transports.
import { afterAll, describe, expect, it } from 'vitest';
import { appendFile, open, rm, stat } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { listenLinks, tcpTransport } from '@classroom/server';
import { bytePipe, profileQr, type ByteLink, type PeerEnvelope } from '@classroom/protocol';
import { createClassroomTls } from '@classroom/server';
import { startPeopleRuntime } from '../../../apps/desktop/src/main/people-runtime.ts';
import { ConnectionManager, type LinkFiles } from '../src/index.ts';
import { setup } from './helpers.ts';

const stops: (() => unknown)[] = [];
afterAll(async () => { for (const s of stops.reverse()) await s(); });
const wait = async (f: () => boolean, ms = 10_000) => { for (let i = 0; i < ms / 25 && !f(); i++) await new Promise((r) => setTimeout(r, 25)); expect(f()).toBe(true); };

const nodeFiles = (dir: string): LinkFiles => ({
  async read(p, o, n) { const fh = await open(p, 'r'); try { const b = Buffer.alloc(n); const { bytesRead } = await fh.read(b, 0, n, o); return new Uint8Array(b.subarray(0, bytesRead)); } finally { await fh.close(); } },
  append: (p, b) => appendFile(p, b),
  size: async (p) => (await stat(p)).size,
  remove: (p) => rm(p, { force: true }),
  partPath: (id) => join(dir, `${id}.link.part`),
});

/** In-memory transport, to show sessions survive a change of carrier (e.g. Wi-Fi Direct → hotspot). */
const memNet = new Map<string, (l: ByteLink) => void>();
const memTransport = { name: 'mem', handles: (a: string) => a.startsWith('mem:'), dial: async (a: string) => { const accept = memNet.get(a); if (!accept) throw new Error('gone'); const [x, y] = bytePipe(); accept(y); return x; } };

async function device(name: string) {
  const d = setup(), signer = nodeSigner(newEd25519().privatePkcs8);
  d.app.people.setSigner(signer); d.app.people.updateProfile({ name });
  const live: PeerEnvelope[] = [];
  let addr = '';
  const cm = new ConnectionManager({ people: d.app.people, signer, files: nodeFiles(d.storageDir), onLive: (e) => live.push(e), myAddrs: () => [addr], tickMs: 150 }).use(tcpTransport()).use(memTransport);
  const l = await listenLinks({ bind: '127.0.0.1', onLink: (link) => void cm.accept(link) });
  addr = `tcp:127.0.0.1:${l.port}`;
  memNet.set(`mem:${name}`, (link) => void cm.accept(link));
  stops.push(() => cm.stop(), () => l.close());
  return { ...d, p: d.app.people, cm, key: signer.publicKey, signer, addr: () => addr, setAddr: (a: string) => { addr = a; }, live, listener: l };
}

describe('people over clan-link/1 (no TLS server, no router needed)', () => {
  it('code-based first contact, friends, chat with receipts, refusals by visibility and block', async () => {
    const a = await device('Aisha'), b = await device('Bilal'), m = await device('Mallory');
    // Friends Only: a stranger without the invite is refused before Bilal reveals anything
    await expect(m.cm.connect(b.addr())).rejects.toMatchObject({ code: 'refused' });
    // with the invite from Bilal's code, and expecting Bilal's key, Aisha connects
    await a.cm.connect(b.addr(), { expectKey: b.key, invite: b.p.inviteToken() });
    await wait(() => a.p.contact(b.key)?.name === 'Bilal');
    // someone else answering at that address would fail the key check
    await expect(a.cm.connect(m.addr(), { expectKey: b.key })).rejects.toBeTruthy();
    a.p.sendFriendRequest(b.key); await a.cm.tick();
    await wait(() => b.p.contacts('requests').length === 1);
    b.p.acceptFriend(a.key); await b.cm.tick();
    await wait(() => a.p.isFriend(b.key));
    const conv = a.p.conversations()[0]!.id;
    const msg = a.p.sendText(conv, 'no router here'); await a.cm.tick();
    await wait(() => b.p.page(conv).some((x) => x.text === 'no router here'));
    await wait(() => a.p.message(msg.id)?.state === 'delivered'); // only after Bilal's authenticated result
    b.p.markRead(conv); await b.cm.tick();
    await wait(() => a.p.message(msg.id)?.state === 'read');
    // block: Bilal refuses the link itself
    b.p.block(a.key);
    a.cm.session(b.key)?.link.close('test');
    await wait(() => !a.cm.connected(b.key));
    await expect(a.cm.connect(b.addr(), { expectKey: b.key })).rejects.toMatchObject({ code: 'refused' });
  }, 30_000);

  it('files: consent, resume after the link drops (redial by remembered address), SHA-256 verified, receipt', async () => {
    const a = await device('A2'), b = await device('B2');
    await a.cm.connect(b.addr(), { expectKey: b.key, invite: b.p.inviteToken() });
    const conv = a.p.inviteChat(b.key); await a.cm.tick();
    await wait(() => b.p.conversations().length === 1);
    b.p.acceptChat(conv); await b.cm.tick();
    await wait(() => a.p.conversation(conv)?.state === 'active');
    const data = randomBytes(2_500_000), src = join(a.storageDir, 'slides.pdf'); writeFileSync(src, data);
    const t = await a.p.offerFile(conv, src, { name: 'slides.pdf', mime: 'application/pdf' }); await a.cm.tick();
    await wait(() => b.p.transfer(t.id)?.state === 'offered');
    b.p.acceptFile(t.id);
    // cut the link as soon as some bytes arrived; the receiver redials Aisha's remembered address and resumes
    await b.cm.tick();
    await wait(() => (b.p.transfer(t.id)?.received ?? 0) > 0, 10_000);
    b.cm.session(a.key)?.link.close('network lost');
    await wait(() => b.p.transfer(t.id)?.state === 'complete', 20_000);
    expect(readFileSync(b.p.filePath(t.id)!)).toEqual(data);
    await wait(() => a.p.transfer(t.id)?.state === 'complete');
  }, 40_000);

  it('both dial at once → one session each side; live signals; state across a change of transport', async () => {
    const a = await device('A3'), b = await device('B3');
    await a.cm.connect(b.addr(), { expectKey: b.key, invite: b.p.inviteToken() });
    a.p.sendFriendRequest(b.key); await a.cm.tick();
    await wait(() => b.p.contacts('requests').length === 1);
    b.p.acceptFriend(a.key); await b.cm.tick(); await wait(() => a.p.isFriend(b.key));
    a.cm.session(b.key)!.link.close('reset');
    await wait(() => !a.cm.connected(b.key) && !b.cm.connected(a.key));
    await Promise.allSettled([a.cm.connect(b.addr(), { expectKey: b.key }), b.cm.connect(a.addr(), { expectKey: a.key })]);
    await wait(() => a.cm.connected(b.key) && b.cm.connected(a.key));
    await new Promise((r) => setTimeout(r, 100));
    expect(a.cm.session(b.key)!.link.role === 'initiator' ? a.key : b.key).toBe(b.cm.session(a.key)!.link.role === 'initiator' ? b.key : a.key);
    // live call signal arrives immediately and is never queued
    expect(await a.cm.sendLive(a.p.callSignal(b.key, { kind: 'call.invite', callId: randomUUID(), sdp: 'v=0' }))).toBe(true);
    await wait(() => b.live.length === 1);
    // queued while offline, then delivered over a different carrier; delivery state is kept
    a.cm.session(b.key)!.link.close('wifi direct lost');
    b.listener.close(); b.setAddr('mem:B3');
    await wait(() => !a.cm.connected(b.key) && !b.cm.connected(a.key));
    const conv = a.p.conversations()[0]!.id;
    const m1 = a.p.sendText(conv, 'sent while apart');
    expect(a.p.message(m1.id)?.state).toBe('queued');
    await a.cm.connect('mem:B3', { expectKey: b.key });
    await wait(() => a.p.message(m1.id)?.state === 'delivered');
    expect(b.p.page(conv).filter((x) => x.text === 'sent while apart')).toHaveLength(1);
    expect(a.cm.status(b.key)?.state).toBe('connected');
  }, 40_000);

  it('a computer scans a phone-style code (link listeners only) and they talk over the link', async () => {
    const phone = await device('Phone'), d = setup(), signer = nodeSigner(newEd25519().privatePkcs8);
    const pc = await startPeopleRuntime({ people: d.app.people, signer, tls: await createClassroomTls('pc', Date.now(), 1e10), dir: join(d.storageDir, 'people'), bind: '127.0.0.1', discover: false, allowLoopback: true, endpoints: (port) => [`127.0.0.1:${port}`], tickMs: 150 });
    d.app.people.updateProfile({ name: 'Desk' }); stops.push(() => pc.stop());
    const code = profileQr({ key: phone.key, endpoints: [], links: [phone.addr()], name: 'Phone', invite: phone.p.inviteToken(), intent: 'friend' });
    const c = await pc.connectQr(code);
    expect(c).toMatchObject({ key: phone.key, name: 'Phone', verified: true });
    d.app.people.sendFriendRequest(phone.key); await pc.tick();
    await wait(() => phone.p.contacts('requests').length === 1);
    expect(phone.p.contact(signer.publicKey)?.name).toBe('Desk');
    phone.p.acceptFriend(signer.publicKey); await phone.cm.tick();
    await wait(() => d.app.people.isFriend(phone.key));
    expect(pc.links.connected(phone.key)).toBe(true);
  }, 30_000);

  it('profile pictures: fetched over the link only when shown to us, verified against the signed profile', async () => {
    const a = await device('PicA'), b = await device('PicB'), m = await device('PicM');
    // a minimal valid PNG header + payload, as a file
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), randomBytes(2000)]);
    const pngPath = join(a.storageDir, 'me.png'); writeFileSync(pngPath, png);
    await a.p.setAvatar(pngPath, 'image/png');
    await b.cm.connect(a.addr(), { expectKey: a.key, invite: a.p.inviteToken() });
    await wait(() => !!b.p.avatarOf(a.key));
    expect(Buffer.from(b.p.avatarOf(a.key)!.data)).toEqual(png);
    // a forged picture (wrong bytes for the announced hash) is never cached
    expect(() => m.p.storeAvatar(a.key, 'image/png', png)).toThrow(); // m does not even have a's profile
    const fake = Buffer.from(png); fake[100]! ^= 1;
    expect(() => b.p.storeAvatar(a.key, 'image/png', fake)).toThrow(/does not match/);
    // someone who may not see the profile gets no picture
    expect(await a.p.avatarFor(m.key)).toBeNull();
  }, 30_000);

  it('a hostile peer on an authenticated link: malformed, oversized and cross-conversation requests change nothing', async () => {
    const a = await device('HostA'), c = await device('HostC'), m = await device('HostM');
    // Aisha (a) has a chat with c and offers c a file; m is a stranger she lets in with her code
    await c.cm.connect(a.addr(), { expectKey: a.key, invite: a.p.inviteToken() });
    const conv = c.p.inviteChat(a.key); await c.cm.tick(); await wait(() => a.p.conversations().length === 1);
    a.p.acceptChat(conv); await a.cm.tick(); await wait(() => c.p.conversation(conv)?.state === 'active');
    const src = join(a.storageDir, 'secret.pdf'); writeFileSync(src, randomBytes(50_000));
    const t = await a.p.offerFile(conv, src, { name: 'secret.pdf', mime: 'application/pdf' }); await a.cm.tick();
    await wait(() => c.p.transfer(t.id)?.state === 'offered');
    c.p.acceptFile(t.id); // accepted by c — never by m
    // m connects with the invite and speaks raw protocol messages on the authenticated link
    const { linkInitiate } = await import('@classroom/protocol');
    const raw = await linkInitiate(await tcpTransport().dial(a.addr()), { signer: m.signer, expectKey: a.key, invite: a.p.inviteToken() });
    const replies: Record<string, unknown>[] = [];
    raw.onMessage((x) => { try { replies.push(JSON.parse(new TextDecoder().decode(x))); } catch { /* binary */ } });
    const send = (o: unknown) => raw.send(new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o)));
    send('not json'); send('{"t":42}'); send({ t: 'nonsense', id: '1' });
    send({ t: 'get', id: '2', transferId: t.id, offset: 0, length: 1000 }); // someone else's accepted transfer
    send({ t: 'get', id: '3', transferId: t.id, offset: -5, length: 1e12 });
    send({ t: 'env', id: '4', envelopes: [{ not: 'an envelope' }, ...Array.from({ length: 300 }, () => ({}))] });
    send({ t: 'hi', profile: { profile: { key: c.key, name: 'Forged C' }, sig: 'x' }, addrs: ['tcp:1.2.3.4:1', 'ftp://x'] });
    await wait(() => replies.filter((r) => r.t === 'err' || r.t === 'res').length >= 3, 5000);
    expect(replies.find((r) => r.id === '2')).toMatchObject({ t: 'err', code: 'not_found' });
    expect(replies.find((r) => r.id === '3')).toMatchObject({ t: 'err', code: 'not_found' });
    const res = replies.find((r) => r.id === '4') as { results: { ok: boolean }[] };
    expect(res.results).toHaveLength(100); // capped
    expect(res.results.every((x) => !x.ok)).toBe(true);
    expect(a.p.contact(c.key)?.name).toBe('HostC'); // a forged profile for someone else is ignored
    expect(raw.closed).toBe(false); // nonsense is ignored, not fatal — but nothing was applied
    raw.close();
  }, 30_000);
});
