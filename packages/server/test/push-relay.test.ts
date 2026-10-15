// Relay production-readiness (docs/ANDROID_PUSH_ACTIVATION.md): FCM HTTP v1 request contract against a fake Google
// endpoint, dead-token handling, proxy-aware rate limiting, stale-registration purge and health check.
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createVerify, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { capHash, pushMac, pushStatement, type PushEvent } from '@classroom/protocol';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { fcmSender, pushRelay } from '../src/push-relay.ts';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const sa = { project_id: 'clan-qa-test', client_email: 'relay@clan-qa-test.iam.gserviceaccount.com', private_key: privateKey };
const event = (k: PushEvent['k'] = 'msg'): PushEvent => { const e = { k, id: crypto.randomUUID(), exp: Date.now() + 60_000, c: randomBytes(16).toString('base64url') }; return { ...e, m: pushMac(randomBytes(32).toString('base64url'), e) }; };

describe('FCM HTTP v1 sender', () => {
  it('signs an OAuth JWT grant and sends a data-only, high-priority message with TTL and collapse key', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok-1', expires_in: 3600 }), { status: 200 });
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const send = fcmSender(sa, fake), e = event('msg');
    expect((await send({ platform: 'fcm', token: 'device-token-abc', topic: null }, e)).ok).toBe(true);
    // OAuth: RS256 JWT for the firebase.messaging scope, verifiable with the service account's public key
    const form = new URLSearchParams(String(calls[0]!.init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [h, c, sig] = form.get('assertion')!.split('.');
    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toMatchObject({ alg: 'RS256' });
    expect(claims).toMatchObject({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token' });
    expect(createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig!, 'base64url'))).toBe(true);
    // send
    expect(calls[1]!.url).toBe('https://fcm.googleapis.com/v1/projects/clan-qa-test/messages:send');
    expect((calls[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
    const msg = JSON.parse(String(calls[1]!.init.body)).message;
    expect(msg.token).toBe('device-token-abc');
    expect(msg.notification).toBeUndefined(); // data only: the app verifies before anything is shown
    expect(Object.values(msg.data).every((v) => typeof v === 'string')).toBe(true); // FCM requires string data values
    expect(JSON.parse(msg.data.clan)).toEqual(e);
    expect(msg.android).toMatchObject({ priority: 'high', collapse_key: e.c });
    expect(msg.android.ttl).toMatch(/^\d+s$/);
    // the access token is reused while valid
    await send({ platform: 'fcm', token: 'device-token-abc', topic: null }, event('call'));
    expect(calls.filter((x) => x.url.includes('oauth2'))).toHaveLength(1);
    expect(JSON.parse(String(calls[2]!.init.body)).message.android.collapse_key).toBeUndefined(); // calls never collapse
  });
  it('treats UNREGISTERED and SENDER_ID_MISMATCH as dead tokens, other errors as transient', async () => {
    const reply = (status: number, body: string) => (async (url: string) => String(url).includes('oauth2') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })) : new Response(body, { status })) as typeof fetch;
    const t = { platform: 'fcm' as const, token: 'x'.repeat(20), topic: null };
    expect(await fcmSender(sa, reply(404, '{"error":{"status":"NOT_FOUND","details":[{"errorCode":"UNREGISTERED"}]}}'))(t, event())).toMatchObject({ ok: false, gone: true });
    expect(await fcmSender(sa, reply(403, '{"error":{"details":[{"errorCode":"SENDER_ID_MISMATCH"}]}}'))(t, event())).toMatchObject({ ok: false, gone: true });
    expect(await fcmSender(sa, reply(503, '{"error":{"status":"UNAVAILABLE"}}'))(t, event())).toMatchObject({ ok: false, gone: false });
  });
});

describe('relay operations', () => {
  const signedRegister = (signer: ReturnType<typeof nodeSigner>, ts: number) => { const b = { op: 'register' as const, device: signer.publicKey, platform: 'fcm' as const, token: 'device-token-xyz-123', ts, nonce: randomBytes(16).toString('base64url') }; return { ...b, sig: signer.sign(pushStatement(b)) }; };
  it('behind a loopback HTTPS proxy, rate limits apply per real client, not to everyone at once', async () => {
    const relay = pushRelay({ senders: {}, trustProxy: true });
    const srv = createServer(relay.listener); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    try {
      const hit = (ip: string) => fetch(`${url}/v1/notify`, { method: 'POST', headers: { 'x-forwarded-for': ip }, body: '{}' }).then((r) => r.status);
      for (let i = 0; i < 300; i++) await hit('203.0.113.1');
      expect(await hit('203.0.113.1')).toBe(429); // that client is limited…
      expect(await hit('203.0.113.2')).toBe(400); // …another client is not (400 = its request was looked at)
      expect(await fetch(`${url}/healthz`).then((r) => r.json())).toEqual({ ok: true, fcm: false, apns: false });
    } finally { srv.close(); relay.close(); }
  });
  it('purges registrations not refreshed in time, together with their capabilities', async () => {
    let t = Date.now();
    const signer = nodeSigner(newEd25519().privatePkcs8), opts = { senders: { fcm: async () => ({ ok: true }) }, now: () => t, staleAfterMs: 1000, dbPath: `${(await import('node:os')).tmpdir()}/relay-${randomBytes(4).toString('hex')}.db` };
    let relay = pushRelay(opts);
    expect((await relay.handle('/v1/register', signedRegister(signer, t), 'a'))[0]).toBe(200);
    const cap = randomBytes(32).toString('base64url'), capId = randomBytes(16).toString('base64url');
    const g = { op: 'grant' as const, device: signer.publicKey, capId, capHash: capHash(cap), ts: t, nonce: randomBytes(16).toString('base64url') };
    expect((await relay.handle('/v1/grant', { ...g, sig: signer.sign(pushStatement(g)) }, 'a'))[0]).toBe(200);
    relay.close(); t += 5000; relay = pushRelay(opts); // restart after the stale period
    const e = { k: 'msg' as const, id: crypto.randomUUID(), exp: t + 60_000, c: capId };
    expect((await relay.handle('/v1/notify', { op: 'notify', cap, event: { ...e, m: pushMac(randomBytes(32).toString('base64url'), e) } }, 'b'))[0]).toBe(404);
    relay.close();
  });
});
