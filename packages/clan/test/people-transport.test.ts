// People over the real transport: TLS 1.3 bound to identity keys, signed requests, QR first contact, visibility,
// friends, delivery and restart, verified resumable file transfer, live call signaling, and a phone on its socket.
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { randomBytes, randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createClassroomTls } from '@classroom/server';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { hello, peerClient } from '@classroom/client/people';
import { peerSocketAuth } from '@classroom/client';
import { signEnvelope, type PeerEnvelope } from '@classroom/protocol';
import { startPeopleRuntime } from '../../../apps/desktop/src/main/people-runtime.ts';
import { setup } from './helpers.ts';

const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => { for (const s of stops) await s(); });
const wait = async (f: () => boolean, ms = 8000) => { for (let i = 0; i < ms / 50 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); expect(f()).toBe(true); };

async function computer(name: string, base?: ReturnType<typeof setup>, keys?: { signer: ReturnType<typeof nodeSigner>; tls: Awaited<ReturnType<typeof createClassroomTls>> }) {
  const d = base ?? setup();
  const signer = keys?.signer ?? nodeSigner(newEd25519().privatePkcs8);
  const tls = keys?.tls ?? await createClassroomTls(`people-${name}`, Date.now(), 365 * 86_400_000);
  const live: PeerEnvelope[] = [];
  const rt = await startPeopleRuntime({ people: d.app.people, signer, tls, dir: join(d.storageDir, 'people'), bind: '127.0.0.1', discover: false, allowLoopback: true, endpoints: (port) => [`127.0.0.1:${port}`], onLive: (e) => live.push(e), tickMs: 200 });
  d.app.people.updateProfile({ name });
  stops.push(() => rt.stop());
  return { ...d, p: d.app.people, rt, signer, tls, key: signer.publicKey, live };
}

