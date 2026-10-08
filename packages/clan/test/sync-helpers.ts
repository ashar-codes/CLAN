// Shared by the personal-sync tests (also the phone contract test): a device = a real CLAN database with a sync key.
import { expect } from 'vitest';
import { generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { linkTranscript, normalizeLinkCode } from '@classroom/protocol';
import { linkProof } from '../src/index.ts';
import { setup, user } from './helpers.ts';

export const clock = { t: 1_800_000_000_000 };
export const now = () => clock.t;
export type Dev = ReturnType<typeof device>;
export function device(name: string, o: { storageDir?: string; db?: NonNullable<Parameters<typeof setup>[0]>['db'] } = {}) {
  const s = setup({ now, storageDir: o.storageDir, db: o.db });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('base64url');
  const fp = s.app.sync.setup({ publicKey: pub, name, platform: 'test', tlsCa: 'ca', tlsSpki: `spki-${name}` }, { publicKey: pub, sign: (b) => edSign(null, b, privateKey).toString('base64url') });
  return { ...s, name, fp, me: user(s.app.me), key: { privateKey, pub } };
}
/** The link handshake exactly as the LAN client runs it (code typed by the student, proofs bound to the TLS key seen). */
export function link(a: Dev, b: Dev, o: { code?: string; seenSpki?: string } = {}) {
  const started = a.app.sync.startLink();
  const code = normalizeLinkCode(o.code ?? started.code)!;
  const { sessionId, nonceA } = a.app.sync.linkStart();
  const nonceB = randomBytes(18).toString('base64url'), spki = o.seenSpki ?? a.app.sync.self().tlsSpki;
  const tr = linkTranscript('joiner', { sessionId, serverSpki: spki, joinerKey: b.key.pub, nonceA, nonceB });
  const self = b.app.sync.self();
  a.app.sync.linkHello({ sessionId, nonceB, proof: linkProof(code, tr), sig: edSign(null, new TextEncoder().encode(tr), b.key.privateKey).toString('base64url'),
    device: { fp: self.fp, publicKey: self.publicKey, name: self.name, platform: self.platform, tlsCa: self.tlsCa, tlsSpki: self.tlsSpki, endpoints: ['127.0.0.1:1'] } }, a.app.sync.self().tlsSpki);
  expect(a.app.sync.linkStatus(sessionId, nonceB).status).toBe('pending'); // nothing until the student approves
  a.app.sync.approveLink(sessionId, ['127.0.0.1:2']);
  const st = a.app.sync.linkStatus(sessionId, nonceB) as { status: 'approved'; proof: string; grant: unknown };
  expect(st.proof).toBe(linkProof(code, linkTranscript('approver', { sessionId, serverSpki: spki, joinerKey: b.key.pub, nonceA, nonceB })));
  b.app.sync.adopt(st.grant);
}
