// Secure pairing: 6-digit code -> OPAQUE (aPAKE) -> HMAC-authenticated TLS pin binding -> HTTPS join with
// device-key proof. Platform-neutral: the OPAQUE client and the device signer are injected.
// Full description: docs/PAIRING_AND_TRUST.md.
import {
  BleReassembler, bleFrames, canonicalBytes, derivePairingKeys, keyFingerprint, macOf, openDirect, verifyBinding,
  type BleRequest, type BleResponse, type DirectPackage,
  type JoinProofPayload, type JoinResponse, type PairFinishResponse, type PairStartResponse, type ReconnectChallengeResponse,
  type ReconnectProofPayload, type TlsBinding,
} from '@classroom/protocol';
import { ed25519 } from '@noble/curves/ed25519.js';
import { b64u } from '@classroom/protocol';
import { TransferError, type Candidate, type Transport } from './index.ts';

/** Ed25519 signer from a 32-byte seed (@noble/curves). Used by mobile, where the seed lives in secure storage. */
export function seedSigner(seed: Uint8Array): { publicKey: string; sign(bytes: Uint8Array): string } {
  if (seed.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
  return { publicKey: b64u.encode(ed25519.getPublicKey(seed)), sign: (bytes) => b64u.encode(ed25519.sign(bytes, seed)) };
}

type MaybePromise<T> = T | Promise<T>;
/**
 * Subset of @serenity-kit/opaque's client API. Desktop passes the library directly (sync); mobile passes a bridge to
 * the same library running in an isolated WebView (async). `clientLoginState` may be an opaque handle.
 */
export type OpaqueClient = {
  startLogin(p: { password: string }): MaybePromise<{ clientLoginState: string; startLoginRequest: string }>;
  finishLogin(p: { clientLoginState: string; loginResponse: string; password: string; identifiers?: { client?: string; server?: string } }):
    MaybePromise<{ finishLoginRequest: string; sessionKey: string } | undefined>;
};
/** Device identity: Ed25519 public key (raw, base64url) and a signer over exact bytes. */
export type DeviceSigner = { publicKey: string; sign(bytes: Uint8Array): Promise<string> | string };

/** Bound into the OPAQUE transcript on both sides so a login can't be replayed into another classroom. */
export const opaqueIdentifiers = (sessionId: string) => ({ client: `classroom-lan/v1/student/${sessionId}`, server: `classroom-lan/v1/classroom/${sessionId}` });

export type Paired = { url: string; binding: TlsBinding; transport: Transport };
export type PairedJoin = Paired & JoinResponse;

const hostOf = (url: string) => new URL(url).hostname;

async function postJson<T>(f: (u: string, i?: RequestInit) => Promise<Response>, url: string, body: unknown): Promise<T> {
  const res = await f(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const b = await res.json().catch(() => ({}));
  if (!res.ok) throw new TransferError(b.code ?? 'http_' + res.status, b.message ?? `Request failed (${res.status})`, res.status);
  return b as T;
}

/** How the OPAQUE messages reach the host before any secure channel exists: HTTP on the LAN, or BLE for Direct mode. */
export type BootstrapCarrier = {
  /** Host address to use for HTTPS when no Direct package says otherwise (HTTP carrier only). */
  hostHint: string | null;
  sessionId(): Promise<string>;
  start(b: { sessionId: string; startLoginRequest: string }): Promise<PairStartResponse>;
  finish(b: { pairingId: string; finishLoginRequest: string }): Promise<PairFinishResponse>;
  abort(b: { pairingId: string }): Promise<void>;
};

export function httpCarrier(url: string, sid?: string, f: (u: string, i?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)): BootstrapCarrier {
  return {
    hostHint: hostOf(url),
    sessionId: async () => sid ?? String((await (await f(`${url}/api/info`)).json()).sessionId),
    start: (b) => postJson(f, `${url}/api/pair/start`, { v: 1, ...b }),
    finish: (b) => postJson(f, `${url}/api/pair/finish`, { v: 1, ...b }),
    abort: async (b) => { await f(`${url}/api/pair/abort`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ v: 1, ...b }) }).catch(() => {}); },
  };
}

