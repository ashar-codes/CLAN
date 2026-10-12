// The phone's people runtime against a real computer runtime, with Node stand-ins for the native pieces (first-contact
// TLS that reports the certificate it saw, the pinned transport, file slices). Covers what a phone can do: connect by a
// computer's code, become friends, chat both ways over its authenticated socket, receive and send verified files.
import { afterAll, describe, expect, it } from 'vitest';
import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { open, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { createClassroomTls } from '@classroom/server';
import { newEd25519, nodeSigner, pinnedTransport, spkiSha256OfDer } from '@classroom/client/node';
import { startPeopleRuntime } from '../../../apps/desktop/src/main/people-runtime.ts';
import { startPhonePeople, type PhoneEnv } from '../../../apps/mobile/src/people/runtime.ts';
import { setup } from './helpers.ts';

const stops: (() => unknown)[] = [];
afterAll(async () => { for (const s of stops) await s(); });
const wait = async (f: () => boolean, ms = 10_000) => { for (let i = 0; i < ms / 50 && !f(); i++) await new Promise((r) => setTimeout(r, 50)); expect(f()).toBe(true); };

function nodeEnv(dir: string): PhoneEnv {
  return {
    firstContact: (base, path, headers, body) => new Promise((resolve, reject) => {
      const u = new URL(base + path);
      const req = request({ host: u.hostname, port: Number(u.port), path, method: 'POST', agent: false, rejectUnauthorized: false, minVersion: 'TLSv1.3', headers: { ...headers, 'content-length': Buffer.byteLength(body) } }, (res) => {
        const raw = (res.socket as TLSSocket).getPeerCertificate()?.raw, chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, json: JSON.parse(Buffer.concat(chunks).toString() || '{}'), spki: raw ? spkiSha256OfDer(raw) : '' }));
      });
      req.on('error', reject); req.end(body);
    }),
    transport: (tls) => {
      const t = pinnedTransport(tls);
      return {
        fetch: (url, init) => t.fetch(url, init),
        openWebSocket: (url) => t.openWebSocket(url),
        async downloadToFile(url, headers, fileUri, offset) {
          const res = await t.fetch(url, { method: 'GET', headers });
          if (res.status !== 200 && res.status !== 206) throw new Error(`Download failed (${res.status})`);
          const bytes = Buffer.from(await res.arrayBuffer());
          if (offset) appendFileSync(fileUri, bytes); else writeFileSync(fileUri, bytes);
          return (await stat(fileUri)).size;
        },
        async uploadFromFile(url, headers, fileUri) {
          const res = await t.fetch(url, { method: 'PUT', headers, body: readFileSync(fileUri) });
          return { status: res.status, body: await res.text() };
        },
      };
    },
    files: {
      size: async (uri) => (await stat(uri)).size,
      async slice(uri, offset, len) {
        const fh = await open(uri, 'r'); const bytes = Buffer.alloc(len);
        try { await fh.read(bytes, 0, len, offset); } finally { await fh.close(); }
        const out = join(dir, `chunk-${randomBytes(6).toString('hex')}`); writeFileSync(out, bytes);
        return { uri: out, bytes: new Uint8Array(bytes) };
      },
      remove: (uri) => rm(uri, { force: true }),
      incoming: (id) => join(dir, `${id}.part`),
    },
    nonce: () => randomBytes(18).toString('base64url'),
  };
}

