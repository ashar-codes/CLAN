// Peer-assisted acquisition (Milestone 2.75): fetch the chunks of a teacher-signed manifest from any mix of sources
// (teacher + peers), verify every chunk against the manifest before it is stored, and avoid unhealthy sources.
// Platform-neutral: storage, hashing and sources are injected. Security never depends on a source: only on hashes
// signed by the teacher.
import { bitfield, type ManifestPayload } from '@classroom/protocol';
import { sleep, TransferError } from './index.ts';

export type ChunkStore = {
  readonly chunkCount: number;
  isDone(i: number): boolean;
  /** Persist a VERIFIED chunk and mark it done. */
  write(i: number, bytes: Uint8Array): Promise<void>;
};

export type Source = {
  id: string;
  kind: 'teacher' | 'peer';
  /** Scheduling hint only; a source that lies is penalised, never trusted. */
  has(i: number): boolean;
  fetch(i: number, signal: AbortSignal): Promise<Uint8Array>;
};

export type SourceStat = {
  id: string; kind: Source['kind']; chunks: number; bytes: number; failures: number; corrupt: number; timeouts: number;
  inflight: number; consecutiveFailures: number; avoidUntil: number; totalMs: number;
};

export type AcquireResult = { sources: SourceStat[]; retries: number; corruptChunks: number; failedChunks: number };

export type AcquireOptions = {
  manifest: ManifestPayload;
  store: ChunkStore;
  /** Current candidate sources (called again when stuck or every `refreshMs`). Teacher should be included while online. */
  sources(): Source[] | Promise<Source[]>;
  /** SHA-256 hex of bytes (platform crypto). */
  sha256(bytes: Uint8Array): string | Promise<string>;
  /** Prefer peers over the teacher when a peer has the chunk (peer-assisted mode). */
  preferPeers: boolean;
  concurrency?: number;
  perPeerConcurrency?: number;
  /** Keep under the teacher server's per-student download cap (default 4). */
  teacherConcurrency?: number;
  /**
   * Flash-crowd control: chunks this device should take from the teacher straight away. For other chunks the teacher
   * is used only after `peerWaitMs` without a peer offering them (the teacher is always the eventual fallback).
   */
  ownChunk?(i: number): boolean;
  peerWaitMs?: number;
  chunkTimeoutMs?: number;
  /** Give up if no chunk completes for this long (never hang). */
  stallTimeoutMs?: number;
  refreshMs?: number;
  /** Where to start in the chunk order (spreads different students over different chunks early). */
  startOffset?: number;
  signal?: AbortSignal;
  onChunk?(i: number, source: Source, bytes: number): void;
};

/** Avoid a source for a while after repeated failures; much longer after it sent corrupt data. */
const FAILURE_AVOID_MS = 15_000;
const CORRUPT_AVOID_MS = 10 * 60_000;

