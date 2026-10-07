// Server half of secure pairing. See docs/PAIRING_AND_TRUST.md for the full protocol.
import * as opaque from '@serenity-kit/opaque';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  b64u, derivePairingKeys, ed25519Verify, keyFingerprint, macOf, macValid,
  type JoinProofPayload, type JoinRequest, type PairFinishResponse, type PairStartResponse, type ReconnectChallengeResponse,
  type ReconnectProofPayload, type TlsBinding,
} from '@classroom/protocol';
import type { Classroom } from './classroom.ts';
import { JoinError } from './classroom.ts';

export const PAIR_STATE_TTL_MS = 60_000;
export const BINDING_TTL_MS = 2 * 60_000;
const MAX_INFLIGHT = 500;
/** Unfinished pairing attempts allowed per source address at once (each is a potential guess). */
export const DEFAULT_PAIR_INFLIGHT_PER_SOURCE = 4;

const identifiers = (sessionId: string) => ({ client: `classroom-lan/v1/student/${sessionId}`, server: `classroom-lan/v1/classroom/${sessionId}` });
const nonce = () => b64u.encode(new Uint8Array(randomBytes(32)));

type Started = { source: string; serverLoginState: string; expires: number };
type Finished = { joinKey: Uint8Array; challenge: string; expires: number };
type Challenge = { devicePublicKey: string; challenge: string; expires: number };

export type BindingInfo = Pick<TlsBinding, 'httpsPort' | 'spkiSha256' | 'certificate' | 'teacherPublicKey' | 'title'>;

/**
 * One instance per classroom session. At creation the 6-digit code is registered as an OPAQUE "password" for
 * userIdentifier = sessionId under the teacher's long-lived OPAQUE server setup; afterwards only the registration
 * record is kept. Every attempt that does not complete (wrong code -> client aborts, finish fails, or it simply
 * expires) is counted by the classroom throttles.
 */
export class Pairing {
  private classroom: Classroom; private setup: string; private record: string; private info: () => BindingInfo; private now: () => number;
  private started = new Map<string, Started>();
  private finished = new Map<string, Finished>();
  private challenges = new Map<string, Challenge>();

  private constructor(classroom: Classroom, setup: string, record: string, info: () => BindingInfo, now: () => number) {
    this.classroom = classroom; this.setup = setup; this.record = record; this.info = info; this.now = now;
  }

  static async create(classroom: Classroom, opaqueServerSetup: string, code: string, info: () => BindingInfo, now = () => Date.now()): Promise<Pairing> {
    await opaque.ready;
    const ids = identifiers(classroom.id);
    // Registration runs entirely in-process: the teacher machine plays both roles once.
    const reg = opaque.client.startRegistration({ password: code });
    const { registrationResponse } = opaque.server.createRegistrationResponse({ serverSetup: opaqueServerSetup, userIdentifier: classroom.id, registrationRequest: reg.registrationRequest });
    const { registrationRecord } = opaque.client.finishRegistration({ clientRegistrationState: reg.clientRegistrationState, registrationResponse, password: code, identifiers: ids });
    return new Pairing(classroom, opaqueServerSetup, registrationRecord, info, now);
  }

  inflightPerSource = DEFAULT_PAIR_INFLIGHT_PER_SOURCE;

  private failed(source: string) {
    this.classroom.ipThrottle.fail(source);
    this.classroom.globalThrottle.fail('*');
  }

  private sweep() {
    const t = this.now();
    // An attempt that never finished counts as a guess: the client can test a code from the KE2 response alone.
    for (const [k, v] of this.started) if (v.expires < t) { this.started.delete(k); this.failed(v.source); }
    for (const [k, v] of this.finished) if (v.expires < t) this.finished.delete(k);
    for (const [k, v] of this.challenges) if (v.expires < t) this.challenges.delete(k);
  }

  private throttleCheck(source: string) {
    const lock = Math.max(this.classroom.ipThrottle.lockedFor(source), this.classroom.globalThrottle.lockedFor('*'));
    if (lock > 0) throw new JoinError(429, 'throttled', 'Too many attempts. Wait and try again.', lock);
  }

  /**
   * OPAQUE KE1 -> KE2. Each start is one potential guess: it is counted as a failure if it is not completed
   * (finish fails or it expires). Concurrent unfinished attempts are capped per source and globally, so guesses
   * can't be parallelised beyond that before they start counting.
   */
  start(source: string, sessionId: string, startLoginRequest: string): PairStartResponse {
    this.sweep();
    this.throttleCheck(source);
    this.classroom.assertJoinable();
    if (this.started.size >= MAX_INFLIGHT) throw new JoinError(429, 'busy', 'Too many people are joining right now. Try again shortly.');
    let mine = 0;
    for (const v of this.started.values()) if (v.source === source) mine++;
    if (mine >= this.inflightPerSource) throw new JoinError(429, 'throttled', 'Too many attempts at once. Wait and try again.', PAIR_STATE_TTL_MS);
    // A wrong session id behaves exactly like a wrong code (OPAQUE fails on the client); no oracle either way.
    let res: { serverLoginState: string; loginResponse: string };
    try {
      res = opaque.server.startLogin({
        serverSetup: this.setup, registrationRecord: sessionId === this.classroom.id ? this.record : null,
        startLoginRequest, userIdentifier: sessionId, identifiers: identifiers(sessionId),
      });
    } catch {
      throw new JoinError(400, 'invalid', 'Invalid pairing request.');
    }
    const { serverLoginState, loginResponse } = res;
    const pairingId = randomUUID();
    this.started.set(pairingId, { source, serverLoginState, expires: this.now() + PAIR_STATE_TTL_MS });
    return { pairingId, loginResponse };
  }

