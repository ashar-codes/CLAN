// Persistent hosting hand-over over the real transport: the owner's phone and linked desktop run their personal-sync
// HTTPS servers (pinned certificates, device-signed requests); the hand-over adds owner-delegation authorization.
import { afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createClassroomTls, serverCheckpointSection, startSyncServer } from '@classroom/server';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { joinWithCode, replicateClan, type HostingDestination } from '@classroom/client/sync';
import { pushClan } from '@classroom/client';
import { pinnedTransport } from '@classroom/client/node';
import { open } from 'node:fs/promises';
import { normalizeLinkCode, type AuthorityRecord } from '@classroom/protocol';
import { setup, user } from './helpers.ts';

const closers: (() => Promise<unknown>)[] = [];
afterAll(async () => { for (const c of closers) await c(); });

async function device(name: string) {
  const s = setup();
  s.app.hosting.register(serverCheckpointSection(s.db, s.storageDir));
  const tls = await createClassroomTls(`sync-${name}`, Date.now(), 5 * 365 * 86_400_000);
  const signer = nodeSigner(newEd25519().privatePkcs8); // the device key: sync identity and hosting key
  const fp = s.app.sync.setup({ publicKey: signer.publicKey, name, platform: 'test', tlsCa: tls.certificate, tlsSpki: tls.spkiSha256 }, signer);
  const srv = await startSyncServer({ host: s.app.sync, tls, bind: '127.0.0.1', objectPath: () => null, deviceKey: (f) => s.app.sync.deviceKey(f),
    replication: s.app.hosting.replicationSource({ localKey: signer.publicKey, signer }), sink: s.app.hosting.replicationSink({ localKey: signer.publicKey, signer }) });
  closers.push(srv.close);
  return { ...s, name, fp, signer, base: `https://127.0.0.1:${srv.port}`, me: user(s.app.me) };
}
type Dev = Awaited<ReturnType<typeof device>>;
async function link(a: Dev, b: Dev) {
  const s = a.app.sync.startLink(), self = b.app.sync.self();
  const joining = joinWithCode({ base: a.base, code: normalizeLinkCode(s.code)!, pollMs: 20, sign: (x) => b.signer.sign(x),
    device: { fp: self.fp, publicKey: self.publicKey, name: self.name, platform: self.platform, tlsCa: self.tlsCa, tlsSpki: self.tlsSpki, endpoints: [b.base.slice(8)] } });
  for (let i = 0; i < 200 && !a.app.sync.linkRequest(); i++) await new Promise((r) => setTimeout(r, 10));
  a.app.sync.approveLink(a.app.sync.linkRequest()!.sessionId, [a.base.slice(8)]);
  b.app.sync.adopt((await joining).grant);
}
/** Desktop pulls from the phone exactly as the app will (prepare: CLAN record + owner anchor through the device link). */
const pull = (from: Dev, to: Dev, clanId: string, delegation: unknown, hosting: HostingDestination = to.app.hosting) => {
  const d = to.app.sync.devices().find((x) => x.fp === from.fp)!;
  return replicateClan({ base: from.base, tlsCa: d.tlsCa, tlsSpki: d.tlsSpki, auth: (m, p, b) => to.app.sync.authHeaders(m, p, b), clanId, delegation, hosting, signer: to.signer,
    prepare: (offer) => {
      if (offer.clan) to.app.clans.ensureKnown({ id: clanId, type: offer.clan.type as 'STUDY_GROUP', name: offer.clan.name, expiresAt: offer.clan.expiresAt, createdBy: to.app.me });
      if (!to.app.hosting.anchorOf(clanId)) to.app.hosting.anchorLinkedOwner(clanId, (offer.chain[0] as AuthorityRecord).ownerKey);
    } });
};