export async function acquireChunks(o: AcquireOptions): Promise<AcquireResult> {
  const m = o.manifest;
  const n = m.chunks.length;
  const conc = o.concurrency ?? 6, perPeer = o.perPeerConcurrency ?? 2, perTeacher = o.teacherConcurrency ?? 3;
  const startedAt = Date.now(), peerWait = o.peerWaitMs ?? 2_000;
  const chunkTimeout = o.chunkTimeoutMs ?? 20_000, stallTimeout = o.stallTimeoutMs ?? 60_000, refreshMs = o.refreshMs ?? 2_000;
  const stats = new Map<string, SourceStat>();
  const stat = (s: Source) => {
    let st = stats.get(s.id);
    if (!st) stats.set(s.id, st = { id: s.id, kind: s.kind, chunks: 0, bytes: 0, failures: 0, corrupt: 0, timeouts: 0, inflight: 0, consecutiveFailures: 0, avoidUntil: 0, totalMs: 0 });
    return st;
  };
  const inflight = new Set<number>();
  /** `${sourceId}#${chunk}` a peer said it doesn't have (stale availability): skip that pair, keep using the peer. */
  const notHave = new Set<string>();
  const running = new Set<Promise<void>>();
  let retries = 0, corruptChunks = 0, failedChunks = 0;
  let sources: Source[] = [], refreshedAt = 0, lastProgress = Date.now();
  const start = ((o.startOffset ?? 0) % n + n) % n;
  const order = Array.from({ length: n }, (_, k) => (start + k) % n);
  const seed = o.startOffset ?? 0;
  const rankCache = new Map<string, number>();
  const rank = (id: string) => {
    let h = rankCache.get(id);
    if (h === undefined) { h = 2166136261 ^ seed; for (let k = 0; k < id.length; k++) h = Math.imul(h ^ id.charCodeAt(k), 16777619); rankCache.set(id, h >>> 0); }
    return h;
  };
  const expectedLen = (i: number) => (i === n - 1 ? m.size - m.chunkSize * (n - 1) : m.chunkSize);

  const refresh = async (force = false) => {
    if (!force && Date.now() - refreshedAt < refreshMs) return;
    sources = await o.sources();
    refreshedAt = Date.now();
  };

  /** Deterministic choice: healthy sources that have the chunk; peers before teacher when preferring peers; then least loaded, fewest failures, fastest. */
  const pick = (i: number): Source | null => {
    const now = Date.now();
    const healthy = (s: Source) => stat(s).avoidUntil <= now;
    // Teacher only for chunks no healthy peer can give us, and then only for my own slice until peers had a moment.
    const peerHasIt = o.preferPeers && sources.some((s) => s.kind === 'peer' && healthy(s) && s.has(i) && !notHave.has(`${s.id}#${i}`));
    const ok = sources.filter((s) => {
      const st = stat(s);
      if (s.kind === 'teacher' && (peerHasIt || (o.ownChunk && !o.ownChunk(i) && now - startedAt < peerWait))) return false;
      return healthy(s) && s.has(i) && !notHave.has(`${s.id}#${i}`) && st.inflight < (s.kind === 'peer' ? perPeer : perTeacher);
    });
    if (!ok.length) return null;
    const avgMs = (st: SourceStat) => (st.chunks ? st.totalMs / st.chunks : 0);
    ok.sort((a, b) => {
      if (o.preferPeers && a.kind !== b.kind) return a.kind === 'peer' ? -1 : 1;
      const sa = stat(a), sb = stat(b);
      // Final tie-break is per-requester (seeded by startOffset): if it were global, every student would pick the
      // same peer first and overload it.
      return sa.inflight - sb.inflight || sa.failures - sb.failures || avgMs(sa) - avgMs(sb) || rank(a.id) - rank(b.id);
    });
    return ok[0]!;
  };

  const run = async (i: number, s: Source) => {
    const st = stat(s);
    st.inflight++;
    inflight.add(i);
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    o.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(new TransferError('timeout', 'chunk timeout')), chunkTimeout);
    const t0 = Date.now();
    try {
      const bytes = await s.fetch(i, ctl.signal);
      if (bytes.length !== expectedLen(i) || (await o.sha256(bytes)) !== m.chunks[i]) {
        // Wrong bytes: never stored. Security is the hash; the source is just avoided.
        st.corrupt++; corruptChunks++; retries++;
        st.avoidUntil = Date.now() + CORRUPT_AVOID_MS;
        return;
      }
      await o.store.write(i, bytes);
      st.chunks++; st.bytes += bytes.length; st.totalMs += Date.now() - t0; st.consecutiveFailures = 0;
      lastProgress = Date.now();
      o.onChunk?.(i, s, bytes.length);
    } catch (e) {
      if (o.signal?.aborted) return;
      retries++;
      if ((e as TransferError).status === 429) { st.avoidUntil = Date.now() + 300; return; } // momentarily busy, not broken
      if ((e as TransferError).status === 404 && s.kind === 'peer') { notHave.add(`${s.id}#${i}`); st.failures++; failedChunks++; return; } // stale availability
      st.failures++; st.consecutiveFailures++; failedChunks++;
      if (ctl.signal.aborted) st.timeouts++;
      if (st.consecutiveFailures >= (s.kind === 'peer' ? 1 : 3)) st.avoidUntil = Date.now() + FAILURE_AVOID_MS;
      void e;
    } finally {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      st.inflight--;
      inflight.delete(i);
    }
  };

  await refresh(true);
  for (;;) {
    if (o.signal?.aborted) throw o.signal.reason ?? new TransferError('aborted', 'aborted');
    let remaining = 0;
    for (const i of order) if (!o.store.isDone(i)) remaining++;
    if (remaining === 0 && running.size === 0) break;
    await refresh();
    let started = 0;
    for (const i of order) {
      if (running.size >= conc) break;
      if (o.store.isDone(i) || inflight.has(i)) continue;
      const s = pick(i);
      if (!s) continue;
      const p = run(i, s).finally(() => running.delete(p));
      running.add(p);
      started++;
    }
    if (running.size === 0) {
      if (Date.now() - lastProgress > stallTimeout) throw new TransferError('stalled', 'No source could provide the remaining parts of this file.');
      await sleep(250, o.signal);
      await refresh(true);
      continue;
    }
    await Promise.race(running);
    void started;
  }
  return { sources: [...stats.values()], retries, corruptChunks, failedChunks };
}

