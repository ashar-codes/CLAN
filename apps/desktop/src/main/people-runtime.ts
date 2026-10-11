// People runtime for a computer (no Electron imports: tests drive it directly). Joins the People core (rules and
// storage), the people endpoint (server), the peer client and DNS-SD: delivers the outbox, downloads accepted files,
// finds nearby people, carries live call signaling, and serves phones over their authenticated socket.
import { randomBytes } from 'node:crypto';
import { mkdir, open, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalBytes, peerBindingValid, profileQr, parseProfileQr, PeerTlsBinding, ProfileView, type PeerEnvelope } from '@classroom/protocol';
import { advertisePeople, browsePeople, startPeopleServer } from '@classroom/server';
import { hello, peerClient, PeerHttpError } from '@classroom/client/people';
import type { People } from '@clan/core';

export type NearbyPerson = { key: string; name: string; profile: ProfileView; endpoint: string; relation: string; seenAt: number; verified: boolean };
type Signer = { publicKey: string; sign(b: Uint8Array): string };
type Tls = { certPem: string; keyPem: string; certificate: string; spkiSha256: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function startPeopleRuntime(o: {
  people: People; signer: Signer; tls: Tls; dir: string; port?: number; bind?: string; discover: boolean;
  endpoints(port: number): string[]; onLive?(e: PeerEnvelope): void; onChange?(what: string): void; now?: () => number; tickMs?: number;
}) {
  const p = o.people, now = o.now ?? (() => Date.now());
  p.setSigner(o.signer);
  const bindingBody = { type: 'clan-peer-tls' as const, v: 1 as const, key: o.signer.publicKey, spkiSha256: o.tls.spkiSha256, certificate: o.tls.certificate, issuedAt: now() };
  const binding = PeerTlsBinding.parse({ ...bindingBody, sig: o.signer.sign(canonicalBytes(bindingBody)) });
  const incoming = join(o.dir, 'incoming');
  await mkdir(incoming, { recursive: true });
  const changed = (w: string) => o.onChange?.(w);
  const downloadsNow = new Set<string>();

  const server = await startPeopleServer({
    tls: o.tls, port: o.port, bind: o.bind, now,
    host: {
      myKey: () => o.signer.publicKey, binding: () => binding, visibility: () => p.visibility(),
      reachableBy: (k, i) => p.reachableBy(k, i), profileFor: (k, i) => p.profileFor(k, i),
      introduce: (from, raw) => {
        const i = raw as { binding?: unknown; endpoints?: unknown; profile?: unknown };
        const b = PeerTlsBinding.safeParse(i?.binding);
        const tls = b.success && b.data.key === from && peerBindingValid(b.data) ? { certificate: b.data.certificate, spkiSha256: b.data.spkiSha256 } : undefined;
        const endpoints = tls && Array.isArray(i.endpoints) ? i.endpoints.filter((e): e is string => typeof e === 'string' && /^[0-9.]{7,15}:\d{2,5}$/.test(e)).slice(0, 6) : [];
        const prof = i?.profile as { profile?: { key?: string } } | null;
        if (prof?.profile?.key === from) p.meet({ profile: prof, endpoints, tls });
      },
      receive: (env, from) => {
        const r = p.receive(env, from);
        if (r.live) o.onLive?.(r.live);
        else { changed(r.kind); p.wake(from); void tick(); }
        return r;
      },
      outgoingBytes: (id, k) => { const b = p.outgoingBytes(id, k); if (b) p.outgoingServed(id); return b; },
      incomingChunk: async (id, k, offset, bytes) => {
        const t = p.transfer(id);
        const conv = t && p.pendingDownloads().find((x) => x.id === id);
        if (!t || !conv || conv.peerKey !== k) throw Object.assign(new Error('No such file for you.'), { code: 'not_found' });
        const part = join(incoming, `${id}.part`);
        const have = await stat(part).then((s) => s.size, () => 0);
        if (offset !== have) return { have };
        if (have + bytes.length > t.size) throw Object.assign(new Error('More bytes than offered.'), { code: 'invalid' });
        const fh = await open(part, 'a');
        try { await fh.write(bytes); } finally { await fh.close(); }
        p.progress(id, have + bytes.length);
        if (have + bytes.length === t.size) { try { await p.completeDownload(id, part); } catch (e) { await rm(part, { force: true }); throw e; } changed('transfers'); }
        return { have: have + bytes.length };
      },
      queuedFor: (k) => p.due(Number.MAX_SAFE_INTEGER, 1000).filter((d) => d.to === k).map((d) => ({ id: d.id, envelope: d.envelope })),
      sent: (id) => { p.delivered(id); changed('delivered'); },
      onPhone: (k, on) => { if (on) p.wake(k); changed('presence'); },
    },
  });

  // ---- delivery ----
  /** How the recipient reaches and shows us: our signed TLS binding, our endpoints and the profile they may see. */
  const intro = (to: string) => ({ binding, endpoints: o.endpoints(server.port), profile: p.profileFor(to).profile });
  const clientFor = (key: string) => {
    const r = p.route(key);
    if (!r?.tls || !r.endpoints.length) return null;
    return r.endpoints.map((endpoint) => peerClient({ endpoint, tls: r.tls!, peerKey: key, signer: o.signer }));
  };
  let ticking: Promise<void> | null = null;
  const tick = (): Promise<void> => ticking ??= (async () => {
    try {
      const due = p.due(now());
      const byPeer = new Map<string, typeof due>();
      for (const d of due) byPeer.set(d.to, [...(byPeer.get(d.to) ?? []), d]);
      for (const [key, items] of byPeer) {
        const clients = clientFor(key);
        if (!clients) { const sent = server.notifyPhone(key); for (const d of items) p.deliveryFailed(d.id, sent ? 'Waiting for the phone to confirm.' : 'Not reachable now.'); continue; }
        let done = false;
        for (const c of clients) {
          try {
            const results = await c.send(items.map((d) => d.envelope), intro(key));
            items.forEach((d, i) => { const r = results[i]; if (r?.ok) p.delivered(d.id); else p.deliveryFailed(d.id, r?.error ?? 'refused', r?.final ?? true); });
            done = true; break;
          } catch (e) { if (e instanceof PeerHttpError && e.status >= 400 && e.status < 500 && e.status !== 429) { for (const d of items) p.deliveryFailed(d.id, e.message, true); done = true; break; } }
        }
        if (!done) for (const d of items) p.deliveryFailed(d.id, 'Not reachable now.');
        changed('delivered');
      }
      for (const t of p.pendingDownloads()) {
        if (downloadsNow.has(t.id)) continue;
        const clients = clientFor(t.peerKey);
        if (!clients) continue; // a phone pushes its own files
        downloadsNow.add(t.id);
        void (async () => {
          const dest = join(incoming, t.id);
          try {
            for (const c of clients) {
              try { await c.download(t.id, dest, t.size, (n) => p.progress(t.id, n)); await p.completeDownload(t.id, dest); changed('transfers'); return; }
              catch (e) { if (e instanceof PeerHttpError && e.status === 404) { p.failDownload(t.id, 'The sender no longer offers this file.'); return; } if ((e as { code?: string }).code === 'corrupt') return; }
            }
          } finally { downloadsNow.delete(t.id); await rm(dest, { force: true }).catch(() => {}); }
        })();
      }
      await p.sweep();
    } catch (e) { console.warn('[people]', (e as Error).message); }
    finally { ticking = null; }
  })();
  const timer = setInterval(() => void tick(), o.tickMs ?? 3000);
  timer.unref?.();

  // ---- live signaling (calls): sent directly, never queued ----
  const sendLive = async (env: PeerEnvelope) => {
    const clients = clientFor(env.to);
    if (clients) {
      for (const c of clients) { try { const [r] = await c.send([env], intro(env.to)); if (r?.ok) return true; throw new PeerHttpError(403, r?.error ?? 'refused', 'The other person did not accept the call.'); } catch (e) { if (e instanceof PeerHttpError && e.status) throw e; } }
      return false;
    }
    return server.notifyPhone(env.to, { id: env.id, envelope: env });
  };

  // ---- discovery ----
  const nearby = new Map<string, NearbyPerson>();
  let stopAd: (() => Promise<void>) | null = null, adVis = '', adAt = 0;
  const advertise = async () => {
    const vis = p.visibility();
    if (vis === adVis && now() - adAt < 3_600_000) return;
    await stopAd?.(); stopAd = null;
    adVis = vis; adAt = now();
    if (vis !== 'invisible' && o.discover) stopAd = advertisePeople({ port: server.port, r: randomBytes(12).toString('base64url') });
  };
  const probe = async (endpoint: string, invite?: string) => {
    const b = await hello(endpoint, o.signer, { invite });
    const c = peerClient({ endpoint, tls: b, peerKey: b.key, signer: o.signer, invite });
    const profile = await c.profile();
    const contact = p.meet({ profile, endpoints: [endpoint], tls: { certificate: b.certificate, spkiSha256: b.spkiSha256 } });
    p.wake(b.key);
    return { binding: b, contact };
  };
  const byAdvert = new Map<string, string>(); // advert id -> key
  const stopBrowse = o.discover ? browsePeople((s) => {
    const endpoint = `${s.addr}:${s.port}`;
    if (endpoint === `${o.bind ?? ''}:${server.port}` || s.port === server.port && o.endpoints(server.port).includes(endpoint)) return;
    void probe(endpoint).then(({ contact }) => {
      byAdvert.set(s.r, contact.key);
      if (contact.profile) nearby.set(contact.key, { key: contact.key, name: contact.name, profile: contact.profile, endpoint, relation: contact.relation, seenAt: now(), verified: contact.verified });
      changed('nearby'); void tick();
    }, () => { /* hidden or not reachable: never shown */ });
  }, (r) => { const k = byAdvert.get(r); if (k && nearby.delete(k)) changed('nearby'); }) : () => {};
  void advertise();
  const adTimer = setInterval(() => void advertise(), 30_000); adTimer.unref?.();

  return {
    port: server.port, binding,
    myQr: () => profileQr({ key: o.signer.publicKey, endpoints: o.endpoints(server.port), spkiSha256: o.tls.spkiSha256, name: p.myProfile().name, invite: p.inviteToken() }),
    /** Scanned or typed QR: connect, require the key and certificate pin it promised, record as verified. */
    async connectQr(text: string) {
      const q = parseProfileQr(text);
      if (!q) throw new Error('That is not a CLAN profile code.');
      let last: Error = new Error('Could not reach that person. Make sure you are on the same network.');
      for (const e of q.endpoints) {
        try {
          const r = await probe(e, q.invite);
          if (r.binding.key !== q.key || r.binding.spkiSha256 !== q.spkiSha256) throw new Error('That device did not match the code (identity changed).');
          p.markVerified(q.key);
          return p.contact(q.key)!;
        } catch (err) { last = err as Error; }
      }
      throw last;
    },
    probe,
    nearby: () => [...nearby.values()].filter((n) => now() - n.seenAt < 10 * 60_000 && !p.isBlocked(n.key)).map((n) => ({ ...n, relation: p.contact(n.key)?.relation ?? 'none' })),
    refreshDiscovery: () => { adAt = 0; return advertise(); },
    sendLive, tick, server,
    async stop() { clearInterval(timer); clearInterval(adTimer); stopBrowse(); await stopAd?.(); await server.close(); },
  };
}
export const isUuid = (s: string) => UUID.test(s);
