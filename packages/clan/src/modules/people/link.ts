// Person-to-person sessions over clan-link/1, independent of what carries the bytes (LAN or hotspot TCP, Wi-Fi Direct,
// Wi-Fi Aware, Apple peer-to-peer). The same People rules and storage apply as on the HTTPS path: envelopes are signed
// end to end and applied by People.receive with the link-authenticated key; a message counts as delivered only when
// the other device's authenticated reply says it was applied; files move only after consent and are verified.
import { b64u, ephemeralSigner, linkInitiate, linkRespond, type ByteLink, type LinkSigner, type PeerEnvelope, type SecureLink } from '@classroom/protocol';
import { orderLanRoutes, type RouteNetwork } from '@classroom/protocol';
import type { People } from './index.ts';

/** File access the session needs (Node fs on computers, expo-file-system on phones). */
export type LinkFiles = {
  read(path: string, offset: number, length: number): Promise<Uint8Array>;
  append(path: string, bytes: Uint8Array): Promise<void>;
  size(path: string): Promise<number>;
  remove(path: string): Promise<void>;
  /** Where an incoming transfer is assembled before verification. */
  partPath(transferId: string): string;
};
/** One way of reaching people: dial an address it understands, accept what arrives. */
export type LinkTransport = {
  name: string;
  handles(address: string): boolean;
  dial(address: string): Promise<ByteLink>;
};
export type LinkState = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'failed';

const RANGE = 256 * 1024, CHUNK = 64 * 1024, REPLY_MS = 20_000, PING_MS = 15_000, DEAD_MS = 45_000;
const te = new TextEncoder(), td = new TextDecoder();
type Msg = Record<string, unknown> & { t: string };

/** One authenticated session with one person. */
export class LinkSession {
  readonly peerKey: string;
  readonly link: SecureLink;
  readonly startedAt: number;
  private readonly p: People;
  private readonly files: LinkFiles;
  private readonly hooks: { onLive?(e: PeerEnvelope): void; onChange?(what: string): void; myAddrs(): string[] };
  private seq = 0;
  private readonly waits = new Map<string, { res(m: Msg): void; rej(e: Error): void; t: ReturnType<typeof setTimeout> }>();
  /** Transfers being written right now, shared by every session: one writer per part file, even across reconnects. */
  private readonly downloads: Set<string>;
  private lastHeard = Date.now();
  private readonly pinger: ReturnType<typeof setInterval>;
  private flushing: Promise<void> | null = null;