/** Bitfield of done chunks (for announcing what a peer can serve). */
export function doneBitfield(store: ChunkStore): Uint8Array {
  const b = bitfield.empty(store.chunkCount);
  for (let i = 0; i < store.chunkCount; i++) if (store.isDone(i)) bitfield.set(b, i);
  return b;
}

// ---- peer request authentication (capability from the teacher + proof by the holder's device key) ----
import { b64u, canonicalBytes, ed25519Verify, keyFingerprint, verifySigned, type PeerCapability, type PeerEndorsement, type PeerRequestProof } from '@classroom/protocol';
import type { DeviceSigner } from './pairing.ts';
import { resourceContentPath, type Transport } from './index.ts';

const PROOF_SKEW_MS = 2 * 60_000;

/** `Authorization: Peer <b64url(JSON{capability, proof})>` — the proof names the serving peer, so it can't be replayed elsewhere. */
export async function peerAuthHeader(cap: PeerCapability, device: DeviceSigner, servingFingerprint: string, now = Date.now()): Promise<string> {
  const payload: PeerRequestProof = { type: 'classroom-lan/peer-request', v: 1, capId: cap.payload.capId, servingFingerprint, issuedAt: now };
  const proof = { payload, signature: await device.sign(canonicalBytes(payload)) };
  return 'Peer ' + b64u.encode(new TextEncoder().encode(JSON.stringify({ capability: cap, proof })));
}

export type PeerAuthResult = { ok: true; holderFingerprint: string; memberId: string; expiresAt: number } | { ok: false; status: 401 | 403; reason: string };

/** Peer-server side. Pure verification: teacher signature, session, expiry, holder proof, revocation. */
export function verifyPeerAuth(header: string | undefined, o: { sessionId: string; teacherKey: string; selfFingerprint: string; isDenied(fp: string): boolean; now?: number }): PeerAuthResult {
  const now = o.now ?? Date.now();
  if (!header || !header.startsWith('Peer ') || header.length > 16_384) return { ok: false, status: 401, reason: 'missing peer authorization' };
  let body: { capability: PeerCapability; proof: { payload: PeerRequestProof; signature: string } };
  try { body = JSON.parse(new TextDecoder().decode(b64u.decode(header.slice(5)))); } catch { return { ok: false, status: 401, reason: 'malformed' }; }
  const cap = verifySigned(body?.capability, 'classroom-lan/peer-capability', o.teacherKey, now);
  if (!cap.ok) return { ok: false, status: 401, reason: `capability ${cap.reason}` };
  const c = cap.payload;
  if (c.sessionId !== o.sessionId || c.scope !== 'resources:read') return { ok: false, status: 403, reason: 'capability is for another class' };
  if (keyFingerprint(c.holderPublicKey) !== c.holderFingerprint) return { ok: false, status: 401, reason: 'bad capability holder' };
  const p = body.proof?.payload;
  if (!p || p.type !== 'classroom-lan/peer-request' || p.v !== 1 || p.capId !== c.capId || p.servingFingerprint !== o.selfFingerprint) return { ok: false, status: 401, reason: 'proof not for this peer' };
  if (!(p.issuedAt >= c.issuedAt - PROOF_SKEW_MS && p.issuedAt <= now + PROOF_SKEW_MS)) return { ok: false, status: 401, reason: 'stale proof' };
  if (!ed25519Verify(c.holderPublicKey, p, body.proof.signature)) return { ok: false, status: 401, reason: 'bad proof signature' };
  if (o.isDenied(c.holderFingerprint)) return { ok: false, status: 403, reason: 'revoked' };
  return { ok: true, holderFingerprint: c.holderFingerprint, memberId: c.memberId, expiresAt: c.expiresAt };
}