describe('persistent hosting hand-over over the device link', () => {
  it('moves a phone-created CLAN to the linked desktop: authorized, resumable, verified, single writer, replayable', async () => {
    const phone = await device('Phone'), desk = await device('Desktop'), other = await device('Other laptop');
    await link(phone, desk); await link(phone, other);
    const clan = phone.app.clans.create({ type: 'STUDY_GROUP', name: 'Physics', createdBy: phone.app.me });
    phone.app.hosting.establish(clan.id, phone.app.me, phone.signer);
    const thread = phone.app.chat.groupThread(clan.id);
    phone.app.chat.post({ id: randomUUID(), threadId: thread.id, author: 'h', authorName: 'Host', body: 'Lab tomorrow' });
    const big = `${phone.storageDir}/big.bin`; writeFileSync(big, Buffer.alloc(3_000_000, 7));
    const f = await phone.app.files.add(phone.me, big, 'big.bin', { kind: 'clan', clanId: clan.id });
    const delegation = phone.app.hosting.delegate(clan.id, phone.signer, desk.signer.publicKey, { id: randomUUID() });

    // not yet prepared: refused
    await expect(pull(phone, desk, clan.id, delegation)).rejects.toThrow(/not prepared/);
    phone.app.hosting.freeze(clan.id, phone.signer.publicKey);
    const { header } = await phone.app.hosting.prepareCheckpoint(clan.id, phone.signer.publicKey);

    // another linked device of the same account cannot use the desktop's delegation, nor fetch blobs it was not offered
    await expect(pull(phone, other, clan.id, delegation)).rejects.toThrow(/another device/);
    const d = other.app.sync.devices().find((x) => x.fp === phone.fp)!;
    const res = await (await import('@classroom/client/node')).pinnedTransport({ certificate: d.tlsCa, spkiSha256: d.tlsSpki })
      .fetch(`${phone.base}/host/blob/${clan.id}/${header.files[0]!.sha256}`, { headers: other.app.sync.authHeaders('GET', `/host/blob/${clan.id}/${header.files[0]!.sha256}`, '') });
    expect(res.status).toBe(404);

    // interrupted: the destination crashes during verification after part of a large file arrived
    let crash = true;
    const flaky: HostingDestination = { ...bind(desk.app.hosting), completeStaging: async (id) => { if (crash) { crash = false; throw new Error('power loss'); } return desk.app.hosting.completeStaging(id); } };
    await expect(pull(phone, desk, clan.id, delegation, flaky)).rejects.toThrow('power loss');
    expect(desk.app.hosting.status(clan.id, desk.signer.publicKey)).toMatchObject({ epoch: 0, writable: false });
    const bigPath = desk.app.hosting.stagingPath(clan.id, f.sha256);
    writeFileSync(`${bigPath}.part`, readFileSync(bigPath).subarray(0, 1_000_000)); // as if cut mid-file: resumed by range
    writeFileSync(bigPath, ''); // and the final copy truncated
    expect(await pull(phone, desk, clan.id, delegation)).toMatchObject({ epoch: 1, writable: true });

    expect(phone.app.hosting.status(clan.id, phone.signer.publicKey)).toMatchObject({ state: 'relinquished', writable: false });
    expect(desk.app.chat.page(thread.id).map((m) => m.body)).toEqual(['Lab tomorrow']);
    expect(desk.app.files.list(desk.me, { kind: 'clan', clanId: clan.id })[0]?.sha256).toBe(f.sha256);
    expect(desk.app.clans.isActiveMember(clan.id, desk.app.me)).toBe(true);
    // re-running after success is harmless: the source re-delivers only the transition it signed for this device
    expect(await pull(phone, desk, clan.id, delegation)).toMatchObject({ epoch: 1, writable: true });
    // the phone learns the new head and stays a standby
    expect(await phone.app.hosting.accept(desk.app.hosting.chainOf(clan.id), phone.signer.publicKey)).toMatchObject({ epoch: 1, state: 'standby' });
    for (const x of [phone, desk, other]) x.db.close();
  }, 60_000);
});

/** The phone's side of a push: pinned, device-signed JSON calls to the computer, reading blobs of its own checkpoint. */
function pusher(from: Dev, to: Dev, clanId: string, fail?: (path: string) => boolean) {
  const d = from.app.sync.devices().find((x) => x.fp === to.fp)!, t = pinnedTransport({ certificate: d.tlsCa, spkiSha256: d.tlsSpki });
  return {
    call: async (path: string, body: unknown) => {
      const raw = JSON.stringify(body);
      const res = await t.fetch(`${to.base}${path}`, { method: 'POST', headers: { ...from.app.sync.authHeaders('POST', path, raw), 'content-type': 'application/json' }, body: raw });
      const json = await res.json() as { message?: string };
      if (!res.ok) throw new Error(`${res.status} ${json.message ?? ''}`);
      if (fail?.(path)) throw new Error('connection lost'); // the request reached the computer; the answer did not
      return json;
    },
    read: async (sha: string, offset: number, length: number) => {
      const fh = await open(from.app.hosting.checkpointBlob(clanId, sha)!, 'r');
      try { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, offset); return new Uint8Array(b.subarray(0, bytesRead)); } finally { await fh.close(); }
    },
  };
}

