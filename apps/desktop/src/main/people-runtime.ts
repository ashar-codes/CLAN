// People runtime for a computer (no Electron imports: tests drive it directly). Joins the People core (rules and
// storage), the people endpoint (server), the peer client and DNS-SD: delivers the outbox, downloads accepted files,
// finds nearby people, carries live call signaling, and serves phones over their authenticated socket.
import { networkInterfaces } from 'node:os';
import { lanDirectoryClient, LanDirectoryAgent } from '@classroom/client';
import { pinnedTransport } from '@classroom/client/node';
import { directoryConfig, type DirectoryConfig, type DirectoryAdvert } from '@classroom/protocol';
import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, open, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalBytes, peerBindingValid, profileQr, parseProfileQr, PeerTlsBinding, ProfileView, type PeerEnvelope } from '@classroom/protocol';
import { advertiseLinks, advertisePeople, browseLinks, browsePeople, listenLinks, startPeopleServer, tcpTransport } from '@classroom/server';
import { hello, peerClient, PeerHttpError } from '@classroom/client/people';
import { ConnectionManager, probeAnonymously, type LinkFiles, type People } from '@clan/core';
import { newEd25519, nodeSigner } from '@classroom/client/node';

export type NearbyPerson = { key: string; name: string; profile: ProfileView; endpoint: string; relation: string; seenAt: number; verified: boolean; network?: string; connection?: string };
type Signer = { publicKey: string; sign(b: Uint8Array): string };
type Tls = { certPem: string; keyPem: string; certificate: string; spkiSha256: string };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function startPeopleRuntime(o: {
  people: People; signer: Signer; tls: Tls; dir: string; port?: number; bind?: string; discover: boolean;
  endpoints(port: number): string[]; onLive?(e: PeerEnvelope): void; onChange?(what: string): void; now?: () => number; tickMs?: number;
  /** Accept 127.x endpoints from introductions (tests and development only). */
  allowLoopback?: boolean;
  /** Port for clan-link/1 (phones, hotspots and other router-free paths); a fresh one when omitted or taken. */
  linkPort?: number; directory?: DirectoryConfig | null; ownClans?(): DirectoryAdvert[]; onClans?(items: DirectoryAdvert[], expires: number): void;
}) {
  const p = o.people, now = o.now ?? (() => Date.now());
  p.setSigner(o.signer);
  const bindingBody = { type: 'clan-peer-tls' as const, v: 1 as const, key: o.signer.publicKey, spkiSha256: o.tls.spkiSha256, certificate: o.tls.certificate, issuedAt: now() };
  const binding = PeerTlsBinding.parse({ ...bindingBody, sig: o.signer.sign(canonicalBytes(bindingBody)) });
  const incoming = join(o.dir, 'incoming');
  await mkdir(incoming, { recursive: true });
  const changed = (w: string) => o.onChange?.(w);
  const downloadsNow = new Set<string>();
  const avatarTried = new Set<string>(); // key:sha — once per picture per run

  const server = await startPeopleServer({
    tls: o.tls, port: o.port, bind: o.bind, now,
    host: {
      myKey: () => o.signer.publicKey, binding: () => binding, visibility: () => p.visibility(),
      reachableBy: (k, i) => p.reachableBy(k, i), profileFor: (k, i) => p.profileFor(k, i),
      avatar: (k, i) => p.avatarFor(k, i),
      introduce: (from, raw) => {
        const i = raw as { binding?: unknown; endpoints?: unknown; profile?: unknown };
        const b = PeerTlsBinding.safeParse(i?.binding);
        const tls = b.success && b.data.key === from && peerBindingValid(b.data) ? { certificate: b.data.certificate, spkiSha256: b.data.spkiSha256 } : undefined;
        const endpoints = tls && Array.isArray(i.endpoints) ? i.endpoints.filter((e): e is string => typeof e === 'string' && /^[0-9.]{7,15}:\d{2,5}$/.test(e) && (o.allowLoopback || !/^(127\.|0\.)/.test(e))).slice(0, 6) : [];
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
      sent: (id, recipient) => { p.delivered(id, recipient); changed('delivered'); },
      refused: (id, recipient) => { if (p.queuedFor(recipient).some((q) => q.id === id)) p.deliveryFailed(id, 'Recipient refused this item.', true); },
      onPhone: (k, on) => { if (on) { p.wake(k); p.friendReachable(k); } changed('presence'); },
    },
  });

  // ---- clan-link/1: the same people, reached over any network without a TLS endpoint (phones, hotspots) ----
  const files: LinkFiles = {
    async read(path, offset, length) { const fh = await open(path, 'r'); try { const b = Buffer.alloc(length); const { bytesRead } = await fh.read(b, 0, length, offset); return new Uint8Array(b.subarray(0, bytesRead)); } finally { await fh.close(); } },
    append: (path, bytes) => appendFile(path, bytes),
    size: async (path) => (await stat(path)).size,
    remove: (path) => rm(path, { force: true }),
    partPath: (id) => join(incoming, `${id}.link.part`),
  };
  let linkPort = 0;
  const linkAddrs = () => o.endpoints(server.port).map((e) => `tcp:${e.slice(0, e.lastIndexOf(':'))}:${linkPort}`);
  const cm = new ConnectionManager({ people: p, signer: o.signer, files, onLive: (e) => o.onLive?.(e), onChange: changed, myAddrs: linkAddrs, tickMs: o.tickMs ?? 3000, maintainFriends: () => o.discover && !stopped, networks: () => Object.values(networkInterfaces()).flatMap((v) => v ?? []).filter((v) => v.family === 'IPv4' && !v.internal).map((v) => ({ address: v.address, netmask: v.netmask })) }).use(tcpTransport());
  const links = await listenLinks({ port: o.linkPort, bind: o.bind, onLink: (l) => void cm.accept(l) })
    .catch((e: NodeJS.ErrnoException) => { if (o.linkPort && e.code === 'EADDRINUSE') return listenLinks({ bind: o.bind, onLink: (l) => void cm.accept(l) }); throw e; });
  linkPort = links.port;

  // ---- delivery ----
  /** How the recipient reaches and shows us: our signed TLS binding, our endpoints and the profile they may see. */
  const intro = (to: string) => ({ binding, endpoints: o.endpoints(server.port), profile: p.profileFor(to).profile });
  const clientFor = (key: string) => {
    const r = p.route(key);
    if (!r?.tls || !r.endpoints.length) return null;
    return r.endpoints.map((endpoint) => peerClient({ endpoint, tls: r.tls!, peerKey: key, signer: o.signer }));
  };
  let ticking: Promise<void> | null = null, nextTick: Promise<void> | null = null;
  let stopped = false;
  const flushLinks = () => Promise.all([...new Set(p.due(Number.MAX_SAFE_INTEGER, 1000).map((d) => d.to))]
    .map((key) => cm.session(key)?.flush()));
  const tick = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    // A change during a round may be newer than its outbox snapshot. Coalesce callers
    // into one subsequent round rather than returning a promise that predates their work.
    if (ticking) return nextTick ??= ticking.then(() => { nextTick = null; return tick(); });
    return ticking = (async () => {
      await null; // never settle synchronously (see LinkSession.flush)
      try {
        await cm.tick();
        await flushLinks();
        const due = p.due(now());
        const byPeer = new Map<string, typeof due>();
        for (const d of due) byPeer.set(d.to, [...(byPeer.get(d.to) ?? []), d]);
        for (const [key, items] of byPeer) {
          if (cm.connected(key)) continue; // an open link session delivers it (with an authenticated receipt)
          const clients = clientFor(key);
          if (!clients) { const sent = server.notifyPhone(key); for (const d of items) p.deliveryFailed(d.id, sent ? 'Waiting for the phone to confirm.' : 'Not reachable now.'); continue; }
          let done = false;
          for (const c of clients) {
            try {
              for (const d of items) p.sending(d.id);
              const results = await c.send(items.map((d) => d.envelope), intro(key));
              items.forEach((d, i) => { const r = results[i]; if (r?.ok) p.delivered(d.id); else p.deliveryFailed(d.id, r?.error ?? 'refused', r?.final ?? true); });
              done = true; break;
            } catch (e) { if (e instanceof PeerHttpError && e.status >= 400 && e.status < 500 && e.status !== 429) { for (const d of items) p.deliveryFailed(d.id, e.message, true); done = true; break; } }
          }
          if (!done) for (const d of items) p.deliveryFailed(d.id, 'Not reachable now.');
          changed('delivered');
        }
        for (const t of p.pendingDownloads()) {
          if (downloadsNow.has(t.id) || cm.connected(t.peerKey)) continue;
          const clients = clientFor(t.peerKey);
          if (!clients) continue; // a phone pushes its own files
          downloadsNow.add(t.id);
          void (async () => {
            const dest = join(incoming, t.id);
            try {
              for (const c of clients) {
                try { await c.download(t.id, dest, t.size, (n) => p.progress(t.id, n)); await p.completeDownload(t.id, dest); changed('transfers'); return; }
                catch (e) {
                  if (e instanceof PeerHttpError && e.status === 404) { p.failDownload(t.id, 'The sender no longer offers this file.'); return; }
                  if ((e as { code?: string }).code === 'ENOSPC') { p.failDownload(t.id, 'The disk is full. Free some space, then retry.'); return; }
                  if ((e as { code?: string }).code === 'corrupt') return;
                }
              }
            } finally { downloadsNow.delete(t.id); await rm(dest, { force: true }).catch(() => {}); }
          })();
        }
        // pictures of people we can reach over TLS (link sessions fetch their own)
        for (const c of p.contacts('all').slice(0, 50)) {
          const want = p.wantedAvatar(c.key);
          if (!want || cm.connected(c.key) || avatarTried.has(`${c.key}:${want}`)) continue;
          avatarTried.add(`${c.key}:${want}`);
          const clients = clientFor(c.key); if (!clients) continue;
          void clients[0]!.avatar().then((a) => { if (a) { p.storeAvatar(c.key, a.mime, a.data); changed('contacts'); } }, () => {});
        }
        await cm.tick(); // include sessions that connected during the HTTPS round
        await flushLinks();
        await p.sweep();
      } catch (e) { console.warn('[people]', (e as Error).message); }
      finally { ticking = null; }
    })();
  };
  const timer = setInterval(() => void tick(), o.tickMs ?? 3000);
  timer.unref?.();

  // ---- live signaling (calls): sent directly, never queued ----
  const sendLive = async (env: PeerEnvelope) => {
    if (cm.connected(env.to)) return cm.sendLive(env);
    const clients = clientFor(env.to);
    if (clients) {
      for (const c of clients) { try { const [r] = await c.send([env], intro(env.to)); if (r?.ok) return true; throw new PeerHttpError(403, r?.error ?? 'refused', 'The other person did not accept the call.'); } catch (e) { if (e instanceof PeerHttpError && e.status) throw e; } }
      return false;
    }
    return server.notifyPhone(env.to, { id: env.id, envelope: env });
  };

  // ---- discovery ----
  // Adverts carry random ids plus our presence tag (recognisable only by friends). Adverts that match a friend get a
  // real-identity connection; any other advert is looked at under a throwaway identity, so only people who chose
  // Everyone Nearby answer, and nobody learns who is looking.
  const nearby = new Map<string, NearbyPerson>();
  let stopAd: (() => Promise<void>) | null = null, adVis = '', adAt = 0;
  let advertising: Promise<void> | null = null, advertiseAgain = false;
  const advertise = (): Promise<void> => {
    if (advertising) { advertiseAgain = true; return advertising; }
    return advertising = (async () => {
      await null;
      do {
        advertiseAgain = false;
        if (stopped) break;
        if (p.visibility() === adVis && now() - adAt < 3_600_000) continue;
        const previous = stopAd; stopAd = null; await previous?.();
        if (stopped) break;
        // Visibility may change while the multicast goodbye is in flight.
        const vis = p.visibility(); adVis = vis; adAt = now();
        if (vis !== 'invisible' && o.discover) {
          const r1 = randomBytes(12).toString('base64url'), r2 = randomBytes(12).toString('base64url');
          const a = advertisePeople({ port: server.port, r: r1, t: p.presenceTagFor(r1) }), b = advertiseLinks({ port: linkPort, r: r2, t: p.presenceTagFor(r2) });
          stopAd = async () => { await a(); await b(); };
        }
      } while (advertiseAgain);
    })().finally(() => { advertising = null; });
  };
  const probe = async (endpoint: string, invite?: string, signer: Signer = o.signer, expected?: { key: string; spkiSha256?: string }) => {
    const b = await hello(endpoint, signer, { invite });
    if (expected && (b.key !== expected.key || expected.spkiSha256 && b.spkiSha256 !== expected.spkiSha256)) throw new Error('That device did not match the expected identity.');
    const c = peerClient({ endpoint, tls: b, peerKey: b.key, signer, invite });
    const profile = await c.profile();
    const contact = p.meet({ profile, endpoints: [endpoint], tls: { certificate: b.certificate, spkiSha256: b.spkiSha256 } });
    if (signer === o.signer) p.wake(b.key);
    return { binding: b, contact };
  };
  const seen = (c: { key: string; name: string; profile: ProfileView | null; relation: string; verified: boolean } | null, endpoint: string, r: string, network = 'Same LAN') => {
    if (stopped || !c?.profile || p.isBlocked(c.key)) return;
    if (!nearby.has(c.key)) p.friendReachable(c.key);
    byAdvert.set(r, c.key);
    nearby.set(c.key, { key: c.key, name: c.name, profile: c.profile, endpoint, relation: c.relation, seenAt: now(), verified: c.verified, network });
    changed('nearby');
  };
  const byAdvert = new Map<string, string>(); // advert id -> key
  const lost = (r: string) => { const k = byAdvert.get(r); byAdvert.delete(r); if (k && ![...byAdvert.values()].includes(k) && nearby.delete(k)) changed('nearby'); };
  const tried = new Map<string, number>();
  const fresh = (r: string) => { if ((tried.get(r) ?? 0) > now() - 60_000) return false; if (tried.size >= 256) tried.delete(tried.keys().next().value!); tried.set(r, now()); return true; };
  const makeBrowse = () => o.discover ? browsePeople((s) => {
    const endpoint = `${s.addr}:${s.port}`;
    if (endpoint === `${o.bind ?? ''}:${server.port}` || s.port === server.port && o.endpoints(server.port).includes(endpoint)) return;
    if (!fresh(`${s.r}|${endpoint}`)) return;
    const friend = s.t ? p.matchPresence(s.r, s.t) : null;
    if (friend && p.visibility() === 'invisible') return;
    void probe(endpoint, undefined, friend ? o.signer : nodeSigner(newEd25519().privatePkcs8)).then(({ contact }) => {
      if (friend && contact.key !== friend) return; // a presence tag copied by someone else: ignored
      seen(contact, endpoint, s.r); void tick();
    }, () => { /* hidden or not reachable: never shown */ });
  }, lost) : () => {};
  // link-only devices (phones) too
  const makeLinkBrowse = () => o.discover ? browseLinks((sv) => {
    const addr = `tcp:${sv.addr}:${sv.port}`;
    if (sv.port === linkPort && linkAddrs().includes(addr)) return;
    if (!fresh(`${sv.r}|${addr}`)) return;
    const friend = sv.t ? p.matchPresence(sv.r, sv.t) : null;
    if (friend) {
      if (p.visibility() === 'invisible') return;
      void cm.connect(addr, { expectKey: friend, automatic: true }).then(() => seen(p.contact(friend), addr, sv.r), () => {});
      return;
    }
    void tcpTransport().dial(addr).then((l) => probeAnonymously(l)).then(({ key, profile }) => {
      try { seen(p.meet({ profile }), addr, sv.r); try { p.setLinkAddrs(key, [addr]); } catch { /* unusual address */ } } catch { /* no valid public profile */ }
    }, () => { /* hidden or not reachable */ });
  }, lost) : () => {};
  let stopBrowse = makeBrowse(), stopLinkBrowse = makeLinkBrowse();
  void advertise();
  const adTimer = setInterval(() => void advertise(), 30_000); adTimer.unref?.();

  let directory: DirectoryConfig | null = null, directoryMessage = 'LAN directory disabled.', directoryRound = 0, directoryGeneration = 0;
  const agent = new LanDirectoryAgent(() => {
    const vis = p.visibility(), r = randomBytes(12).toString('base64url');
    const ads: DirectoryAdvert[] = vis === 'invisible' ? [] : [{ kind: 'link', r, t: p.presenceTagFor(r), endpoints: linkAddrs().map((a) => a.slice(4)) }];
    return [...ads.filter((a) => a.endpoints.length), ...(o.ownClans?.() ?? [])];
  }, (items, expires) => {
    const generation = ++directoryGeneration;
    for (const [id] of byAdvert) if (id.startsWith('dir:')) lost(id);
    o.onClans?.(items.filter((a) => a.kind === 'clan'), expires);
    const selected = items.filter((a) => a.kind === 'link');
    const chunk = selected.slice(directoryRound, directoryRound + 8); directoryRound = directoryRound + 8 >= selected.length ? 0 : directoryRound + 8;
    void (async () => { for (const ad of chunk) {
      if (stopped || generation !== directoryGeneration || Date.now() > expires) break;
      const friend = ad.t ? p.matchPresence(ad.r, ad.t) : null;
      for (const ep of ad.endpoints) {
        try {
          const addr = `tcp:${ep}`;
          if (friend) { if (p.visibility() === 'invisible') continue; if (!cm.connected(friend)) await cm.connect(addr, { expectKey: friend, automatic: true }); if (generation !== directoryGeneration || stopped) break; seen(p.contact(friend), addr, `dir:${ad.r}`, 'Internal Network'); }
          else { const { key, profile } = await probeAnonymously(await tcpTransport(3000).dial(addr)); if (stopped || generation !== directoryGeneration || key === o.signer.publicKey) break; const c = p.meet({ profile }); if (!p.isBlocked(key)) { p.setLinkAddrs(key, [addr, ...p.linkAddrs(key)].slice(0, 6)); seen(c, addr, `dir:${ad.r}`, 'Internal Network'); } }
          break;
        } catch { /* directory hints cannot override authentication or visibility */ }
      }
    } })();
  }, (message) => { directoryMessage = message; changed('nearby'); });
  const configureDirectory = (raw: DirectoryConfig | null) => {
    const candidate = raw ? directoryConfig(raw, o.allowLoopback) : null;
    const client = candidate ? lanDirectoryClient({ config: candidate, signer: o.signer, nonce: () => randomBytes(18).toString('base64url'), fetch: pinnedTransport(candidate).fetch, allowLoopback: o.allowLoopback }) : null;
    directory = candidate; agent.configure(client);
    directoryMessage = directory ? 'Connecting to enrolled LAN directory…' : 'LAN directory disabled.'; if (directory) void agent.refresh(true);
  };
  if (o.directory) { try { configureDirectory(o.directory); } catch { directoryMessage = 'Saved LAN directory certificate is invalid. Direct connections still work; check the administrator configuration.'; } }
  const directoryTimer = setInterval(() => void agent.refresh(), 5000); directoryTimer.unref();

  return {
    port: server.port, binding,
    myQr: (intent?: 'profile' | 'friend' | 'chat') => profileQr({ key: o.signer.publicKey, endpoints: o.endpoints(server.port), spkiSha256: o.tls.spkiSha256, links: linkAddrs(), name: p.myProfile().name, invite: p.inviteToken(), intent }),
    /** Scanned or typed QR: connect, require the key and certificate pin it promised, record as verified. */
    async connectQr(text: string) {
      const q = parseProfileQr(text);
      if (!q) throw new Error('That is not a CLAN profile code.');
      let last: Error = new Error('Could not reach that person. Make sure you are on the same network.');
      for (const e of q.endpoints) {
        try {
          const r = await probe(e, q.invite, o.signer, { key: q.key, spkiSha256: q.spkiSha256 });
          if (r.binding.key !== q.key || r.binding.spkiSha256 !== q.spkiSha256) throw new Error('That device did not match the code (identity changed).');
          p.markVerified(q.key);
          return p.contact(q.key)!;
        } catch (err) { last = err as Error; }
      }
      for (const l of q.links) {
        try { await cm.connect(l, { expectKey: q.key, invite: q.invite }); p.markVerified(q.key); for (let i = 0; i < 20 && !p.contact(q.key)?.profile; i++) await new Promise((r) => setTimeout(r, 100)); return p.contact(q.key)!; }
        catch (err) { last = err as Error; }
      }
      throw last;
    },
    probe, configureDirectory, directory: () => ({ config: directory, status: directoryMessage }),
    networkChanged: () => { if (stopped) return; stopBrowse(); stopLinkBrowse(); tried.clear(); nearby.clear(); byAdvert.clear(); stopBrowse = makeBrowse(); stopLinkBrowse = makeLinkBrowse(); cm.networkChanged(); adAt = 0; void advertise(); void agent.refresh(true); void tick(); },
    nearby: () => [...nearby.values()].filter((n) => now() - n.seenAt < 10 * 60_000 && !p.isBlocked(n.key)).map((n) => ({ ...n, relation: p.contact(n.key)?.relation ?? 'none', connection: cm.status(n.key)?.state ?? 'nearby' })),
    refreshDiscovery: () => { adAt = 0; void agent.refresh(true); return advertise(); },
    sendLive, tick, server, links: cm, linkPort,
    async stop() { stopped = true; clearInterval(timer); clearInterval(adTimer); clearInterval(directoryTimer); agent.configure(null); stopBrowse(); stopLinkBrowse(); cm.stop(); await ticking; await advertising; await stopAd?.(); await links.close(); await server.close(); },
  };
}
export const isUuid = (s: string) => UUID.test(s);
