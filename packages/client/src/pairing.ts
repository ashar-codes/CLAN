// Secure pairing: 6-digit code -> OPAQUE (aPAKE) -> HMAC-authenticated TLS pin binding -> HTTPS join with
// device-key proof. Platform-neutral: the OPAQUE client and the device signer are injected.
// Full description: docs/PAIRING_AND_TRUST.md.
import {
  canonicalBytes, derivePairingKeys, keyFingerprint, macOf, verifyBinding,
  type JoinProofPayload, type JoinResponse, type PairFinishResponse, type PairStartResponse, type ReconnectChallengeResponse,
  type ReconnectProofPayload, type TlsBinding,
} from '@classroom/protocol';
import { TransferError, type Candidate, type Transport } from './index.ts';

/** Subset of @serenity-kit/opaque's client API (same shape on every platform binding). */
export type OpaqueClient = {
  startLogin(p: { password: string }): { clientLoginState: string; startLoginRequest: string };
  finishLogin(p: { clientLoginState: string; loginResponse: string; password: string; identifiers?: { client?: string; server?: string } }):
    { finishLoginRequest: string; sessionKey: string } | undefined;
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

/**
 * Pair with one bootstrap endpoint. Throws TransferError('bad_code') if OPAQUE fails (wrong code or an impostor),
 * TransferError('mitm') if the binding doesn't authenticate.
 */
export async function pair(o: {
  bootstrapUrl: string; sessionId: string; code: string; opaque: OpaqueClient;
  plainFetch?: (u: string, i?: RequestInit) => Promise<Response>;
  transportFor(binding: TlsBinding): Transport;
}): Promise<Paired & { joinKey: Uint8Array }> {
  const f = o.plainFetch ?? ((u, i) => fetch(u, i));
  const { clientLoginState, startLoginRequest } = o.opaque.startLogin({ password: o.code });
  const start = await postJson<PairStartResponse>(f, `${o.bootstrapUrl}/api/pair/start`, { v: 1, sessionId: o.sessionId, startLoginRequest });
  const fin = o.opaque.finishLogin({ clientLoginState, loginResponse: start.loginResponse, password: o.code, identifiers: opaqueIdentifiers(o.sessionId) });
  // undefined: the server could not prove knowledge of the code. Send nothing more; the attempt expires server-side.
  if (!fin) throw new TransferError('bad_code', 'No classroom matches that code.');
  const res = await postJson<PairFinishResponse>(f, `${o.bootstrapUrl}/api/pair/finish`, { v: 1, pairingId: start.pairingId, finishLoginRequest: fin.finishLoginRequest });
  const keys = derivePairingKeys(fin.sessionKey);
  const check = verifyBinding(keys.binding, res, { sessionId: o.sessionId, pairingId: start.pairingId });
  if (!check.ok) throw new TransferError('mitm', `Secure pairing failed: ${check.reason}.`);
  const url = `https://${hostOf(o.bootstrapUrl).includes(':') ? `[${hostOf(o.bootstrapUrl)}]` : hostOf(o.bootstrapUrl)}:${check.binding.httpsPort}`;
  return { url, binding: check.binding, transport: o.transportFor(check.binding), joinKey: keys.join };
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
}): Promise<PairedJoin> {
  if (!/^\d{6}$/.test(o.code)) throw new TransferError('invalid', 'Enter the 6-digit classroom code.');
  if (o.candidates.length === 0) throw new TransferError('none_found', 'No classrooms found on this network yet. Make sure you are on the same Wi-Fi as the teacher.');
  const f = o.plainFetch ?? ((u, i) => fetch(u, i));
  const errors: TransferError[] = [];
  const attempts = o.candidates.map(async (c) => {
    try {
      const sid = c.sid ?? (await (await f(`${c.url}/api/info`)).json()).sessionId;
      const paired = await pair({ bootstrapUrl: c.url, sessionId: String(sid), code: o.code, opaque: o.opaque, plainFetch: f, transportFor: o.transportFor });
      return await joinPaired(paired, o.profile, o.device);
    } catch (e) {
      const err = e instanceof TransferError ? e : new TransferError('unreachable', 'Could not reach the classroom securely.');
      errors.push(err);
      throw err;
    }
  });
  try {
    return await Promise.any(attempts);
  } catch {
    // Most informative first: an attack or lockout matters more than "wrong code at some other classroom".
    const order = ['mitm', 'throttled', 'locked', 'ended', 'blocked', 'too_many_pending'];
    for (const code of order) { const e = errors.find((x) => x.code === code); if (e) throw e; }
    const meaningful = errors.find((e) => e.code !== 'bad_code' && e.code !== 'unreachable');
    throw meaningful ?? new TransferError('bad_code', errors.some((e) => e.code === 'bad_code') ? 'No classroom matches that code.' : 'Could not reach any classroom.');
  }
}

/** Rejoin an already-paired session without the code: prove the device key over the pinned TLS channel. */
export async function reconnect(o: { url: string; transport: Transport; sessionId: string; device: DeviceSigner }): Promise<JoinResponse> {
  const ch = await postJson<ReconnectChallengeResponse>(o.transport.fetch, `${o.url}/api/reconnect/challenge`, { v: 1, devicePublicKey: o.device.publicKey });
  const proof: ReconnectProofPayload = { type: 'classroom-lan/reconnect-proof', v: 1, sessionId: o.sessionId, challengeId: ch.challengeId, challenge: ch.challenge, deviceKeyFingerprint: keyFingerprint(o.device.publicKey) };
  return postJson<JoinResponse>(o.transport.fetch, `${o.url}/api/reconnect`, { v: 1, challengeId: ch.challengeId, devicePublicKey: o.device.publicKey, signature: await o.device.sign(canonicalBytes(proof)) });
}