/**
 * One carrier for a host advertised at several addresses (mDNS lists all of them): the first address whose
 * GET /api/info answers with the expected session wins, so the code is tried against the host once, not once per address.
 * The address that answers is still untrusted — OPAQUE and the pinned TLS binding decide.
 */
export function lanCarrier(urls: readonly string[], sid?: string, f: (u: string, i?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i), probeMs = 8000): BootstrapCarrier {
  if (urls.length <= 1) return httpCarrier(urls[0] ?? '', sid, f);
  const probe = async (u: string) => {
    const r = await Promise.race([f(`${u}/api/info`), new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), probeMs))]);
    const id = String(((await r.json()) as { sessionId?: unknown }).sessionId ?? '');
    if (!r.ok || !id || (sid && id !== sid)) throw new Error('not this CLAN');
    return httpCarrier(u, id, f);
  };
  let chosen: Promise<BootstrapCarrier> | null = null, host: string | null = null;
  const pick = () => (chosen ??= Promise.any(urls.map(probe)).then((c) => { host = c.hostHint; return c; }, () => { throw new TransferError('unreachable', 'Could not reach the classroom securely.'); }));
  return {
    get hostHint() { return host; }, // the address that answered (pair() reads it after finish(), when it is known)
    sessionId: async () => (await pick()).sessionId(),
    start: async (b) => (await pick()).start(b),
    finish: async (b) => (await pick()).finish(b),
    abort: async (b) => { if (chosen) await (await chosen.catch(() => null))?.abort(b); },
  };
}

/** A GATT connection to a host advertising the CLAN bootstrap service (platform BLE code implements this). */
export type BleLink = { write(frame: Uint8Array): Promise<void>; onFrame(cb: (frame: Uint8Array) => void): () => void; close(): void };

/** Request/response over BLE frames. Carries only the OPAQUE pairing messages; nothing secret is ever in plaintext. */
export function bleCarrier(link: BleLink, timeoutMs = 15_000): BootstrapCarrier {
  let id = 0;
  const waiting = new Map<number, (r: BleResponse) => void>();
  const re = new BleReassembler();
  link.onFrame((fr) => {
    const msg = re.push(fr) as (BleResponse & { id?: number }) | undefined;
    if (msg && typeof msg.id === 'number') { waiting.get(msg.id)?.(msg); waiting.delete(msg.id); }
  });
  const call = async (req: BleRequest): Promise<unknown> => {
    const mine = (id = (id + 1) & 0xff);
    const reply = new Promise<BleResponse>((res, rej) => { waiting.set(mine, res); setTimeout(() => { waiting.delete(mine); rej(new TransferError('unreachable', 'The host stopped answering over Bluetooth.')); }, timeoutMs); });
    for (const fr of bleFrames(mine, { id: mine, ...req })) await link.write(fr);
    const r = await reply;
    if (!r.ok) throw new TransferError(r.code, r.message);
    return r.body;
  };
  return {
    hostHint: null,
    sessionId: async () => String(((await call({ t: 'hello' })) as { sessionId: string }).sessionId),
    start: (b) => call({ t: 'start', ...b }) as Promise<PairStartResponse>,
    finish: (b) => call({ t: 'finish', ...b }) as Promise<PairFinishResponse>,
    abort: async (b) => { await call({ t: 'abort', ...b }).catch(() => {}); },
  };
}

/** Joins the Direct Wi-Fi described by an authenticated package (platform code). Throws if the OS refused. */
export type DirectAssociator = (pkg: DirectPackage) => Promise<void>;

/**
 * Pair with one bootstrap endpoint. Throws TransferError('bad_code') if OPAQUE fails (wrong code or an impostor),
 * TransferError('mitm') if the binding doesn't authenticate.
 */
