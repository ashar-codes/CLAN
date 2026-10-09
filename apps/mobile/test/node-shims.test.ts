// The phone's `node:crypto` stand-in must give byte-identical results to Node for everything core uses (sync device
// fingerprints, request signatures, link proofs, content hashes), and reject what Node rejects.
import { describe, expect, it, vi } from 'vitest';
import * as node from 'node:crypto';

vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(node.randomBytes(n)), randomUUID: () => node.randomUUID() }));
const shim = await import('../src/node/crypto.ts');
const { join } = await import('../src/node/path.ts');

describe('phone node:crypto shim', () => {
  it('sha256 / HMAC digests match Node in every encoding core uses', () => {
    for (const v of ['', 'clan', 'é✓'.repeat(1000)]) for (const enc of ['hex', 'base64', 'base64url'] as const) {
      expect(shim.createHash('sha256').update(v).digest(enc)).toBe(node.createHash('sha256').update(v).digest(enc));
      expect(shim.createHmac('sha256', 'k').update(v).update(new Uint8Array([1, 2])).digest(enc)).toBe(node.createHmac('sha256', 'k').update(v).update(new Uint8Array([1, 2])).digest(enc));
    }
    expect([...shim.createHash('sha256').update('x').digest()]).toEqual([...node.createHash('sha256').update('x').digest()]);
    expect(shim.randomBytes(18).toString('base64url')).toMatch(/^[A-Za-z0-9_-]{24}$/);
  });
  it('Ed25519 verify agrees with Node, including tampering and non-canonical signatures', () => {
    const { privateKey, publicKey } = node.generateKeyPairSync('ed25519');
    const der = new Uint8Array(publicKey.export({ type: 'spki', format: 'der' }));
    const msg = new TextEncoder().encode('clan-sync-req/v1|GET|/sync/changes');
    const sig = new Uint8Array(node.sign(null, msg, privateKey));
    const k = shim.createPublicKey({ key: der, format: 'der', type: 'spki' });
    expect(shim.verify(null, msg, k, sig)).toBe(true);
    const bad = sig.slice(); bad[5]! ^= 1;
    expect(shim.verify(null, msg, k, bad)).toBe(false);
    const nonCanonical = sig.slice(); nonCanonical[63]! |= 0xe0; // S ≥ L: Node rejects, so must we
    expect(node.verify(null, msg, publicKey, nonCanonical)).toBe(false);
    expect(shim.verify(null, msg, k, nonCanonical)).toBe(false);
    expect(() => shim.createPublicKey({ key: new Uint8Array(10), format: 'der', type: 'spki' })).toThrow();
  });
  it('timingSafeEqual and path join behave like Node', () => {
    expect(shim.timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true);
    expect(() => shim.timingSafeEqual(new Uint8Array([1]), new Uint8Array([1, 2]))).toThrow();
    expect(join('file:///data/CLAN', 'objects', 'ab', 'abc')).toBe('file:///data/CLAN/objects/ab/abc');
    expect(join('file:///data/CLAN/', '/x')).toBe('file:///data/CLAN/x');
  });
});