describe('people over the network', () => {
  it('QR first contact is verified; strangers see nothing in Friends Only; friends, messages, receipts and restart delivery work', async () => {
    const a = await computer('Aisha'), b = await computer('Bilal');
    const ep = `127.0.0.1:${b.rt.port}`;
    // Friends Only (default): a stranger who only knows the address learns nothing, not even the identity key
    await expect(hello(ep, a.signer)).rejects.toMatchObject({ code: 'refused' });
    const c = await a.rt.connectQr(b.rt.myQr());
    expect(c).toMatchObject({ key: b.key, name: 'Bilal', verified: true });
    // a QR whose pin does not match the device is refused (someone else answering at that address)
    const other = await computer('Mallory');
    other.p.setVisibility('everyone');
    // Replace both advertised carriers: a remaining valid link is a legitimate authenticated fallback.
    const forgedQr = b.rt.myQr().replace(`${b.rt.port}`, `${other.rt.port}`).replace(`${b.rt.linkPort}`, `${other.rt.linkPort}`);
    await expect(a.rt.connectQr(forgedQr)).rejects.toThrow();
    expect(a.p.contact(other.key)).toBeNull(); // mismatched QR never learns the impostor's profile
    a.p.sendFriendRequest(b.key); await a.rt.tick();
    await wait(() => b.p.contacts('requests').length === 1);
    b.p.acceptFriend(a.key); await b.rt.tick();
    await wait(() => a.p.isFriend(b.key));
    const conv = a.p.conversations()[0]!.id;
    a.p.sendText(conv, 'Hello Bilal'); await a.rt.tick();
    await wait(() => b.p.page(conv).length === 1);
    expect(a.p.page(conv)[0]!.state).toBe('delivered');
    b.p.markRead(conv); await b.rt.tick();
    await wait(() => a.p.page(conv)[0]!.state === 'read');
    // B goes offline; A's message waits; B comes back with the same identity and database
    await b.rt.stop();
    a.p.sendText(conv, 'Are you there?'); await a.rt.tick();
    expect(a.p.page(conv).at(-1)!.state).toBe('queued');
    const b2 = await computer('Bilal', { app: b.app, db: b.db, storageDir: b.storageDir }, { signer: b.signer, tls: b.tls });
    a.p.meet({ profile: b.p.profileFor(a.key).profile, endpoints: [`127.0.0.1:${b2.rt.port}`] });
    a.p.wake(b.key); await a.rt.tick();
    await wait(() => b2.p.page(conv).length === 2);
    expect(a.p.page(conv).at(-1)!.state).toBe('delivered');
  }, 60_000);

  it('Everyone Nearby reveals the public profile; Invisible refuses even with the QR; blocked people are refused', async () => {
    const a = await computer('Aisha'), b = await computer('Bilal');
    const ep = `127.0.0.1:${b.rt.port}`;
    b.p.setVisibility('everyone');
    const r = await a.rt.probe(ep);
    expect(r.contact).toMatchObject({ key: b.key, name: 'Bilal', verified: false });
    b.p.setVisibility('invisible');
    const qr = b.rt.myQr();
    await expect(a.rt.connectQr(qr)).rejects.toThrow();
    b.p.setVisibility('friends'); b.p.block(a.key);
    await expect(a.rt.connectQr(qr)).rejects.toThrow();
    // a forged request header (wrong key for the signature) is rejected before anything else
    const forged = peerClient({ endpoint: ep, tls: { certificate: b.tls.certificate, spkiSha256: b.tls.spkiSha256 }, peerKey: b.key, signer: { publicKey: a.key, sign: (x) => nodeSigner(newEd25519().privatePkcs8).sign(x) } });
    await expect(forged.profile()).rejects.toMatchObject({ status: 401 });
  }, 60_000);

  it('files: explicit consent, resumable download, SHA-256 verified; live call signals only between allowed people', async () => {
    const a = await computer('Aisha'), b = await computer('Bilal');
    await a.rt.connectQr(b.rt.myQr());
    const conv = a.p.inviteChat(b.key); await a.rt.tick();
    await wait(() => b.p.conversations().length === 1);
    expect(() => a.p.callSignal(b.key, { kind: 'call.invite', callId: randomUUID(), sdp: 'v=0' })).toThrow(/call friends/);
    b.p.acceptChat(conv); await b.rt.tick();
    await wait(() => a.p.conversation(conv)?.state === 'active');
    const src = join(a.storageDir, 'lecture.bin'), data = randomBytes(3_000_000); writeFileSync(src, data);
    const t = await a.p.offerFile(conv, src, { name: 'lecture.bin', mime: 'application/octet-stream' });
    await a.rt.tick();
    await wait(() => b.p.transfer(t.id)?.state === 'offered');
    // nobody can fetch before consent
    await expect(peerClient({ endpoint: `127.0.0.1:${a.rt.port}`, tls: { certificate: a.tls.certificate, spkiSha256: a.tls.spkiSha256 }, peerKey: a.key, signer: b.signer }).download(t.id, join(b.storageDir, 'x'), data.length)).rejects.toMatchObject({ status: 404 });
    // a partial earlier attempt is resumed by Range
    writeFileSync(join(b.storageDir, 'people', 'incoming', `${t.id}.part`), data.subarray(0, 1_000_000));
    b.p.acceptFile(t.id); await b.rt.tick();
    await wait(() => a.p.transfer(t.id)?.state === 'accepted', 8000);
    await b.rt.tick();
    await wait(() => b.p.transfer(t.id)?.state === 'complete', 15_000);
    expect(readFileSync(b.p.filePath(t.id)!)).toEqual(data);
    // live call signaling arrives at once and is never queued
    const invite = a.p.callSignal(b.key, { kind: 'call.invite', callId: randomUUID(), sdp: 'v=0' });
    expect(await a.rt.sendLive(invite)).toBe(true);
    expect(b.live.map((e) => e.body.kind)).toEqual(['call.invite']);
  }, 60_000);

  it('a phone (no server) authenticates on its socket, receives its queue, acknowledges, and sends through the computer', async () => {
    const pc = await computer('Desk');
    const phoneDb = setup(), phone = phoneDb.app.people, ps = nodeSigner(newEd25519().privatePkcs8);
    phone.setSigner(ps); phone.updateProfile({ name: 'Phone person' });
    const b = await hello(`127.0.0.1:${pc.rt.port}`, ps, { invite: pc.p.inviteToken() });
    const client = peerClient({ endpoint: `127.0.0.1:${pc.rt.port}`, tls: b, peerKey: b.key, signer: ps, invite: pc.p.inviteToken() });
    phone.meet({ profile: await client.profile(), endpoints: [`127.0.0.1:${pc.rt.port}`], tls: { certificate: b.certificate, spkiSha256: b.spkiSha256 } });
    phone.sendFriendRequest(pc.key);
    const out = phone.due();
    expect((await client.send(out.map((d) => d.envelope)))[0]).toMatchObject({ ok: true });
    for (const d of out) phone.delivered(d.id);
    pc.p.meet({ profile: phone.profileFor(pc.key).profile }); // the phone's profile reaches the computer on contact
    pc.p.acceptFriend(phone.myKey());
    // the computer cannot call the phone back: it delivers over the phone's authenticated socket
    const ws = new WebSocket(`wss://127.0.0.1:${pc.rt.port}/peer/ws`, { rejectUnauthorized: false }); // the phone's native socket pins the certificate; this Node stand-in checks identity via auth
    const got: PeerEnvelope[] = [];
    ws.on('message', (raw) => { const m = JSON.parse(String(raw)); if (m.t === 'env') { got.push(m.envelope); phone.receive(m.envelope, pc.key); ws.send(JSON.stringify({ t: 'ack', id: m.id })); } });
    await new Promise((r) => ws.once('open', r));
    ws.send(JSON.stringify(peerSocketAuth(ps, pc.key, randomBytes(18).toString('base64url'))));
    await wait(() => got.some((e) => e.body.kind === 'friend.accept'));
    await wait(() => pc.p.due(Number.MAX_SAFE_INTEGER).filter((d) => d.to === phone.myKey()).length === 0);
    expect(phone.isFriend(pc.key)).toBe(true);
    // an unauthenticated or forged socket is closed
    const bad = new WebSocket(`wss://127.0.0.1:${pc.rt.port}/peer/ws`, { rejectUnauthorized: false });
    await new Promise((r) => bad.once('open', r));
    bad.send(JSON.stringify({ ...peerSocketAuth(ps, pc.key, randomBytes(18).toString('base64url')), key: pc.key }));
    expect(await new Promise((r) => bad.once('close', (c) => r(c)))).toBe(4401);
    ws.close();
    void signEnvelope;
  }, 60_000);

  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  it.skipIf(!lan)('automatic discovery: Everyone Nearby appears with its public profile; Friends Only hides strangers; Invisible disappears', async () => {
    const mk = async (name: string) => {
      const d = setup(), signer = nodeSigner(newEd25519().privatePkcs8), tls = await createClassroomTls(`d-${name}`, Date.now(), 1e10);
      d.app.people.setSigner(signer); d.app.people.updateProfile({ name });
      const rt = await startPeopleRuntime({ people: d.app.people, signer, tls, dir: join(d.storageDir, 'people'), discover: true, endpoints: (port) => [`${lan}:${port}`], tickMs: 500 });
      stops.push(() => rt.stop());
      return { p: d.app.people, rt, key: signer.publicKey };
    };
    const a = await mk('Aisha'), b = await mk('Bilal');
    a.p.setVisibility('everyone'); await a.rt.refreshDiscovery();
    await wait(() => b.rt.nearby().some((n) => n.key === a.key && n.name === 'Aisha'), 20_000);
    expect(a.rt.nearby().some((n) => n.key === b.key)).toBe(false); // Bilal is Friends Only: a stranger never sees him
    a.p.setVisibility('invisible'); await a.rt.refreshDiscovery();
    await wait(() => !b.rt.nearby().some((n) => n.key === a.key), 20_000);
  }, 60_000);

  it.skipIf(!lan)('presence: Friends Only friends find each other automatically; an advertiser never learns who looked', async () => {
    const mk = async (name: string) => {
      const d = setup(), signer = nodeSigner(newEd25519().privatePkcs8), tls = await createClassroomTls(`p-${name}`, Date.now(), 1e10);
      d.app.people.setSigner(signer); d.app.people.updateProfile({ name });
      const rt = await startPeopleRuntime({ people: d.app.people, signer, tls, dir: join(d.storageDir, 'people'), discover: true, endpoints: (port) => [`${lan}:${port}`], tickMs: 300 });
      stops.push(() => rt.stop());
      return { p: d.app.people, rt, key: signer.publicKey };
    };
    const a = await mk('Ayesha'), b = await mk('Bashir'), m = await mk('Lurker');
    m.p.setVisibility('everyone'); await m.rt.refreshDiscovery();
    await a.rt.connectQr(b.rt.myQr());
    a.p.sendFriendRequest(b.key); await a.rt.tick();
    await wait(() => b.p.contacts('requests').length === 1, 10_000);
    b.p.acceptFriend(a.key); await b.rt.tick();
    await wait(() => a.p.isFriend(b.key) && b.p.matchPresence('x'.repeat(16), a.p.presenceTagFor('x'.repeat(16))) === a.key && a.p.matchPresence('y'.repeat(16), b.p.presenceTagFor('y'.repeat(16))) === b.key, 15_000);
    await a.rt.refreshDiscovery(); await b.rt.refreshDiscovery(); // fresh adverts with tags friends now recognise
    await wait(() => a.rt.nearby().some((n) => n.key === b.key) && b.rt.nearby().some((n) => n.key === a.key), 30_000);
    // they also saw the public advertiser, but under throwaway identities
    await wait(() => a.rt.nearby().some((n) => n.key === m.key), 30_000);
    expect(m.p.contact(a.key)).toBeNull();
    expect(m.p.contact(b.key)).toBeNull();
  }, 90_000);
});