  private readonly invite: string | null;
  constructor(p: People, link: SecureLink, files: LinkFiles, hooks: LinkSession['hooks'], invite: string | null = null, inflight = new Set<string>()) {
    this.invite = invite; this.downloads = inflight;
    this.p = p; this.link = link; this.files = files; this.hooks = hooks; this.peerKey = link.peerKey; this.startedAt = Date.now();
    link.onMessage((m) => { this.lastHeard = Date.now(); void this.handle(m).catch(() => link.close('Peer request failed.')); });
    link.onClose(() => { clearInterval(this.pinger); for (const w of this.waits.values()) { clearTimeout(w.t); w.rej(new Error('The connection closed.')); } this.waits.clear(); });
    this.pinger = setInterval(() => { if (Date.now() - this.lastHeard > DEAD_MS) link.close('No answer.'); else this.post({ t: 'ping' }); }, PING_MS);
    (this.pinger as { unref?(): void }).unref?.();
    this.introduce();
  }
  private lastHi = '';
  /** What this person may see of us (it changes when they become a requester or friend) and where we listen. */
  private introduce() {
    const hi = { t: 'hi', profile: this.p.profileFor(this.peerKey, this.invite).profile, addrs: this.hooks.myAddrs() }, j = JSON.stringify(hi);
    if (j !== this.lastHi) { this.lastHi = j; this.post(hi); }
  }
  get open() { return !this.link.closed; }
  private post(m: Msg) { if (!this.link.closed) this.link.send(te.encode(JSON.stringify(m))); }
  private ask(m: Msg): Promise<Msg> {
    const id = `${++this.seq}`;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waits.delete(id); rej(new Error('No reply.')); }, REPLY_MS);
      this.waits.set(id, { res, rej, t });
      try { this.post({ ...m, id }); } catch (e) { clearTimeout(t); this.waits.delete(id); rej(e as Error); }
    });
  }

  /** Send everything queued for this person; delivered only on their authenticated per-envelope result. */
  flush(): Promise<void> {
    return this.flushing ??= (async () => {
      await null; // never settle synchronously: `finally` must run after `??=` stored this promise
      try {
        this.introduce();
        for (let round = 0; round < 20 && this.open; round++) {
          const due = this.p.due(Number.MAX_SAFE_INTEGER, 1000).filter((d) => d.to === this.peerKey).slice(0, 50);
          if (!due.length) break;
          for (const d of due) this.p.sending(d.id);
          const r = await this.ask({ t: 'env', envelopes: due.map((d) => d.envelope) });
          const results = Array.isArray(r.results) ? r.results as { ok?: boolean; error?: string; final?: boolean }[] : [];
          due.forEach((d, i) => { const x = results[i]; if (x?.ok) this.p.delivered(d.id); else this.p.deliveryFailed(d.id, x?.error ?? 'refused', x?.final ?? true); });
          this.hooks.onChange?.('delivered');
        }
        for (const t of this.p.pendingDownloads()) if (t.peerKey === this.peerKey && !this.downloads.has(t.id)) void this.download(t.id, t.size);
      } catch { /* a closed or silent link: the outbox keeps everything for the next path */ }
      finally { this.flushing = null; }
    })();
  }
  /** Call signaling: now or never. */
  async sendLive(env: PeerEnvelope) {
    const r = await this.ask({ t: 'env', envelopes: [env] });
    const x = (r.results as { ok?: boolean; error?: string }[] | undefined)?.[0];
    if (!x?.ok) throw new Error(x?.error ?? 'The other person did not accept the call.');
    return true;
  }

  /** Their picture, if their profile shows one we have not cached (verified against the signed profile). */
  private async fetchAvatar() {
    if (!this.p.wantedAvatar(this.peerKey)) return;
    try {
      const r = await this.ask({ t: 'avatar' });
      const c = Array.isArray(r.chunks) ? r.chunks[0] : null;
      if (r.t === 'data' && typeof c === 'string' && typeof r.mime === 'string') this.p.storeAvatar(this.peerKey, r.mime, b64u.decode(c));
    } catch { /* no picture this time */ }
  }
  private async download(id: string, size: number) {
    this.downloads.add(id);
    const part = this.files.partPath(id);
    try {
      let have = await this.files.size(part).catch(() => 0);
      if (have > size) { await this.files.remove(part); have = 0; }
      while (have < size && this.open) {
        const length = Math.min(RANGE, size - have);
        const r = await this.ask({ t: 'get', transferId: id, offset: have, length });
        if (r.t === 'err') { if (r.code === 'not_found') this.p.failDownload(id, 'The sender no longer offers this file.'); return; }
        if (r.t !== 'data' || r.offset !== have || !Array.isArray(r.chunks) || !r.chunks.length || r.chunks.length > RANGE / CHUNK) throw new Error('Unexpected file data.');
        const chunks: Uint8Array[] = [];
        let got = 0;
        if (!this.open) break; // never write a reply that arrived on a link already given up
        // Validate the whole reply before touching the resumable part file. An authenticated sender can still lie.
        for (const c of r.chunks) {
          if (typeof c !== 'string' || c.length > Math.ceil(CHUNK * 4 / 3) || !/^[A-Za-z0-9_-]+$/.test(c)) throw new Error('Unexpected file data.');
          const b = b64u.decode(c); got += b.length;
          if (!b.length || b.length > CHUNK || got > length) throw new Error('Unexpected file data.');
          chunks.push(b);
        }
        for (const b of chunks) await this.files.append(part, b);
        have += got;
        this.p.progress(id, have);
        this.hooks.onChange?.('transfers');
      }
      if (have === size) {
        try { await this.p.completeDownload(id, part); } catch { await this.files.remove(part).catch(() => {}); }
        this.hooks.onChange?.('transfers');
        void this.flush(); // the signed receipt goes back on this link
      }
    } catch { /* resumes from the part file on the next session */ }
    finally { this.downloads.delete(id); }
  }

  private async handle(raw: Uint8Array) {
    let m: Msg;
    try { m = JSON.parse(td.decode(raw)) as Msg; if (!m || typeof m.t !== 'string') return; } catch { return; }
    const id = typeof m.id === 'string' ? m.id.slice(0, 20) : '';
    if (m.t === 'res' || m.t === 'data' || m.t === 'err') { const w = this.waits.get(id); if (w) { clearTimeout(w.t); this.waits.delete(id); w.res(m); } return; }
    if (m.t === 'ping') return this.post({ t: 'pong' });
    if (m.t === 'pong') return;
    if (m.t === 'hi') {
      const prof = m.profile as { profile?: { key?: string } } | null;
      try { if (prof?.profile?.key === this.peerKey) this.p.meet({ profile: prof }); } catch { /* invalid profile: ignored, envelopes still verify */ }
      if (Array.isArray(m.addrs)) { try { this.p.setLinkAddrs(this.peerKey, (m.addrs as unknown[]).filter((a): a is string => typeof a === 'string').slice(0, 6)); } catch { /* malformed: ignored */ } }
      this.hooks.onChange?.('contacts');
      void this.flush();
      void this.fetchAvatar();
      return;
    }
    if (m.t === 'avatar') {
      const a = await this.p.avatarFor(this.peerKey, this.invite).catch(() => null);
      if (!a) return this.post({ t: 'err', id, code: 'not_found' });
      return this.post({ t: 'data', id, mime: a.mime, chunks: [b64u.encode(a.data)] });
    }
    if (m.t === 'env') {
      const envs = Array.isArray(m.envelopes) ? (m.envelopes as unknown[]).slice(0, 100) : [];
      const results = envs.map((e) => {
        try {
          const r = this.p.receive(e, this.peerKey);
          if (r.live) this.hooks.onLive?.(r.live); else this.hooks.onChange?.(r.kind);
          return { ok: true };
        } catch (err) { const code = (err as { code?: string }).code ?? 'refused'; return { ok: false, error: code, final: code !== 'rate_limited' }; }
      });
      this.post({ t: 'res', id, results });
      void this.flush();
      return;
    }
    if (m.t === 'get') {
      const tid = typeof m.transferId === 'string' ? m.transferId : '', offset = Number(m.offset), length = Math.min(Number(m.length), RANGE);
      const f = this.p.outgoingBytes(tid, this.peerKey); // only the accepted transfer, only to this conversation's peer
      if (!f || !Number.isInteger(offset) || offset < 0 || offset >= f.size || !Number.isInteger(length) || length <= 0) return this.post({ t: 'err', id, code: 'not_found' });
      this.p.outgoingServed(tid);
      const chunks: string[] = [];
      for (let o = offset; o < Math.min(f.size, offset + length); o += CHUNK) chunks.push(b64u.encode(await this.files.read(f.path, o, Math.min(CHUNK, f.size - o, offset + length - o))));
      return this.post({ t: 'data', id, offset, chunks });
    }
  }
}