  /** Honest client saw OPAQUE fail (wrong code): count it now and free the slot. */
  abort(source: string, pairingId: string) {
    const st = this.started.get(pairingId);
    if (!st || st.source !== source) return;
    this.started.delete(pairingId);
    this.failed(source);
  }

  /** OPAQUE KE3 -> authenticated TLS binding + device challenge. */
  finish(source: string, pairingId: string, finishLoginRequest: string): PairFinishResponse {
    this.sweep();
    const st = this.started.get(pairingId);
    this.started.delete(pairingId); // single use
    if (!st || st.source !== source) throw new JoinError(403, 'bad_code', 'Pairing failed.');
    let sessionKey: string;
    try {
      ({ sessionKey } = opaque.server.finishLogin({ finishLoginRequest, serverLoginState: st.serverLoginState, identifiers: identifiers(this.classroom.id) }));
    } catch {
      this.failed(source);
      throw new JoinError(403, 'bad_code', 'Pairing failed.');
    }
    const keys = derivePairingKeys(sessionKey);
    const t = this.now();
    const binding: TlsBinding = {
      type: 'classroom-lan/tls-binding', v: 1, sessionId: this.classroom.id, pairingId,
      ...this.info(), challenge: nonce(), issuedAt: t, expiresAt: t + BINDING_TTL_MS,
    };
    this.finished.set(pairingId, { joinKey: keys.join, challenge: binding.challenge, expires: binding.expiresAt });
    return { binding, mac: macOf(keys.binding, binding) };
  }

  /**
   * Verify an HTTPS join: the MAC proves it comes from the party that completed OPAQUE (the code holder), the
   * signature proves possession of the device private key. Single use; expires with the binding.
   */
  verifyJoin(req: JoinRequest): void {
    this.sweep();
    const f = this.finished.get(req.pairingId);
    this.finished.delete(req.pairingId);
    if (!f) throw new JoinError(403, 'bad_proof', 'Pairing expired or already used. Join again.');
    const p = req.profile;
    const proof: JoinProofPayload = {
      type: 'classroom-lan/join-proof', v: 1, sessionId: this.classroom.id, pairingId: req.pairingId, challenge: f.challenge,
      deviceKeyFingerprint: keyFingerprint(p.devicePublicKey), fullName: p.fullName, rollNo: p.rollNo, deviceName: p.deviceName,
    };
    if (!macValid(f.joinKey, proof, req.proof.mac) || !ed25519Verify(p.devicePublicKey, proof, req.proof.signature)) {
      throw new JoinError(403, 'bad_proof', 'Device verification failed.');
    }
  }

  reconnectChallenge(devicePublicKey: string): ReconnectChallengeResponse {
    this.sweep();
    if (this.challenges.size >= MAX_INFLIGHT) throw new JoinError(429, 'busy', 'Try again shortly.');
    const challengeId = randomUUID();
    const c = { devicePublicKey, challenge: nonce(), expires: this.now() + PAIR_STATE_TTL_MS };
    this.challenges.set(challengeId, c);
    return { challengeId, challenge: c.challenge, expiresAt: c.expires };
  }

  /** Returns the proven device fingerprint. Challenge is single use, bound to this session and to one key. */
  verifyReconnect(challengeId: string, devicePublicKey: string, signature: string): string {
    this.sweep();
    const c = this.challenges.get(challengeId);
    this.challenges.delete(challengeId);
    if (!c || c.devicePublicKey !== devicePublicKey) throw new JoinError(403, 'bad_proof', 'Device verification failed.');
    const fp = keyFingerprint(devicePublicKey);
    const proof: ReconnectProofPayload = { type: 'classroom-lan/reconnect-proof', v: 1, sessionId: this.classroom.id, challengeId, challenge: c.challenge, deviceKeyFingerprint: fp };
    if (!ed25519Verify(devicePublicKey, proof, signature)) throw new JoinError(403, 'bad_proof', 'Device verification failed.');
    return fp;
  }

  /** Forget everything derived from the code (class ended). */
  destroy() {
    this.record = '';
    this.started.clear(); this.finished.clear(); this.challenges.clear();
  }
}
