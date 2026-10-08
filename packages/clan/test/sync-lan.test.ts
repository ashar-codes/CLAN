// Personal sync over the real LAN transport: HTTPS with each device's long-lived sync certificate, linking by code,
// pinned + signed sync requests, resumable object download, revocation.
import { afterAll, describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createClassroomTls, startSyncServer } from '@classroom/server';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { joinWithCode, lanSyncTransport } from '@classroom/client/sync';
import { normalizeLinkCode } from '@classroom/protocol';
import { setup, tmp, user } from './helpers.ts';

const closers: (() => Promise<unknown>)[] = [];
afterAll(async () => { for (const c of closers) await c(); });

async function device(name: string) {
  const s = setup();
  const tls = await createClassroomTls(`sync-${name}`, Date.now(), 5 * 365 * 86_400_000);
  const k = newEd25519(), signer = nodeSigner(k.privatePkcs8);
  const fp = s.app.sync.setup({ publicKey: signer.publicKey, name, platform: 'test', tlsCa: tls.certificate, tlsSpki: tls.spkiSha256 }, signer);
  const srv = await startSyncServer({ host: s.app.sync, tls, bind: '127.0.0.1', objectPath: (sha) => s.app.files.personalObject(s.app.me, sha) });
  closers.push(srv.close);
  const base = `https://127.0.0.1:${srv.port}`;
  return { ...s, name, fp, signer, base, me: user(s.app.me) };
}
type Dev = Awaited<ReturnType<typeof device>>;
const to = (from: Dev, peer: Dev) => { const d = from.app.sync.devices().find((x) => x.fp === peer.fp)!; return lanSyncTransport({ peer: peer.fp, base: peer.base, tlsCa: d.tlsCa, tlsSpki: d.tlsSpki, auth: (m, p, b) => from.app.sync.authHeaders(m, p, b) }); };
async function link(a: Dev, b: Dev, code?: string) {
  const s = a.app.sync.startLink();
  const self = b.app.sync.self();
  const joining = joinWithCode({ base: a.base, code: normalizeLinkCode(code ?? s.code)!, pollMs: 20, sign: (x) => b.signer.sign(x),
    device: { fp: self.fp, publicKey: self.publicKey, name: self.name, platform: self.platform, tlsCa: self.tlsCa, tlsSpki: self.tlsSpki, endpoints: [b.base.slice(8)] } });
  let done = false; joining.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 100 && !done && !a.app.sync.linkRequest(); i++) await new Promise((r) => setTimeout(r, 10));
  const req = a.app.sync.linkRequest();
  if (req) { expect(req.name).toBe(b.name); a.app.sync.approveLink(req.sessionId, [a.base.slice(8)]); }
  const { grant } = await joining;
  b.app.sync.adopt(grant);
}

describe('LAN personal sync', () => {
  it('links by code, syncs both ways over pinned HTTPS, resumes files, and refuses an unlinked device', async () => {
    const a = await device('MacBook'), b = await device('iPhone');
    await expect(link(a, b, 'CLAN-2222-3333-4444')).rejects.toThrow(/not right/);
    await link(a, b);

    const n = a.app.notes.create(a.me, { title: 'Over the wire', body: 'hello' });
    const p = join(tmp(), 'slides.pdf'); writeFileSync(p, randomBytes(200_000));
    const f = await a.app.files.add(a.me, p, 'slides.pdf', { kind: 'personal', ownerId: a.app.me });
    const r = await b.app.sync.syncWith(to(b, a));
    expect(r.objects).toBe(1);
    expect(b.app.notes.get(b.me, n.id)?.body).toBe('hello');
    expect(b.app.files.get(b.me, f.refId)?.sha256).toBe(f.sha256);

    b.app.tasks.create(b.me, { title: 'From the phone' });
    await b.app.sync.syncWith(to(b, a)); // the phone pushes too (one side reaching the other is enough)
    expect(a.app.tasks.list(a.me).map((x) => x.title)).toContain('From the phone');

    // a device with a different certificate can't impersonate A (pin), and an unknown key is refused (signature)
    const c = await device('Stranger');
    const fake = lanSyncTransport({ peer: a.fp, base: c.base, tlsCa: a.app.sync.self().tlsCa, tlsSpki: a.app.sync.self().tlsSpki, auth: (m, pp, bb) => b.app.sync.authHeaders(m, pp, bb) });
    await expect(fake.pull(0, 10)).rejects.toThrow();
    const stranger = lanSyncTransport({ peer: a.fp, base: a.base, tlsCa: a.app.sync.self().tlsCa, tlsSpki: a.app.sync.self().tlsSpki, auth: (m, pp, bb) => c.app.sync.authHeaders(m, pp, bb) });
    await expect(stranger.pull(0, 10)).rejects.toThrow(/not linked/);

    a.app.sync.revoke(b.fp);
    await expect(b.app.sync.syncWith(to(b, a))).rejects.toThrow(/unlinked/);
    expect(b.app.sync.selfRevoked()).toBe(true);
  }, 30_000);
});