export async function pair(o: {
  bootstrapUrl?: string; carrier?: BootstrapCarrier; sessionId: string; code: string; opaque: OpaqueClient;
  plainFetch?: (u: string, i?: RequestInit) => Promise<Response>;
  transportFor(binding: TlsBinding): Transport;
  /** Required to use a Direct network; without it a Direct host yields TransferError('direct_manual') carrying the package. */
  associate?: DirectAssociator;
}): Promise<Paired & { joinKey: Uint8Array; direct?: DirectPackage }> {
  const carrier = o.carrier ?? httpCarrier(o.bootstrapUrl!, o.sessionId, o.plainFetch);
  const { clientLoginState, startLoginRequest } = await o.opaque.startLogin({ password: o.code });
  const start = await carrier.start({ sessionId: o.sessionId, startLoginRequest });
  const fin = await o.opaque.finishLogin({ clientLoginState, loginResponse: start.loginResponse, password: o.code, identifiers: opaqueIdentifiers(o.sessionId) });
  // undefined: the server could not prove knowledge of the code (wrong code or impostor). Tell it we gave up, so an
  // honest wrong guess is counted at once; nothing secret is sent.
  if (!fin) {
    await carrier.abort({ pairingId: start.pairingId });
    throw new TransferError('bad_code', 'No CLAN matches that code.');
  }
  const res = await carrier.finish({ pairingId: start.pairingId, finishLoginRequest: fin.finishLoginRequest });
  const keys = derivePairingKeys(fin.sessionKey);
  const check = verifyBinding(keys.binding, res, { sessionId: o.sessionId, pairingId: start.pairingId });
  if (!check.ok) throw new TransferError('mitm', `Secure pairing failed: ${check.reason}.`);
  let host = carrier.hostHint, direct: DirectPackage | undefined;
  if (res.direct) {
    try { direct = openDirect(keys.direct, res.direct, { sessionId: o.sessionId, pairingId: start.pairingId }); }
    catch { throw new TransferError('mitm', 'Secure pairing failed: the network package did not authenticate.'); }
    if (!o.associate) throw Object.assign(new TransferError('direct_manual', `Join the Wi-Fi network ${direct.ssid}, then try again.`), { direct });
    await o.associate(direct);
    host = direct.host;
  }
  if (!host) throw new TransferError('unreachable', 'The host did not provide a network address.');
  const url = `https://${host.includes(':') ? `[${host}]` : host}:${check.binding.httpsPort}`;
  return { url, binding: check.binding, transport: o.transportFor(check.binding), joinKey: keys.join, direct };
}

export async function joinPaired(p: Paired & { joinKey: Uint8Array }, profile: { fullName: string; rollNo: string; deviceName: string }, device: DeviceSigner): Promise<PairedJoin> {
  const proof: JoinProofPayload = {
    type: 'classroom-lan/join-proof', v: 1, sessionId: p.binding.sessionId, pairingId: p.binding.pairingId, challenge: p.binding.challenge,
    deviceKeyFingerprint: keyFingerprint(device.publicKey), fullName: profile.fullName, rollNo: profile.rollNo, deviceName: profile.deviceName,
  };
  const body = {
    v: 1, pairingId: p.binding.pairingId, profile: { ...profile, devicePublicKey: device.publicKey },
    proof: { mac: macOf(p.joinKey, proof), signature: await device.sign(canonicalBytes(proof)) },
  };
  const r = await postJson<JoinResponse>(p.transport.fetch, `${p.url}/api/join`, body);
  return { url: p.url, binding: p.binding, transport: p.transport, ...r };
}

/**
 * Try the code against every discovered endpoint (discovery is untrusted); the one whose OPAQUE succeeds is ours.
 * `sid` comes from discovery or GET /api/info — untrusted too: a wrong sid simply makes OPAQUE fail.
 */