/** A plain object view of the destination's methods (so a test can override one). */
function bind(h: HostingDestination): HostingDestination {
  return { beginStaging: h.beginStaging.bind(h), missingBlobs: h.missingBlobs.bind(h), stagingPath: h.stagingPath.bind(h), completeStaging: h.completeStaging.bind(h), acknowledge: h.acknowledge.bind(h), accept: h.accept.bind(h) };
}

describe('persistent hosting hand-over pushed by the phone', () => {
  it('the phone pushes its CLAN to the linked computer: resumable, only by the current host, re-deliverable, revocable', async () => {
    const phone = await device('Phone'), desk = await device('Desktop'), other = await device('Other laptop');
    await link(desk, phone); await link(desk, other);
    const clan = phone.app.clans.create({ type: 'PROJECT_TEAM', name: 'Robotics', createdBy: phone.app.me });
    phone.app.hosting.establish(clan.id, phone.app.me, phone.signer);
    phone.app.chat.post({ id: randomUUID(), threadId: phone.app.chat.groupThread(clan.id).id, author: 'h', authorName: 'Owner', body: 'Created on my phone' });
    const big = `${phone.storageDir}/cad.bin`; writeFileSync(big, Buffer.alloc(2_500_000, 3));
    await phone.app.files.add(phone.me, big, 'cad.bin', { kind: 'clan', clanId: clan.id });
    const delegation = phone.app.hosting.delegate(clan.id, phone.signer, desk.signer.publicKey, { id: randomUUID() });
    phone.app.hosting.freeze(clan.id, phone.signer.publicKey);
    await phone.app.hosting.prepareCheckpoint(clan.id, phone.signer.publicKey);
    const meta = { type: 'PROJECT_TEAM', name: 'Robotics', expiresAt: null };
    const push = (p: ReturnType<typeof pusher>, read = p.read) => pushClan({ call: p.call, read, source: phone.app.hosting, clanId: clan.id, delegation, signer: phone.signer, clan: meta, chunkBytes: 1_000_000 });

    // another linked device is not the CLAN's host: it cannot start or continue a hand-over to the computer
    const fromOther = pusher(other, desk, clan.id);
    await expect(fromOther.call('/host/push/begin', { chain: phone.app.hosting.chainOf(clan.id), delegation, header: phone.app.hosting.checkpointOf(clan.id)!.header, clan: meta })).rejects.toThrow(/403.*current host/);
    await expect(fromOther.call('/host/push/complete', { clanId: clan.id })).rejects.toThrow(/403/);

    // the phone's upload stops after the first chunk of the large file; the next attempt resumes from that offset
    const p = pusher(phone, desk, clan.id);
    await expect(push(p, async (sha, off, len) => { if (off >= 1_000_000) throw new Error('app suspended'); return p.read(sha, off, len); })).rejects.toThrow('app suspended');
    expect(desk.app.hosting.status(clan.id, desk.signer.publicKey)).toMatchObject({ epoch: 0, writable: false });
    let resent = 0;
    // and this time the answer to activation is lost after the phone durably relinquished
    const lossy = pusher(phone, desk, clan.id, (path) => path === '/host/push/activate' && !resent++);
    const offsets: number[] = [];
    await expect(push(lossy, async (sha, off, len) => { offsets.push(off); return p.read(sha, off, len); })).rejects.toThrow('connection lost');
    expect(offsets).toEqual([1_000_000, 2_000_000]); // only the rest of the large file was sent again
    expect(phone.app.hosting.status(clan.id, phone.signer.publicKey)).toMatchObject({ state: 'relinquished', writable: false });
    expect(await push(p)).toMatchObject({ epoch: 1, writable: true }); // re-delivers only the signed transition
    expect(desk.app.hosting.status(clan.id, desk.signer.publicKey)).toMatchObject({ epoch: 1, writable: true });
    expect(desk.app.chat.page(desk.app.chat.groupThread(clan.id).id).map((m) => m.body)).toEqual(['Created on my phone']);
    expect(desk.app.clans.get(clan.id)).toMatchObject({ type: 'PROJECT_TEAM', name: 'Robotics' });

    // the owner revokes from the phone: the computer stops accepting writes for the CLAN
    await p.call('/host/push/revoke', phone.app.hosting.revoke(clan.id, phone.signer, delegation.id));
    expect(desk.app.hosting.status(clan.id, desk.signer.publicKey)).toMatchObject({ epoch: 1, writable: false });
    await expect(fromOther.call('/host/push/revoke', { ...phone.app.hosting.revoke(clan.id, phone.signer, delegation.id), sig: 'A'.repeat(86) })).rejects.toThrow();
    for (const x of [phone, desk, other]) x.db.close();
  }, 60_000);
});
