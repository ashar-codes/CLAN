import { webcrypto, randomBytes } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { b64u, bytePipe, linkInitiate, linkRespond } from '@classroom/protocol';
vi.mock('expo-crypto', () => ({ getRandomValues: (a: Uint8Array) => webcrypto.getRandomValues(a) }));
import { installSecureRandom } from '../src/secure-random';
afterEach(() => vi.unstubAllGlobals());
it('initializes a missing Hermes random source and completes mutually authenticated direct-link crypto', async () => {
  vi.stubGlobal('crypto', undefined); installSecureRandom();
  const signer = () => { const sk = randomBytes(32); return { publicKey: b64u.encode(ed25519.getPublicKey(sk)), sign: (b: Uint8Array) => b64u.encode(ed25519.sign(b, sk)) }; };
  const a = signer(), b = signer(), [x, y] = bytePipe();
  const [initiator, responder] = await Promise.all([
    linkInitiate(x, { signer: a, expectKey: b.publicKey }),
    linkRespond(y, { signer: b, accept: key => key === a.publicKey }),
  ]);
  expect(initiator.peerKey).toBe(b.publicKey); expect(responder.peerKey).toBe(a.publicKey);
  const received = new Promise<Uint8Array>(resolve => responder.onMessage(resolve));
  initiator.send(new TextEncoder().encode('authenticated encrypted native link'));
  expect(new TextDecoder().decode(await received)).toBe('authenticated encrypted native link');
  initiator.close(); responder.close();
});
it('preserves existing crypto properties and propagates native random-source failure', () => {
  const random = vi.fn(), target = { crypto: { getRandomValues: random, other: 'preserved' } };
  installSecureRandom(target); expect(target.crypto.getRandomValues).toBe(random); expect(target.crypto.other).toBe('preserved');
  vi.stubGlobal('crypto', undefined); installSecureRandom();
  expect(() => globalThis.crypto.getRandomValues(new Uint8Array(65537))).toThrow();
});
