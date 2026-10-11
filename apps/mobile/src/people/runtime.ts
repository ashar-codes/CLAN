// People on a phone. A phone runs no server (iOS/Android cannot accept LAN connections from the background, and CLAN
// does not open one), so it is always the caller: it reaches computers by their verified code, sends with signed
// requests over certificate-pinned TLS, keeps one authenticated socket per computer for what they send back, downloads
// accepted files and pushes its own in chunks. Platform-agnostic: the app passes native transports, tests pass Node ones.
import { parseProfileQr, PeerTlsBinding, peerBindingValid, type PeerEnvelope } from '@classroom/protocol';
import { peerAuthHeaders, peerSocketAuth, type WebSocketLike } from '@classroom/client';
import type { People } from '@clan/core';

type Signer = { publicKey: string; sign(b: Uint8Array): string };
type Tls = { certificate: string; spkiSha256: string };
export type PhoneTransport = {
  fetch(url: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; ok: boolean; json(): Promise<unknown> }>;
  openWebSocket(url: string): WebSocketLike;
  /** GET with Range from `offset`, appending to `fileUri`; resolves with total bytes on disk. */
  downloadToFile(url: string, headers: Record<string, string>, fileUri: string, offset: number, onProgress: (bytes: number) => void): Promise<number>;
  /** PUT the bytes of `fileUri` (a prepared chunk); resolves with status + body. */
  uploadFromFile(url: string, headers: Record<string, string>, fileUri: string, offset: number, onProgress: (sent: number) => void): Promise<{ status: number; body: string }>;
};
export type PhoneEnv = {
  /** First contact: POST over TLS accepting any certificate, reporting the leaf SPKI it saw (compared with the code). */
  firstContact(base: string, path: string, headers: Record<string, string>, body: string): Promise<{ status: number; json: unknown; spki: string }>;
  /** Certificate-pinned transport for a verified computer. */
  transport(tls: Tls): PhoneTransport;
  files: {
    size(uri: string): Promise<number>;
    /** Bytes [offset, offset+len) copied to a temporary file (for a signed chunk upload). */
    slice(uri: string, offset: number, len: number): Promise<{ uri: string; bytes: Uint8Array }>;
    remove(uri: string): Promise<void>;
    /** Where an incoming file is assembled. */
    incoming(id: string): string;
  };
  nonce(): string;
};
export class PeerCallError extends Error { readonly status: number; constructor(status: number, m: string) { super(m); this.status = status; } }

const CHUNK = 4 * 1024 * 1024; // below the computer's 9 MiB request limit

