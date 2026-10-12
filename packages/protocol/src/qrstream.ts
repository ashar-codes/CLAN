// clan-qrx/1 — files carried by a sequence of QR codes on a screen and a camera, with no network of any kind.
//
// Frames (QR text `CLQ1<base64url>`): every frame names the transfer (8 random bytes) and ends with a CRC-32, so a
// misread or foreign frame is dropped. A META frame (repeated every few frames) describes the transfer; DATA frames
// carry a systematic LT fountain code over the blob: the first K frames are the K source blocks, every later frame XORs
// a pseudo-random set of blocks chosen by its index (robust soliton degrees, capped). A receiver can start at any
// frame, miss any frames and see them in any order; it needs a little more than K distinct frames, then checks the
// blob's exact length and SHA-256, and the file's own SHA-256 again after decryption.
//
// Privacy: QR frames are public — anyone with a camera can record them. `public` mode says so. `private` mode encrypts
// to a receiver that first showed its one-time receive code (X25519): file and name are XChaCha20-Poly1305 encrypted
// under HKDF(X25519(sender eph, receiver eph)). Optionally the sender signs the description with its CLAN identity.
// Receipt: the receiver can show a signed receipt QR (`clan://qrx/ack…`) that the sender scans; nothing else proves
// delivery on a one-way channel.
import { x25519 } from '@noble/curves/ed25519.js';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, randomBytes } from '@noble/hashes/utils.js';
import { b64u } from './trust.ts';
import { verifyStatement } from './people.ts';

export const QRX_PREFIX = 'CLQ1';
export const QRX_MAX_BYTES = 2 * 1024 * 1024; // optical transfer is for notes, documents and small images
export const QRX_RECOMMENDED_BYTES = 256 * 1024;
export const QRX_BLOCK_SIZES = [200, 400, 600, 900] as const; // bytes per frame: denser = faster but needs a sharper camera
const MAX_K = 20_000, MAX_DEGREE = 40, META_EVERY = 8, VERSION = 1;
const te = new TextEncoder(), td = new TextDecoder();

