// Milestone 2.6: the mobile client's security logic, run in Node.
// What is real here: the bridge protocol (createBridgeHandler + bridgedOpaqueClient) over an async message channel
// around the REAL @serenity-kit/opaque 1.1 client (what runs inside the mobile WebView); the mobile Ed25519 signer
// (seedSigner, @noble/curves); the shared pairing/reconnect/receipt code the app calls.
// What stands in: the native pinned transport is replaced by the Node pinned transport (same trust rule). The iOS
// trust code is exercised separately on Apple Security (modules/pinned-transport/tests); Android isn't run here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as opaque from '@serenity-kit/opaque';
import { randomUUID } from 'node:crypto';
import { b64u, keyFingerprint, verifyReceipt } from '@classroom/protocol';
import { ClassroomConnection, pairAndJoin, reconnect, seedSigner, type OpaqueClient } from '@classroom/client';
import { bridgedOpaqueClient, createBridgeHandler } from '@classroom/client/opaque-bridge';
import { pinnedTransport, uploadSubmission, downloadResource } from '@classroom/client/node';
import { startClassroomServer, type RunningServer } from '../src/index.ts';
import { bootstrapRelay, makeFile, tlsInterceptor, tmp, trustServer } from './helpers.ts';

const servers: RunningServer[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((f) => f()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

/** The WebView, simulated: real OPAQUE library behind the real bridge handler, messages hop asynchronously. */
async function webViewBridge(): Promise<{ client: OpaqueClient; handler: (m: unknown) => string | null }> {
  await opaque.ready;
  const handler = createBridgeHandler(opaque.client, () => b64u.encode(crypto.getRandomValues(new Uint8Array(18))));
  const b = bridgedOpaqueClient((msg) => { setTimeout(() => { const r = handler(msg); if (r) setTimeout(() => b.receive(r), 0); }, 0); });
  return { client: b.client, handler };
}
const phone = () => seedSigner(crypto.getRandomValues(new Uint8Array(32)));
const names = { fullName: 'Sara Ali', rollNo: 'FA23-CS-200', deviceName: 'Pixel 8' };
async function classroom(policy: 'open' | 'approval' = 'open') {
  const s = await startClassroomServer({ title: 'Mobile', host: '127.0.0.1', code: '482915' });
  servers.push(s);
  trustServer(s);
  s.classroom.setPolicy(policy);
  return s;
}
const join = async (s: RunningServer, device = phone(), code = '482915', bootstrapUrl = s.bootstrapUrl) =>
  pairAndJoin({ candidates: [{ url: bootstrapUrl, sid: s.classroom.id }], code, profile: names, device, opaque: (await webViewBridge()).client, transportFor: pinnedTransport });

describe('mobile OPAQUE bridge protocol', () => {
  it('only three typed operations; handles are single use; malformed input is refused', async () => {
    const { handler } = await webViewBridge();
    expect(handler('not json')).toBeNull();
    expect(handler(42)).toBeNull();
    expect(handler('x'.repeat(70_000))).toBeNull();
    expect(JSON.parse(handler(JSON.stringify({ id: 1, op: 'eval', code: 'x' }))!)).toEqual({ id: 1, ok: false, error: 'unsupported operation' });
    expect(JSON.parse(handler(JSON.stringify({ id: 2, op: 'startLogin', password: 123 }))!)).toMatchObject({ ok: false, error: 'bad request' });
    const st = JSON.parse(handler(JSON.stringify({ id: 3, op: 'startLogin', password: '482915' }))!);
    expect(st.ok).toBe(true);
    expect(st.result.clientLoginState).toMatch(/^[A-Za-z0-9_-]{24}$/); // a handle, not the OPAQUE state
    const fin = (h: string) => JSON.parse(handler(JSON.stringify({ id: 4, op: 'finishLogin', handle: h, loginResponse: 'AAAA', password: '482915' }))!);
    expect(fin(st.result.clientLoginState)).toMatchObject({ ok: false }); // garbage KE2: fails, and the handle is consumed
    expect(fin(st.result.clientLoginState)).toEqual({ id: 4, ok: false, error: 'unknown handle' });
  });
});

describe('mobile secure join (bridge + seed signer + pinned transport)', () => {
  it('correct code joins; WSS hello; wrong code refused', async () => {
    const s = await classroom();
    const j = await join(s);
    expect(j).toMatchObject({ status: 'approved', url: s.url });
    expect(s.classroom.roster()[0]).toMatchObject({ fullName: 'Sara Ali', trust: 'first' });
    await expect(join(s, phone(), '000000')).rejects.toMatchObject({ code: 'bad_code' });
  });

  it('fake classroom (spoofed discovery) cannot pair', async () => {
    const real = await classroom();
    const fake = await startClassroomServer({ title: 'Mobile', host: '127.0.0.1', code: '111111' });
    servers.push(fake);
    await expect(pairAndJoin({ candidates: [{ url: fake.bootstrapUrl, sid: real.classroom.id }], code: '482915', profile: names, device: phone(), opaque: (await webViewBridge()).client, transportFor: pinnedTransport }))
      .rejects.toMatchObject({ code: 'bad_code' });
  });

  it('changed pin or changed certificate in transit is refused', async () => {
    const s = await classroom();
    const mitm = await tlsInterceptor(s.url);
    cleanups.push(mitm.close);
    for (const tamper of [(b: any) => { b.binding.spkiSha256 = mitm.fake.spkiSha256; }, (b: any) => { b.binding.certificate = mitm.fake.certificate; }]) {
      const relay = await bootstrapRelay(s.bootstrapUrl, (path, body) => { if (path === '/api/pair/finish' && body.binding) tamper(body); return body; });
      cleanups.push(relay.close);
      await expect(join(s, phone(), '482915', relay.url)).rejects.toMatchObject({ code: 'mitm' });
    }
    expect(s.classroom.roster()).toHaveLength(0);
  });

  it('copied profile + public key without the private seed fails', async () => {
    const s = await classroom();
    s.classroom.setPolicy('known');
    const victim = phone();
    const v = await join(s, victim);
    s.classroom.setStatus(v.memberId, 'approved');
    const thief = { publicKey: victim.publicKey, sign: phone().sign };
    await expect(join(s, thief)).rejects.toMatchObject({ code: 'bad_proof' });
    await expect(reconnect({ url: s.url, transport: v.transport, sessionId: s.classroom.id, device: thief })).rejects.toMatchObject({ code: 'bad_proof' });
  });

  it('token expiry -> WSS closes as expired -> device-key reconnect without the code', async () => {
    const s = await classroom();
    const device = phone();
    const j = await join(s, device);
    const t0 = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(t0 + 9 * 60 * 60_000);
    const reason = await new Promise<string>((res) => new ClassroomConnection(j.url, j.token, { onClosed: res }, 5000, j.transport));
    expect(reason).toMatch(/expired|invalid/);
    const r = await reconnect({ url: j.url, transport: j.transport, sessionId: s.classroom.id, device });
    expect(r).toMatchObject({ memberId: j.memberId, status: 'approved' });
    expect(s.classroom.authenticate(r.token)).not.toBeNull();
  });

  it('download + submission over the pinned transport; signed receipt verifies with the paired teacher key', async () => {
    const s = await classroom();
    const device = phone();
    const j = await join(s, device);
    const res = await s.resources.importFile(makeFile(300_000, 'Notes.pdf').path);
    const got = await downloadResource({ transport: j.transport, url: j.url, token: j.token, resource: res, destDir: tmp() });
    const A = s.assignments.create({ title: 'Lab', maxBytes: 1_000_000 });
    const receipt = await uploadSubmission({ transport: j.transport, url: j.url, token: j.token, assignmentId: A.id, path: got.path, idempotencyKey: randomUUID() });
    expect(verifyReceipt(receipt, { trustedTeacherKey: j.binding.teacherPublicKey, sessionId: s.classroom.id }).ok).toBe(true);
    expect(receipt.payload.studentKeyFingerprint).toBe(keyFingerprint(device.publicKey));
    expect(verifyReceipt({ ...receipt, payload: { ...receipt.payload, size: 1 } }, { trustedTeacherKey: j.binding.teacherPublicKey }).ok).toBe(false);
  });
});