/**
 * Keeps at most one session per person across every transport, dials whatever address is known, accepts incoming
 * links under the People visibility rules, reconnects with backoff while there is something to send, and reports an
 * honest state per person.
 */
export class ConnectionManager {
  private readonly p: People;
  private readonly signer: LinkSigner;
  private readonly files: LinkFiles;
  private readonly transports: LinkTransport[] = [];
  private readonly sessions = new Map<string, LinkSession>();
  private readonly state = new Map<string, { s: LinkState; error?: string; retryAt: number; tries: number }>();
  private readonly dialing = new Set<string>();
  private readonly inflight = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly hooks: { onLive?(e: PeerEnvelope): void; onChange?(what: string): void; myAddrs(): string[] };
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private readonly working = new Map<string, string>();
  private readonly connects = new Map<string, Promise<LinkSession>>();
  private readonly networks: () => RouteNetwork[];
  private readonly maintainFriends: () => boolean;

  constructor(o: { people: People; signer: LinkSigner; files: LinkFiles; onLive?(e: PeerEnvelope): void; onChange?(what: string): void; myAddrs?(): string[]; tickMs?: number; networks?(): RouteNetwork[]; maintainFriends?(): boolean }) {
    this.p = o.people; this.signer = o.signer; this.files = o.files; this.networks = o.networks ?? (() => []); this.maintainFriends = o.maintainFriends ?? (() => false);
    this.hooks = { onLive: o.onLive, onChange: (w) => { o.onChange?.(w); }, myAddrs: o.myAddrs ?? (() => []) };
    this.timer = setInterval(() => void this.tick(), o.tickMs ?? 3000);
    (this.timer as { unref?(): void }).unref?.();
  }
  use(t: LinkTransport) { this.transports.push(t); return this; }
  onState(cb: () => void) { this.listeners.add(cb); return () => this.listeners.delete(cb); }
  private set(key: string, s: LinkState, error?: string) {
    const cur = this.state.get(key) ?? { s, retryAt: 0, tries: 0 };
    this.state.set(key, { ...cur, s, error });
    for (const l of this.listeners) l();
    this.hooks.onChange?.('presence');
  }
  status(key: string): { state: LinkState; error?: string } | null { const s = this.state.get(key); return s ? { state: s.s, error: s.error } : null; }
  connected(key: string) { return !!this.sessions.get(key)?.open; }
  session(key: string) { const s = this.sessions.get(key); return s?.open ? s : null; }