// ---- CRC-32 (IEEE) ----
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
export const crc32 = (b: Uint8Array) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]!) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// ---- deterministic choice of blocks for frame index i ----
function rng(seed: number) { let s = seed >>> 0 || 0x9e3779b9; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
/** Robust soliton CDF (c = 0.1, δ = 0.5), truncated at MAX_DEGREE. */
function solitonCdf(k: number) {
  const c = 0.1, delta = 0.5, R = c * Math.log(k / delta) * Math.sqrt(k), maxD = Math.min(k, MAX_DEGREE);
  const rho = (d: number) => (d === 1 ? 1 / k : 1 / (d * (d - 1)));
  const pivot = Math.max(1, Math.min(k, Math.floor(k / R)));
  const tau = (d: number) => (d < pivot ? R / (d * k) : d === pivot ? (R * Math.log(R / delta)) / k : 0);
  const w = Array.from({ length: maxD }, (_, i) => Math.max(0, rho(i + 1) + tau(i + 1)));
  const sum = w.reduce((a, b) => a + b, 0);
  let acc = 0;
  return w.map((x) => (acc += x / sum));
}
const cdfCache = new Map<number, number[]>();
/** Which source blocks frame `index` combines (systematic: index < k is just block `index`). */
export function blocksFor(index: number, k: number, salt: number): number[] {
  if (index < k) return [index];
  const cdf = cdfCache.get(k) ?? (cdfCache.set(k, solitonCdf(k)), cdfCache.get(k)!);
  const r = rng((index * 2654435761) ^ salt), u = r();
  let d = cdf.findIndex((x) => u <= x) + 1; if (d <= 0) d = 1;
  const set = new Set<number>();
  while (set.size < d) set.add(Math.floor(r() * k));
  return [...set];
}

// ---- frame codec ----
export type QrxMeta = {
  v: 1; id: string; k: number; bs: number; len: number; sha: string; // blob: block count, block size, length, SHA-256 hex
  mode: 'public' | 'private';
  info?: { name: string; mime: string; size: number; sha256: string }; // public mode
  sealed?: string; epk?: string; n1?: string; n2?: string; to?: string; // private mode (to = receive-code fingerprint)
  from?: { key: string; sig: string }; // optional CLAN identity of the sender
};
type Frame = { kind: 'meta'; id: string; meta: QrxMeta } | { kind: 'data'; id: string; index: number; k: number; bs: number; len: number; payload: Uint8Array };
function validInfo(value: unknown): value is NonNullable<QrxMeta['info']> {
  if (!value || typeof value !== 'object') return false;
  const i = value as Record<string, unknown>;
  return typeof i.name === 'string' && i.name.length > 0 && i.name.length <= 120 && !/[\u0000-\u001f\u007f/\\]/.test(i.name)
    && typeof i.mime === 'string' && i.mime.length <= 100 && Number.isInteger(i.size) && (i.size as number) >= 0 && (i.size as number) <= QRX_MAX_BYTES
    && typeof i.sha256 === 'string' && /^[0-9a-f]{64}$/.test(i.sha256);
}

const idHex = (b: Uint8Array) => bytesToHex(b);
function pack(type: number, id: Uint8Array, body: Uint8Array) {
  const out = new Uint8Array(10 + body.length + 4);
  out[0] = VERSION; out[1] = type; out.set(id, 2); out.set(body, 10);
  new DataView(out.buffer).setUint32(out.length - 4, crc32(out.subarray(0, out.length - 4)));
  return QRX_PREFIX + b64u.encode(out);
}
/** Parse one scanned QR text; null for anything that is not an intact clan-qrx/1 frame. */
export function parseFrame(text: string): Frame | null {
  if (typeof text !== 'string' || !text.startsWith(QRX_PREFIX) || text.length > 4000) return null;
  let b: Uint8Array;
  try { b = b64u.decode(text.slice(QRX_PREFIX.length)); } catch { return null; }
  if (b.length < 15 || b[0] !== VERSION) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  if (dv.getUint32(b.length - 4) !== crc32(b.subarray(0, b.length - 4))) return null;
  const id = idHex(b.subarray(2, 10)), body = b.subarray(10, b.length - 4);
  if (b[1] === 0) {
    try {
      const m = JSON.parse(td.decode(body)) as QrxMeta;
      if (m.v !== 1 || m.id !== id || !Number.isInteger(m.k) || !Number.isInteger(m.bs) || !Number.isInteger(m.len) || !/^[0-9a-f]{64}$/.test(m.sha)) return null;
      if (m.k < 1 || m.k > MAX_K || m.bs < 16 || m.bs > 2048 || m.len < 0 || m.len > QRX_MAX_BYTES + 64 || m.k * m.bs < m.len || (m.k - 1) * m.bs >= Math.max(m.len, 1)) return null;
      if (m.mode !== 'public' && m.mode !== 'private') return null;
      if (m.mode === 'public' && (!validInfo(m.info) || m.info.size !== m.len || m.info.sha256 !== m.sha)) return null;
      return { kind: 'meta', id, meta: m };
    } catch { return null; }
  }
  if (b[1] === 1 && body.length >= 14) {
    const bdv = new DataView(body.buffer, body.byteOffset, body.length);
    const index = bdv.getUint32(0), k = bdv.getUint32(4), bs = bdv.getUint16(8), len = bdv.getUint32(10) >>> 0;
    const payload = body.subarray(14);
    if (payload.length !== bs || k < 1 || k > MAX_K) return null;
    return { kind: 'data', id, index, k, bs, len, payload };
  }
  return null;
}

const saltOf = (id: string) => parseInt(id.slice(0, 8), 16) >>> 0;

/** Receive code: what the receiver shows first for a private transfer (one-time X25519 key). */
export function receiveCode(name = '') {
  const kp = x25519.keygen();
  const pub = b64u.encode(kp.publicKey);
  return { text: `clan://qrx/key?k=${pub}${name ? `&n=${encodeURIComponent(name.slice(0, 40))}` : ''}`, secretKey: kp.secretKey, publicKey: pub, fingerprint: b64u.encode(sha256(kp.publicKey).slice(0, 6)) };
}
export function parseReceiveCode(text: string): { publicKey: string; name: string; fingerprint: string } | null {
  const m = /^clan:\/\/qrx\/key\?(.*)$/.exec(text.trim()); if (!m) return null;
  const q = new URLSearchParams(m[1]), k = q.get('k') ?? '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(k)) return null;
  return { publicKey: k, name: (q.get('n') ?? '').slice(0, 40), fingerprint: b64u.encode(sha256(b64u.decode(k)).slice(0, 6)) };
}
const keyFor = (shared: Uint8Array, id: string) => hkdf(sha256, shared, te.encode(id), te.encode('clan-qrx/1 key'), 32);
const signedPart = (m: QrxMeta) => te.encode(`clan-qrx/1|${m.id}|${m.mode}|${m.k}|${m.bs}|${m.len}|${m.sha}|${m.sealed ?? JSON.stringify(m.info)}|${m.epk ?? ''}`);

/**
 * Sender: prepare frames for `file`. `to` (a scanned receive code) makes it private; `signer` adds the sender's
 * verified CLAN identity. Returns a frame generator: frame(i) for i = 0, 1, 2, … (meta frames interleaved).
 */
export function encodeTransfer(file: { bytes: Uint8Array; name: string; mime: string }, o: { blockSize?: number; to?: { publicKey: string; fingerprint: string }; signer?: { publicKey: string; sign(b: Uint8Array): string } } = {}) {
  if (file.bytes.length > QRX_MAX_BYTES) throw new Error(`Optical transfer is limited to ${QRX_MAX_BYTES / 1024 / 1024} MB. Share larger files over a direct connection.`);
  const bs = o.blockSize ?? 600;
  if (bs < 16 || bs > 2048) throw new Error('Bad frame size.');
  const idBytes = randomBytes(8), id = idHex(idBytes);
  const info = { name: file.name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').slice(0, 120) || 'file', mime: file.mime.slice(0, 100), size: file.bytes.length, sha256: bytesToHex(sha256(file.bytes)) };
  let blob = file.bytes, meta: QrxMeta;
  if (o.to) {
    const e = x25519.keygen(), k = keyFor(x25519.getSharedSecret(e.secretKey, b64u.decode(o.to.publicKey)), id);
    const n1 = randomBytes(24), n2 = randomBytes(24);
    const sealed = xchacha20poly1305(k, n1, idBytes).encrypt(te.encode(JSON.stringify(info)));
    blob = xchacha20poly1305(k, n2, idBytes).encrypt(file.bytes);
    meta = { v: 1, id, k: Math.max(1, Math.ceil(blob.length / bs)), bs, len: blob.length, sha: bytesToHex(sha256(blob)), mode: 'private', sealed: b64u.encode(sealed), epk: b64u.encode(e.publicKey), n1: b64u.encode(n1), n2: b64u.encode(n2), to: o.to.fingerprint };
  } else meta = { v: 1, id, k: Math.max(1, Math.ceil(blob.length / bs)), bs, len: blob.length, sha: bytesToHex(sha256(blob)), mode: 'public', info };
  if (o.signer) meta.from = { key: o.signer.publicKey, sig: o.signer.sign(signedPart(meta)) };
  const metaFrame = pack(0, idBytes, te.encode(JSON.stringify(meta)));
  if (metaFrame.length > 2900) throw new Error('Description too long for one QR frame.');
  const padded = new Uint8Array(meta.k * bs); padded.set(blob);
  const salt = saltOf(id);
  // Sequential random symbols can neglect a lost source block for hundreds of frames. Select repair
  // symbols with balanced coverage, retaining the v1 index-to-block mapping for existing receivers.
  // Bound both the search and cache; beyond the repair window the original fountain stream continues.
  const repairs: number[] = [], coverage = new Uint32Array(meta.k).fill(1);
  let candidate = meta.k;
  const repairIndex = (offset: number) => {
    if (offset >= meta.k * 2) return meta.k * 65 + offset;
    while (repairs.length <= offset) {
      let best = candidate, bestBlocks: number[] = [], score = -1;
      const degree = Math.min(8, blocksFor(candidate, meta.k, salt).length);
      for (let n = 0; n < 32; n++, candidate++) {
        const blocks = blocksFor(candidate, meta.k, salt);
        if (blocks.length !== degree) continue; // retain sparse degree variation and bounded peeling
        const s = blocks.reduce((sum, j) => sum + 1 / (coverage[j]! ** 2), 0) / Math.sqrt(blocks.length);
        if (s > score) { score = s; best = candidate; bestBlocks = blocks; }
      }
      if (!bestBlocks.length) bestBlocks = blocksFor(best, meta.k, salt);
      repairs.push(best);
      for (const j of bestBlocks) coverage[j]!++;
    }
    return repairs[offset]!;
  };
  const dataFrame = (index: number) => {
    const body = new Uint8Array(14 + bs), dv = new DataView(body.buffer);
    dv.setUint32(0, index); dv.setUint32(4, meta.k); dv.setUint16(8, bs); dv.setUint32(10, meta.len);
    const out = body.subarray(14);
    for (const j of blocksFor(index, meta.k, salt)) { const src = padded.subarray(j * bs, (j + 1) * bs); for (let x = 0; x < bs; x++) out[x]! ^= src[x]!; }
    return pack(1, idBytes, body);
  };
  return {
    id, meta, info,
    /** Frame i of the stream: a META frame every few frames, otherwise the next fountain symbol. */
    frame(i: number) {
      if (i % META_EVERY === 0) return metaFrame;
      const symbol = i - Math.floor(i / META_EVERY) - 1;
      return dataFrame(symbol < meta.k ? symbol : repairIndex(symbol - meta.k));
    },
    /** Frames needed at minimum (K data + metas) — real transfers need ~5–15 % more. */
    get minFrames() { return meta.k + Math.ceil(meta.k / (META_EVERY - 1)) + 1; },
  };
}

/** What the receiver learns from the META frame, before accepting. */
export type QrxOffer = { id: string; mode: 'public' | 'private'; blobBytes: number; frames: number; name: string | null; mime: string | null; size: number | null; from: string | null; forMe: boolean };

/**
 * Receiver: feed every scanned text to `push`. Nothing is kept until `accept()`; frames of other transfers are
 * ignored after that. `result()` returns the verified file once complete (or throws on an integrity failure).
 */
export class QrxReceiver {
  private meta: QrxMeta | null = null;
  private accepted = false;
  private info: QrxMeta['info'] | null = null;
  private key: Uint8Array | null = null;
  private blocks: (Uint8Array | null)[] = [];
  private solved = 0;
  private pending: { idx: Set<number>; data: Uint8Array }[] = [];
  private seen = new Set<number>();
  private failure: string | null = null;
  readonly stats = { frames: 0, dropped: 0, duplicates: 0, foreign: 0 };
  private readonly recv: { secretKey: Uint8Array; fingerprint: string } | null;
  private readonly maxBytes: number;
  constructor(o: { receive?: { secretKey: Uint8Array; fingerprint: string }; maxBytes?: number } = {}) { this.recv = o.receive ?? null; this.maxBytes = Math.min(o.maxBytes ?? QRX_MAX_BYTES, QRX_MAX_BYTES); }

  get offer(): QrxOffer | null {
    const m = this.meta; if (!m) return null;
    let from: string | null = null;
    if (m.from && /^[A-Za-z0-9_-]{43}$/.test(m.from.key) && verifyStatement(m.from.key, signedPart(m), m.from.sig)) from = m.from.key;
    const forMe = m.mode === 'public' || (!!this.recv && m.to === this.recv.fingerprint);
    const info = m.mode === 'public' ? m.info : this.unseal();
    return { id: m.id, mode: m.mode, blobBytes: m.len, frames: m.k, name: info?.name ?? null, mime: info?.mime ?? null, size: info?.size ?? null, from, forMe };
  }
  private unseal() {
    if (this.info) return this.info;
    const m = this.meta;
    if (!m || m.mode !== 'private' || !this.recv || m.to !== this.recv.fingerprint || !m.epk || !m.sealed || !m.n1) return null;
    try {
      const k = keyFor(x25519.getSharedSecret(this.recv.secretKey, b64u.decode(m.epk)), m.id);
      const info = JSON.parse(td.decode(xchacha20poly1305(k, b64u.decode(m.n1), hexBytes(m.id)).decrypt(b64u.decode(m.sealed)))) as QrxMeta['info'];
      if (!validInfo(info)) return null;
      this.key = k; this.info = info; return info;
    } catch { return null; }
  }
  /** Feed one scanned QR text. Returns 'meta' when an offer appeared, 'progress', 'done', or null if ignored. */
  push(text: string): 'meta' | 'progress' | 'done' | null {
    const f = parseFrame(text);
    if (!f) { this.stats.dropped++; return null; }
    this.stats.frames++;
    if (f.kind === 'meta') {
      if (!this.meta || (!this.accepted && this.meta.id !== f.id)) { this.meta = f.meta; this.info = null; this.key = null; return 'meta'; }
      return null;
    }
    if (!this.accepted || !this.meta || f.id !== this.meta.id) { this.stats.foreign++; return null; }
    const m = this.meta;
    if (f.k !== m.k || f.bs !== m.bs || f.len !== m.len) { this.stats.dropped++; return null; }
    if (this.seen.has(f.index)) { this.stats.duplicates++; return null; }
    if (this.seen.size > m.k * 3) return null; // decoding effort bound
    this.seen.add(f.index);
    const idx = new Set(blocksFor(f.index, m.k, saltOf(m.id)));
    const data = f.payload.slice();
    for (const j of [...idx]) if (this.blocks[j]) { const b = this.blocks[j]!; for (let x = 0; x < m.bs; x++) data[x]! ^= b[x]!; idx.delete(j); }
    if (idx.size === 0) return this.solved === m.k ? 'done' : 'progress';
    if (idx.size === 1) this.resolve([...idx][0]!, data); else this.pending.push({ idx, data });
    this.solveRemainder();
    return this.solved === m.k ? 'done' : 'progress';
  }
  /** Peeling can stall on a full-rank cycle without singleton rows. Solve only a bounded small remainder;
   * the wire format and block selection stay unchanged. Hash verification still rejects damaged solutions. */
  private solveRemainder() {
    const m = this.meta!, left = m.k - this.solved;
    if (!left || left > 128 || this.pending.length < 2) return;
    const pivots = new Map<number, { idx: Set<number>; data: Uint8Array }>();
    for (const row of this.pending.slice(-left * 4)) {
      const idx = new Set(row.idx), data = row.data.slice();
      while (idx.size) {
        const j = Math.min(...idx), prior = pivots.get(j);
        if (!prior) { pivots.set(j, { idx, data }); break; }
        for (const b of prior.idx) { if (idx.has(b)) idx.delete(b); else idx.add(b); }
        for (let x = 0; x < m.bs; x++) data[x]! ^= prior.data[x]!;
      }
      if (pivots.size === left) break;
    }
    // Even an underdetermined system may reveal individual blocks after eliminating its other pivots.
    for (const j of [...pivots.keys()].sort((a, b) => b - a)) {
      const row = pivots.get(j)!;
      for (const b of [...row.idx]) if (b !== j) {
        const known = this.blocks[b], prior = pivots.get(b);
        if (known) {
          for (let x = 0; x < m.bs; x++) row.data[x]! ^= known[x]!;
          row.idx.delete(b);
        } else if (prior) {
          for (const x of prior.idx) { if (row.idx.has(x)) row.idx.delete(x); else row.idx.add(x); }
          for (let x = 0; x < m.bs; x++) row.data[x]! ^= prior.data[x]!;
        }
      }
      if (row.idx.size === 1 && row.idx.has(j)) this.resolve(j, row.data);
    }
  }
  private resolve(j: number, data: Uint8Array) {
    const m = this.meta!, queue: [number, Uint8Array][] = [[j, data]];
    while (queue.length) {
      const [b, d] = queue.pop()!;
      if (this.blocks[b]) continue;
      this.blocks[b] = d; this.solved++;
      for (let i = this.pending.length - 1; i >= 0; i--) {
        const s = this.pending[i]!;
        if (!s.idx.has(b)) continue;
        for (let x = 0; x < m.bs; x++) s.data[x]! ^= d[x]!;
        s.idx.delete(b);
        if (s.idx.size === 1) { this.pending.splice(i, 1); queue.push([[...s.idx][0]!, s.data]); }
        else if (s.idx.size === 0) this.pending.splice(i, 1);
      }
    }
  }
  /** Start keeping frames of the offered transfer (the person said yes). */
  accept() {
    const o = this.offer;
    if (!o) throw new Error('No transfer to accept yet.');
    if (o.mode === 'private' && !o.forMe) throw new Error('This private transfer is for a different receive code.');
    if (o.mode === 'private' && !this.key) throw new Error('This transfer could not be opened with your receive code.');
    if (o.blobBytes > this.maxBytes + 64) throw new Error('This transfer is larger than this device accepts.');
    this.accepted = true;
    this.blocks = new Array(this.meta!.k).fill(null);
  }
  get progress() { const m = this.meta; return m && this.accepted ? { solved: this.solved, total: m.k, seen: this.seen.size } : null; }
  /** The verified file. Throws if the blob or file hash does not match (the transfer must be scanned again). */
  result(): { bytes: Uint8Array; name: string; mime: string; sha256: string; from: string | null } {
    const m = this.meta;
    if (!m || !this.accepted || this.solved !== m.k) throw new Error('Not complete yet.');
    if (this.failure) throw new Error(this.failure);
    const blob = new Uint8Array(m.k * m.bs);
    this.blocks.forEach((b, i) => blob.set(b!, i * m.bs));
    const exact = blob.subarray(0, m.len);
    if (bytesToHex(sha256(exact)) !== m.sha) { this.failure = 'The received data did not match its fingerprint. Scan the transfer again.'; throw new Error(this.failure); }
    let bytes = exact, info = m.info;
    if (m.mode === 'private') {
      info = this.unseal() ?? undefined;
      try { bytes = xchacha20poly1305(this.key!, b64u.decode(m.n2!), hexBytes(m.id)).decrypt(exact); } catch { this.failure = 'The private file could not be decrypted.'; throw new Error(this.failure); }
    }
    if (!info || bytes.length !== info.size || bytesToHex(sha256(bytes)) !== info.sha256) { this.failure = 'The file did not match its size and SHA-256.'; throw new Error(this.failure); }
    return { bytes, name: info.name, mime: info.mime, sha256: info.sha256, from: this.offer?.from ?? null };
  }
}
const hexBytes = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

/** Receipt the receiver shows; the sender scans it to learn the exact file arrived (signed by the receiver's identity). */
export const ackCode = (o: { id: string; sha256: string; signer: { publicKey: string; sign(b: Uint8Array): string } }) =>
  `clan://qrx/ack?t=${o.id}&h=${o.sha256}&k=${o.signer.publicKey}&s=${o.signer.sign(te.encode(`clan-qrx-ack/1|${o.id}|${o.sha256}`))}`;
export function verifyAck(text: string, expect: { id: string; sha256: string }): { key: string } | null {
  const m = /^clan:\/\/qrx\/ack\?(.*)$/.exec(text.trim()); if (!m) return null;
  const q = new URLSearchParams(m[1]), t = q.get('t'), h = q.get('h'), k = q.get('k') ?? '', s = q.get('s') ?? '';
  if (t !== expect.id || h !== expect.sha256 || !/^[A-Za-z0-9_-]{43}$/.test(k)) return null;
  return verifyStatement(k, te.encode(`clan-qrx-ack/1|${t}|${h}`), s) ? { key: k } : null;
}