// ---- sources ----

/** The teacher: has everything while online; chunk = HTTP Range on the normal content endpoint. */
export function teacherSource(t: Transport, url: string, token: string, m: ManifestPayload): Source {
  return {
    id: 'teacher', kind: 'teacher', has: () => true,
    async fetch(i, signal) {
      const start = i * m.chunkSize, end = Math.min(m.size, start + m.chunkSize) - 1;
      const res = await t.fetch(url + resourceContentPath(m.resourceId), { headers: { authorization: `Bearer ${token}`, range: `bytes=${start}-${end}`, 'if-range': `"${m.sha256}"` }, signal });
      if (res.status !== 206 && !(res.status === 200 && start === 0 && end === m.size - 1)) { await res.body?.cancel(); throw new TransferError('http_' + res.status, `teacher ${res.status}`, res.status); }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

export type PeerInfo = { fingerprint: string; url: string; endorsement: PeerEndorsement; have: string };

/**
 * A peer, after checking its teacher-signed endorsement (session, expiry, fingerprint). The transport must pin the
 * endorsed TLS identity, so a different device (or an impostor at that address) can't answer.
 */
export function peerSource(o: { info: PeerInfo; teacherKey: string; sessionId: string; transportFor(e: PeerEndorsement): Transport; auth(servingFp: string): Promise<string>; m: ManifestPayload }): (Source & { setHave(b64: string): void }) | null {
  const e = verifySigned(o.info.endorsement, 'classroom-lan/peer-endorsement', o.teacherKey);
  if (!e.ok || e.payload.sessionId !== o.sessionId || e.payload.deviceKeyFingerprint !== o.info.fingerprint || keyFingerprint(e.payload.devicePublicKey) !== e.payload.deviceKeyFingerprint) return null;
  if (!/^https:\/\/[\w.:[\]-]+$/.test(o.info.url)) return null;
  let have: Uint8Array;
  try { have = b64u.decode(o.info.have); } catch { return null; }
  const t = o.transportFor(o.info.endorsement);
  return {
    id: `peer:${o.info.fingerprint}`, kind: 'peer', has: (i) => bitfield.has(have, i),
    /** Availability changes often; the source (and its TLS connections) must not be recreated for that. */
    setHave(b64: string) { try { have = b64u.decode(b64); } catch { /* keep previous */ } },
    async fetch(i, signal) {
      const res = await t.fetch(`${o.info.url}/peer/v1/chunk/${o.m.resourceId}/${i}`, { headers: { authorization: await o.auth(o.info.fingerprint) }, signal });
      if (res.status !== 200) { await res.body?.cancel(); throw new TransferError('http_' + res.status, `peer ${res.status}`, res.status); }
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

/**
 * EXPERIMENTAL distribution recommendation for the teacher UI. Heuristic only (not a guarantee): based on class size,
 * typical resource size and measured teacher throughput when available. Peer assistance moves load off the teacher's
 * machine/uplink; on a single Wi-Fi access point it does not add channel airtime (see docs/PEER_ASSISTED_MODE.md).
 */
export function recommendDistribution(o: { students: number; largestResourceBytes: number; teacherBytesPerSec?: number }): { peerAssist: boolean; reason: string } {
  const big = o.largestResourceBytes > 4 * 1024 * 1024;
  if (o.students < 8) return { peerAssist: false, reason: 'Small class: the teacher computer can serve everyone directly.' };
  if (!big) return { peerAssist: false, reason: 'Files are small: direct downloads finish before sharing would help.' };
  const est = o.teacherBytesPerSec ? (o.students * o.largestResourceBytes) / o.teacherBytesPerSec : null;
  return { peerAssist: true, reason: `Large class and large files${est ? ` (≈${Math.round(est)} s from the teacher alone at the current rate)` : ''}: Peer Assistance can take load off the teacher computer.` };
}