  /** A link someone opened to us: authenticate, apply visibility rules before revealing ourselves, then keep it. */
  async accept(link: ByteLink) {
    if (this.stopped) { link.close(); return null; }
    try {
      let invite: string | null = null;
      const sl = await linkRespond(link, { signer: this.signer, accept: (k, inv) => { invite = inv; return this.p.reachableBy(k, inv) || 'Not accepting this connection.'; } });
      if (this.stopped || this.p.isBlocked(sl.peerKey)) { sl.close('stopped or blocked'); return null; }
      return this.adopt(sl, invite);
    } catch { return null; }
  }
  /** Dial an address. `expectKey` when we know who should answer; `invite` from their code. */
  connect(address: string, o: { expectKey?: string; invite?: string } = {}): Promise<LinkSession> {
    if (this.stopped || o.expectKey && this.p.isBlocked(o.expectKey)) return Promise.reject(new Error('Connection is stopped or this person is blocked.'));
    const id = `${o.expectKey ?? ''}|${address}|${o.invite ?? ''}`;
    const current = this.connects.get(id); if (current) return current;
    const next = this.dial(address, o).finally(() => this.connects.delete(id)); this.connects.set(id, next); return next;
  }
  private async dial(address: string, o: { expectKey?: string; invite?: string }) {
    const t = this.transports.find((x) => x.handles(address));
    if (!t) throw new Error('No way to reach that address from this device.');
    if (o.expectKey && !this.session(o.expectKey)) this.set(o.expectKey, this.state.get(o.expectKey)?.s === 'reconnecting' ? 'reconnecting' : 'connecting');
    try {
      const sl = await linkInitiate(await t.dial(address), { signer: this.signer, expectKey: o.expectKey, invite: o.invite });
      if (this.stopped || this.p.isBlocked(sl.peerKey)) { sl.close('stopped or blocked'); throw new Error('Connection stopped or person blocked.'); }
      const s = this.adopt(sl); if (s.link === sl) this.working.set(sl.peerKey, address);
      if (address.startsWith('tcp:')) { const known = this.p.linkAddrs(sl.peerKey); if (!known.includes(address)) { try { this.p.setLinkAddrs(sl.peerKey, [address, ...known].slice(0, 6)); } catch { /* not a storable address */ } } }
      return s;
    } catch (e) {
      if (!this.stopped && o.expectKey && !this.session(o.expectKey)) this.set(o.expectKey, 'failed', (e as Error).message);
      throw e;
    }
  }
  /** One session per person. If both sides dialled at once, both keep the one opened by the lower key. */
  private adopt(sl: SecureLink, invite: string | null = null) {
    const key = sl.peerKey, cur = this.sessions.get(key);
    if (cur?.open) {
      const initiator = (s: SecureLink) => s.role === 'initiator' ? this.signer.publicKey : s.peerKey;
      const keepNew = initiator(sl) < initiator(cur.link);
      if (!keepNew) { sl.close('duplicate'); return cur; }
    }
    const s = new LinkSession(this.p, sl, this.files, this.hooks, invite, this.inflight);
    this.sessions.set(key, s);
    if (cur?.open) cur.link.close('replaced');
    this.state.set(key, { s: 'connected', retryAt: 0, tries: 0 });
    for (const l of this.listeners) l();
    this.hooks.onChange?.('presence');
    sl.onClose(() => {
      if (this.stopped || this.sessions.get(key) !== s) return;
      this.sessions.delete(key);
      this.set(key, this.wanted(key) ? 'reconnecting' : 'offline');
      void this.tick();
    });
    return s;
  }
  private wanted(key: string) {
    return this.p.due(Number.MAX_SAFE_INTEGER, 1000).some((d) => d.to === key) || this.p.pendingDownloads().some((t) => t.peerKey === key);
  }
  async sendLive(env: PeerEnvelope) { const s = this.session(env.to); if (!s) return false; return s.sendLive(env); }