export function startPhonePeople(o: { people: People; signer: Signer; env: PhoneEnv; onLive?(e: PeerEnvelope): void; onChange?(what: string): void; now?: () => number; tickMs?: number }) {
  const p = o.people, env = o.env, now = o.now ?? (() => Date.now());
  p.setSigner(o.signer);
  const changed = (w: string) => o.onChange?.(w);
  const transports = new Map<string, PhoneTransport>();
  const tFor = (tls: Tls) => { let t = transports.get(tls.spkiSha256); if (!t) transports.set(tls.spkiSha256, t = env.transport(tls)); return t; };

  /** Signed, pinned call to a computer's people endpoint. */
  const call = async (ep: string, tls: Tls, key: string, method: string, path: string, body = '', invite?: string) => {
    const res = await tFor(tls).fetch(`https://${ep}${path}`, { method, headers: { ...peerAuthHeaders(o.signer, { method, path, body, to: key, nonce: env.nonce() }), 'content-type': 'application/json', ...(invite ? { 'x-clan-invite': invite } : {}) }, body: body || undefined });
    const json = await res.json().catch(() => ({})) as { message?: string };
    if (!res.ok) throw new PeerCallError(res.status, json.message ?? `HTTP ${res.status}`);
    return json;
  };
  const intro = (to: string) => ({ profile: p.profileFor(to).profile }); // a phone has no endpoint or certificate to offer

  /** Scanned or pasted code of a computer: prove it is that identity with that certificate, then remember it as verified. */
  async function connectQr(text: string) {
    const q = parseProfileQr(text.trim());
    if (!q) throw new Error('That is not a CLAN profile code.');
    let last: Error = new Error('Could not reach that computer. Make sure you are on the same Wi-Fi.');
    for (const ep of q.endpoints) {
      try {
        const body = '{}', headers = { ...peerAuthHeaders(o.signer, { method: 'POST', path: '/peer/hello', body, to: q.spkiSha256, nonce: env.nonce() }), 'content-type': 'application/json', 'x-clan-invite': q.invite };
        const r = await env.firstContact(`https://${ep}`, '/peer/hello', headers, body);
        if (r.status !== 200) throw new Error(r.status === 403 ? 'That person is not accepting contact right now.' : `The computer refused (${r.status}).`);
        const b = PeerTlsBinding.safeParse((r.json as { binding?: unknown })?.binding);
        if (!b.success || !peerBindingValid(b.data) || b.data.key !== q.key || b.data.spkiSha256 !== q.spkiSha256 || r.spki !== q.spkiSha256) throw new Error('That device did not match the code (identity changed).');
        const tls = { certificate: b.data.certificate, spkiSha256: b.data.spkiSha256 };
        const prof = await call(ep, tls, q.key, 'POST', '/peer/profile', '{}', q.invite) as { profile: unknown };
        p.meet({ profile: prof.profile as never, endpoints: [ep], tls, verified: true });
        p.markVerified(q.key); p.wake(q.key);
        void tick();
        return p.contact(q.key)!;
      } catch (e) { last = e as Error; }
    }
    throw last;
  }

  // ---- outbox ----
  let ticking: Promise<void> | null = null;
  const inflight = new Set<string>();
  const tick = (): Promise<void> => ticking ??= (async () => {
    try {
      const byPeer = new Map<string, ReturnType<People['due']>>();
      for (const d of p.due(now())) byPeer.set(d.to, [...(byPeer.get(d.to) ?? []), d]);
      for (const [key, items] of byPeer) {
        const r = p.route(key);
        if (!r?.tls || !r.endpoints.length) { for (const d of items) p.deliveryFailed(d.id, 'Phones can reach computers only. This person is not reachable from a phone.'); continue; }
        let done = false;
        for (const ep of r.endpoints) {
          try {
            const res = await call(ep, r.tls, key, 'POST', '/peer/inbox', JSON.stringify({ envelopes: items.map((d) => d.envelope), intro: intro(key) })) as { results: { ok: boolean; error?: string; final?: boolean }[] };
            items.forEach((d, i) => { const x = res.results[i]; if (x?.ok) p.delivered(d.id); else p.deliveryFailed(d.id, x?.error ?? 'refused', x?.final ?? true); });
            done = true; break;
          } catch (e) { if (e instanceof PeerCallError && e.status >= 400 && e.status < 500 && e.status !== 429) { for (const d of items) p.deliveryFailed(d.id, e.message, true); done = true; break; } }
        }
        if (!done) for (const d of items) p.deliveryFailed(d.id, 'Not reachable now.');
        changed('delivered');
      }
      sockets();
      for (const t of p.pendingDownloads()) if (!inflight.has(t.id)) void download(t.id, t.peerKey, t.size);
      for (const t of p.pendingUploads()) if (!inflight.has(t.id) && t.path) void upload(t.id, t.peerKey, t.path, t.size);
      await p.sweep();
    } catch (e) { console.warn('[people]', (e as Error).message); }
    finally { ticking = null; }
  })();

  // ---- files ----
  async function download(id: string, key: string, size: number) {
    const r = p.route(key); if (!r?.tls || !r.endpoints[0]) return;
    inflight.add(id);
    const part = env.files.incoming(id), path = `/peer/file/${id}`;
    try {
      const have = await env.files.size(part).catch(() => 0);
      if (have < size) {
        const headers = peerAuthHeaders(o.signer, { method: 'GET', path, body: '', to: key, nonce: env.nonce() });
        await tFor(r.tls).downloadToFile(`https://${r.endpoints[0]}${path}`, { ...headers, ...(have ? { range: `bytes=${have}-` } : {}) }, part, have, (n) => p.progress(id, Math.max(have, n))); // n: bytes on disk
      }
      await p.completeDownload(id, part);
      changed('transfers');
    } catch (e) {
      const m = (e as Error).message;
      if (/40[34]/.test(m)) p.failDownload(id, 'The sender no longer offers this file.');
      else if ((e as { code?: string }).code === 'corrupt') await env.files.remove(part).catch(() => {});
    } finally { inflight.delete(id); }
  }
  async function upload(id: string, key: string, src: string, size: number) {
    const r = p.route(key); if (!r?.tls || !r.endpoints[0]) return;
    inflight.add(id);
    const path = `/peer/file/${id}`;
    try {
      let have = 0;
      for (let guard = 0; have < size && guard < Math.ceil(size / CHUNK) + 4; guard++) {
        const c = await env.files.slice(src, have, Math.min(CHUNK, size - have));
        try {
          const headers = { ...peerAuthHeaders(o.signer, { method: 'PUT', path, body: c.bytes, to: key, nonce: env.nonce() }), 'content-type': 'application/octet-stream' };
          const res = await tFor(r.tls).uploadFromFile(`https://${r.endpoints[0]}${path}?offset=${have}`, headers, c.uri, 0, () => {});
          if (res.status !== 200) throw new PeerCallError(res.status, `Upload refused (${res.status}).`);
          have = (JSON.parse(res.body) as { have: number }).have;
          p.outgoingServed(id);
        } finally { await env.files.remove(c.uri).catch(() => {}); }
      }
      changed('transfers'); // the computer confirms with a signed receipt once the whole file verified
    } catch (e) { console.warn('[people] upload', (e as Error).message); }
    finally { inflight.delete(id); }
  }

  // ---- what computers send back: one authenticated socket each, while the app is open ----
  const open = new Map<string, WebSocketLike>(), retryAt = new Map<string, number>();
  function sockets() {
    for (const c of p.contacts('all')) {
      const r = p.route(c.key);
      if (!r?.tls || !r.endpoints[0] || open.has(c.key) || (retryAt.get(c.key) ?? 0) > now()) continue;
      if (!(c.relation !== 'none' || p.conversations().some((x) => x.peerKey === c.key && x.state !== 'declined'))) continue;
      const ws = tFor(r.tls).openWebSocket(`wss://${r.endpoints[0]}/peer/ws`);
      open.set(c.key, ws);
      ws.onopen = () => ws.send(JSON.stringify(peerSocketAuth(o.signer, c.key, env.nonce(), now())));
      ws.onmessage = (ev) => {
        let m: { t?: string; id?: string; envelope?: unknown };
        try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.t !== 'env') return;
        try { const res = p.receive(m.envelope, c.key); if (res.live) o.onLive?.(res.live); else changed(res.kind); }
        catch { /* refused or invalid: acknowledged so the computer stops resending it */ }
        ws.send(JSON.stringify({ t: 'ack', id: m.id }));
        void tick();
      };
      ws.onclose = () => { open.delete(c.key); retryAt.set(c.key, now() + 15_000); changed('presence'); };
      ws.onerror = () => {};
    }
  }

  const timer = setInterval(() => void tick(), o.tickMs ?? 4000);
  void tick();
  return {
    connectQr, tick,
    connected: (key: string) => open.get(key)?.readyState === 1,
    stop() { clearInterval(timer); for (const ws of open.values()) ws.close(); open.clear(); },
  };
}
export type PhonePeople = ReturnType<typeof startPhonePeople>;