describe('phone people runtime (Node stand-ins for the native transport)', () => {
  it('connects by code, befriends, chats both ways over its socket, and exchanges verified files', async () => {
    const pcD = setup(), pcSigner = nodeSigner(newEd25519().privatePkcs8), tls = await createClassroomTls('people-pc', Date.now(), 1e10);
    const pc = await startPeopleRuntime({ people: pcD.app.people, signer: pcSigner, tls, dir: join(pcD.storageDir, 'people'), bind: '127.0.0.1', discover: false, allowLoopback: true, endpoints: (port) => [`127.0.0.1:${port}`], tickMs: 200 });
    pcD.app.people.updateProfile({ name: 'Desk' });
    stops.push(() => pc.stop());
    const phD = setup(), ph = phD.app.people, dir = mkdtempSync(join(tmpdir(), 'phone-people-'));
    const phSigner = nodeSigner(newEd25519().privatePkcs8);
    const phone = startPhonePeople({ people: ph, signer: phSigner, env: nodeEnv(dir), tickMs: 200 });
    ph.updateProfile({ name: 'Phone person' });
    stops.push(() => phone.stop());

    // a wrong code (certificate pin does not match) is refused; the right one connects verified
    const qr = pc.myQr();
    await expect(phone.connectQr(qr.replace(/s=[^&]+/, `s=${encodeURIComponent(Buffer.alloc(32, 1).toString('base64'))}`))).rejects.toThrow();
    const c = await phone.connectQr(qr);
    expect(c).toMatchObject({ name: 'Desk', verified: true });

    ph.sendFriendRequest(c.key); await phone.tick();
    await wait(() => pcD.app.people.contacts('requests').length === 1);
    expect(pcD.app.people.contact(ph.myKey())?.name).toBe('Phone person');
    pcD.app.people.acceptFriend(ph.myKey()); await pc.tick();
    await wait(() => ph.isFriend(c.key)); // delivered over the phone's authenticated socket
    expect(phone.connected(c.key)).toBe(true);

    const conv = ph.conversations()[0]!.id;
    ph.sendText(conv, 'from the phone'); await phone.tick();
    await wait(() => pcD.app.people.page(conv).some((m) => m.text === 'from the phone'));
    pcD.app.people.sendText(conv, 'from the desk'); await pc.tick();
    await wait(() => ph.page(conv).some((m) => m.text === 'from the desk'));

    // computer → phone file: phone accepts, downloads (GET, pinned, signed), verifies
    const big = randomBytes(1_500_000), src = join(pcD.storageDir, 'slides.bin'); writeFileSync(src, big);
    const t1 = await pcD.app.people.offerFile(conv, src, { name: 'slides.bin', mime: 'application/octet-stream' }); await pc.tick();
    await wait(() => ph.transfer(t1.id)?.state === 'offered');
    ph.acceptFile(t1.id); await phone.tick();
    await wait(() => ph.transfer(t1.id)?.state === 'complete', 15_000);
    expect(readFileSync(ph.filePath(t1.id)!)).toEqual(big);
    await wait(() => pcD.app.people.transfer(t1.id)?.state === 'complete'); // signed receipt reached the computer

    // phone → computer file: pushed in signed chunks after the computer accepts
    const mine = randomBytes(9_000_000), msrc = join(dir, 'video.bin'); writeFileSync(msrc, mine);
    const t2 = await ph.offerFile(conv, msrc, { name: 'video.bin', mime: 'video/mp4' }); await phone.tick();
    await wait(() => pcD.app.people.transfer(t2.id)?.state === 'offered');
    pcD.app.people.acceptFile(t2.id); await pc.tick();
    await wait(() => pcD.app.people.transfer(t2.id)?.state === 'complete', 20_000);
    expect(readFileSync(pcD.app.people.filePath(t2.id)!)).toEqual(mine);
    await wait(() => ph.transfer(t2.id)?.state === 'complete');

    // Restart/unreachable: durable outbox survives; a native pulse can drive all processing without a JS retry timer.
    phone.stop(); await wait(() => !pc.server.phoneConnected(ph.myKey()));
    const pending = pcD.app.people.sendText(conv, 'queued while phone stopped');
    const voicePath = join(pcD.storageDir, 'queued.webm'); writeFileSync(voicePath, Buffer.alloc(1024, 7));
    const voice = await pcD.app.people.offerFile(conv, voicePath, { name: 'queued.webm', mime: 'audio/webm', voiceMs: 1200 });
    const filePath = join(pcD.storageDir, 'queued.bin'); writeFileSync(filePath, Buffer.alloc(2048, 9));
    const file = await pcD.app.people.offerFile(conv, filePath, { name: 'queued.bin', mime: 'application/octet-stream' });
    await rm(voicePath); await rm(filePath); await pc.tick();
    expect(pcD.app.people.message(pending.id)?.state).toBe('queued');
    const restarted = startPhonePeople({ people: ph, signer: phSigner, env: nodeEnv(dir), tickMs: 3_600_000 }); stops.push(() => restarted.stop());
    await wait(() => ph.page(conv).some((m) => m.text === 'queued while phone stopped'));
    await wait(() => pcD.app.people.message(pending.id)?.state === 'delivered');
    await wait(() => ph.transfer(file.id)?.state === 'offered');
    expect(ph.filePath(file.id)).toBeNull(); // explicit file consent survives reconnect
    for (let i = 0; i < 15 && ph.transfer(voice.id)?.state !== 'complete'; i++) { await restarted.tick(); await pc.tick(); await new Promise((r) => setTimeout(r, 100)); }
    expect(ph.transfer(voice.id)?.state).toBe('complete'); expect(readFileSync(ph.filePath(voice.id)!)).toEqual(Buffer.alloc(1024, 7));
    ph.acceptFile(file.id);
    for (let i = 0; i < 15 && ph.transfer(file.id)?.state !== 'complete'; i++) { await restarted.tick(); await pc.tick(); await new Promise((r) => setTimeout(r, 100)); }
    expect(ph.transfer(file.id)?.state).toBe('complete'); expect(readFileSync(ph.filePath(file.id)!)).toEqual(Buffer.alloc(2048, 9));
    await pc.tick(); await restarted.tick(); expect(ph.page(conv).filter((m) => m.text === 'queued while phone stopped')).toHaveLength(1);

  }, 90_000);
});