export async function pairAndJoin(o: {
  candidates: Candidate[]; code: string; profile: { fullName: string; rollNo: string; deviceName: string }; device: DeviceSigner;
  opaque: OpaqueClient; plainFetch?: (u: string, i?: RequestInit) => Promise<Response>; transportFor(binding: TlsBinding): Transport;
  /** Extra bootstrap carriers (BLE hosts found nearby). Tried in parallel with the LAN candidates; OPAQUE picks ours. */
  carriers?: BootstrapCarrier[]; associate?: DirectAssociator;
  /** Fresh observed advertisements only; no address scanning, no retry of the same endpoint. */
  candidatesNow?: () => Candidate[]; discoveryWindowMs?: number;
}): Promise<PairedJoin> {
  if (!/^\d{6}$/.test(o.code)) throw new TransferError('invalid', 'Enter the 6-digit classroom code.');
  if (o.candidates.length === 0 && !o.carriers?.length && !o.candidatesNow) throw new TransferError('none_found', 'No classrooms found on this network yet. Make sure you are on the same Wi-Fi as the teacher.');
  const f = o.plainFetch ?? ((u, i) => fetch(u, i));
  const errors: TransferError[] = [];
  const carriers = [...o.candidates.slice(0, 32).map((c) => lanCarrier([c.url, ...(c.alt ?? [])], c.sid, f)), ...(o.carriers ?? [])];
  const attempts = carriers.map(async (carrier) => {
    try {
      const sid = await carrier.sessionId();
      const paired = await pair({ carrier, sessionId: sid, code: o.code, opaque: o.opaque, transportFor: o.transportFor, associate: o.associate });
      return await joinPaired(paired, o.profile, o.device);
    } catch (e) {
      const err = e instanceof TransferError ? e : Object.assign(new TransferError('unreachable', 'Could not reach the classroom securely.'), { cause: e });
      errors.push(err);
      throw err;
    }
  });
  let searching = true;
  if (o.candidatesNow) {
    const key = (c: Candidate) => JSON.stringify([c.sid ?? '', [...new Set([c.url, ...(c.alt ?? [])])].sort()]);
    const seen = new Set(o.candidates.slice(0, 32).map(key));
    const deadline = performance.now() + Math.min(10000, Math.max(0, o.discoveryWindowMs ?? 10000));
    attempts.push((async () => {
      while (searching && performance.now() < deadline && seen.size < 32) {
        const fresh = o.candidatesNow!().filter(c => { const k = key(c); if (seen.has(k) || seen.size >= 32) return false; seen.add(k); return true; });
        if (fresh.length) {
          try { return await pairAndJoin({ ...o, candidates: fresh, carriers: [], candidatesNow: undefined }); }
          catch (e) { if (e instanceof TransferError) errors.push(e); }
        }
        await new Promise(r => setTimeout(r, 100));
      }
      throw new TransferError('none_found', 'No additional reachable CLAN was discovered. Use the host address or QR fallback.');
    })());
  }
  try {
    return await Promise.any(attempts);
  } catch {
    // Most informative first: an attack or lockout matters more than "wrong code at some other classroom".
    const order = ['mitm', 'direct_manual', 'direct_denied', 'throttled', 'locked', 'ended', 'blocked', 'too_many_pending'];
    for (const code of order) { const e = errors.find((x) => x.code === code); if (e) throw e; }
    const meaningful = errors.find((e) => e.code !== 'bad_code' && e.code !== 'unreachable');
    throw meaningful ?? Object.assign(new TransferError('bad_code', errors.some((e) => e.code === 'bad_code') ? 'No CLAN matches that code.' : 'Could not reach any CLAN.'),
      { cause: errors.find((e) => e.cause)?.cause });
  } finally { searching = false; }
}

/** Rejoin an already-paired session without the code: prove the device key over the pinned TLS channel. */
export async function reconnect(o: { url: string; transport: Transport; sessionId: string; device: DeviceSigner }): Promise<JoinResponse> {
  const ch = await postJson<ReconnectChallengeResponse>(o.transport.fetch, `${o.url}/api/reconnect/challenge`, { v: 1, devicePublicKey: o.device.publicKey });
  const proof: ReconnectProofPayload = { type: 'classroom-lan/reconnect-proof', v: 1, sessionId: o.sessionId, challengeId: ch.challengeId, challenge: ch.challenge, deviceKeyFingerprint: keyFingerprint(o.device.publicKey) };
  return postJson<JoinResponse>(o.transport.fetch, `${o.url}/api/reconnect`, { v: 1, challengeId: ch.challengeId, devicePublicKey: o.device.publicKey, signature: await o.device.sign(canonicalBytes(proof)) });
}