  /** Deliver over open sessions; redial (with backoff) people we have something for and an address to try. */
  async tick() {
    if (this.stopped) return;
    const now = Date.now();
    for (const [key, s] of this.sessions) if (s.open) { if (this.p.isBlocked(key)) s.link.close('blocked'); else void s.flush(); }
    const availableFriends = this.maintainFriends() && this.p.visibility() !== 'invisible' ? this.p.contacts('friends').slice(0, 100).map(c => c.key) : [];
    const keys = new Set([...this.p.due(Number.MAX_SAFE_INTEGER, 1000).map((d) => d.to), ...this.p.pendingDownloads().map((t) => t.peerKey), ...availableFriends]);
    for (const key of keys) {
      if (this.dialing.size >= 4) break; // bound native sockets, prioritize queued work before idle friends
      if (this.session(key) || this.dialing.has(key) || this.p.isBlocked(key)) continue;
      const addrs = orderLanRoutes(this.p.linkAddrs(key).filter((a) => this.transports.some((t) => t.handles(a))), this.networks(), this.working.get(key));
      if (!addrs.length) continue;
      const st = this.state.get(key) ?? { s: 'offline' as LinkState, retryAt: 0, tries: 0 };
      if (st.retryAt > now) continue;
      this.dialing.add(key);
      void (async () => {
        let ok = false;
        for (const a of addrs) { if (this.stopped || this.p.isBlocked(key)) break; try { await this.connect(a, { expectKey: key }); ok = true; break; } catch { /* next address */ } }
        if (this.stopped) return;
        const tries = ok ? 0 : st.tries + 1, live = !!this.session(key);
        this.state.set(key, { ...(this.state.get(key) ?? st), s: live ? 'connected' : 'offline', retryAt: live ? 0 : Date.now() + Math.min(60_000, 2000 * 2 ** Math.min(tries, 5)), tries: live ? 0 : tries });
        for (const l of this.listeners) l();
      })().finally(() => this.dialing.delete(key));
    }
  }
  networkChanged() { if (this.stopped) return; this.working.clear(); for (const [key, value] of this.state) { this.state.set(key, { ...value, retryAt: 0 }); this.p.wake(key); } void this.tick(); }
  stop() { this.stopped = true; if (this.timer) clearInterval(this.timer); for (const s of this.sessions.values()) s.link.close('stopped'); this.sessions.clear(); for (const key of this.state.keys()) this.set(key, 'offline'); }
}

/**
 * Look at whoever answers on `link` under a throwaway identity: only people visible to Everyone Nearby answer, and
 * they learn nothing about who looked. Returns their verified key and the public profile they chose to show.
 */
export async function probeAnonymously(link: ByteLink, timeoutMs = 5000): Promise<{ key: string; profile: unknown }> {
  const sl = await linkInitiate(link, { signer: ephemeralSigner(), timeoutMs });
  try {
    const hi = await new Promise<Record<string, unknown>>((res, rej) => {
      const t = setTimeout(() => rej(new Error('No profile.')), timeoutMs);
      sl.onMessage((m) => { try { const x = JSON.parse(td.decode(m)) as Record<string, unknown>; if (x.t === 'hi') { clearTimeout(t); res(x); } } catch { /* ignore */ } });
      sl.onClose(() => { clearTimeout(t); rej(new Error('Closed.')); });
    });
    return { key: sl.peerKey, profile: hi.profile };
  } finally { sl.close('probe done'); }
}
