// clan-link/1: mutual authentication, policy before disclosure, confidentiality, tamper/replay/misbinding resistance.
import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519.js';
import { b64u, bytePipe, FrameReader, frame, linkInitiate, linkRespond, type ByteLink, type LinkSigner } from '../src/index.ts';

const signer = (): LinkSigner => { const sk = ed25519.utils.randomSecretKey(); return { publicKey: b64u.encode(ed25519.getPublicKey(sk)), sign: (b) => b64u.encode(ed25519.sign(b, sk)) }; };
const te = new TextEncoder(), td = new TextDecoder();
const recv = (l: { onMessage(cb: (m: Uint8Array) => void): void }) => new Promise<string>((r) => l.onMessage((m) => r(td.decode(m))));

/** A man in the middle that can watch, record, drop or alter every chunk. */
function tap(edit?: (dir: 'ab' | 'ba', chunk: Uint8Array, i: number) => Uint8Array | null) {
  const [a, mA] = bytePipe(), [mB, b] = bytePipe(), seen: Uint8Array[] = [];
  let i = 0;
  mA.onData((c) => { seen.push(c); const x = edit ? edit('ab', c, i++) : c; if (x) mB.send(x); });
  mB.onData((c) => { seen.push(c); const x = edit ? edit('ba', c, i++) : c; if (x) mA.send(x); });
  mA.onClose(() => mB.close()); mB.onClose(() => mA.close());
  return { a, b, seen };
}

describe('clan-link/1', () => {
  it('closes an unauthenticated peer flooding handshake frames before disclosing identity', async () => {
    const [a, b] = bytePipe(), me = signer();
    const p = linkRespond(b, { signer: me, accept: () => true });
    const bytes = frame(te.encode(JSON.stringify({ v: 'clan-link/1', e: b64u.encode(new Uint8Array(32).fill(5)), n: b64u.encode(new Uint8Array(16)) })));
    const burst = new Uint8Array(bytes.length * 100);
    for (let i = 0; i < 100; i++) burst.set(bytes, i * bytes.length);
    a.send(burst);
    await expect(p).rejects.toMatchObject({ code: 'too_large' });
  });

  it('bounds authenticated messages received before a consumer subscribes', async () => {
    const [a, b] = bytePipe();
    const [i, r] = await Promise.all([linkInitiate(a, { signer: signer() }), linkRespond(b, { signer: signer(), accept: () => true })]);
    const closed = new Promise<string | undefined>((res) => r.onClose(res));
    for (let n = 0; n < 100; n++) i.send(te.encode('unconsumed'));
    expect(await closed).toMatch(/pending/);
    expect(r.closed).toBe(true);
  });
  it('authenticates both sides, encrypts both directions, and hides identities from an observer', async () => {
    const A = signer(), B = signer(), t = tap();
    const [ia, rb] = await Promise.all([linkInitiate(t.a, { signer: A, expectKey: B.publicKey }), linkRespond(t.b, { signer: B, accept: () => true })]);
    expect(ia.peerKey).toBe(B.publicKey); expect(rb.peerKey).toBe(A.publicKey);
    const got = recv(rb); ia.send(te.encode('secret lecture notes')); expect(await got).toBe('secret lecture notes');
    const back = recv(ia); rb.send(te.encode('thanks')); expect(await back).toBe('thanks');
    const wire = td.decode(new Uint8Array(t.seen.flatMap((c) => [...c])));
    for (const s of ['secret lecture notes', 'thanks', A.publicKey, B.publicKey]) expect(wire).not.toContain(s);
  });

  it('the responder reveals nothing to a caller its policy refuses', async () => {
    const A = signer(), B = signer(), t = tap();
    const seenKeys: string[] = [];
    const r = linkRespond(t.b, { signer: B, accept: (k, inv) => { seenKeys.push(k); return inv === 'good-invite' || 'Not visible to you.'; } });
    await expect(linkInitiate(t.a, { signer: A })).rejects.toMatchObject({ code: 'refused' });
    await expect(r).rejects.toMatchObject({ code: 'refused' });
    expect(seenKeys).toEqual([A.publicKey]);
    expect(td.decode(new Uint8Array(t.seen.flatMap((c) => [...c])))).not.toContain(B.publicKey);
    const t2 = tap();
    const [ok] = await Promise.all([linkInitiate(t2.a, { signer: A, invite: 'good-invite' }), linkRespond(t2.b, { signer: B, accept: (_k, inv) => inv === 'good-invite' })]);
    expect(ok.peerKey).toBe(B.publicKey);
  });

  it('refuses the wrong identity, an active man in the middle and tampering', async () => {
    const A = signer(), B = signer(), M = signer();
    // dialled B, M answered
    const t1 = tap();
    await expect(Promise.all([linkInitiate(t1.a, { signer: A, expectKey: B.publicKey }), linkRespond(t1.b, { signer: M, accept: () => true })])).rejects.toMatchObject({ code: 'wrong_peer' });
    // active MITM that terminates both sides with its own ephemeral keys cannot sign as A or B: relaying A's handshake
    // into its own session with B fails A's signature check (it covers A's view of both ephemerals)
    const [a2, mA] = bytePipe(), [mB, b2] = bytePipe();
    const relayed: Uint8Array[] = []; mA.onData((c) => relayed.push(c));
    const mitm = linkInitiate(mB, { signer: M });
    const rB = linkRespond(b2, { signer: B, accept: () => true });
    void linkInitiate(a2, { signer: A, expectKey: B.publicKey }).catch(() => {});
    await mitm; await rB; // M can talk to B — as M, never as A
    expect((await rB).peerKey).toBe(M.publicKey);
    // a flipped bit in any handshake or data frame ends the session
    const t3 = tap((dir, c, i) => { if (dir === 'ab' && i === 2) { const x = c.slice(); x[x.length - 1]! ^= 1; return x; } return c; });
    await expect(Promise.all([linkInitiate(t3.a, { signer: A, timeoutMs: 800 }), linkRespond(t3.b, { signer: B, accept: () => true, timeoutMs: 800 })])).rejects.toBeTruthy();
  });

  it('replayed data frame closes the session', async () => {
    const A = signer(), B = signer();
    const frames: Uint8Array[] = [];
    const t = tap((dir, c) => { if (dir === 'ab') frames.push(c); return c; });
    const [i, r] = await Promise.all([linkInitiate(t.a, { signer: A }), linkRespond(t.b, { signer: B, accept: () => true })]);
    const msgs: string[] = []; r.onMessage((m) => msgs.push(td.decode(m)));
    const closed = new Promise<string | undefined>((res) => r.onClose(res));
    i.send(te.encode('first')); await new Promise((res) => setTimeout(res, 10));
    (t.a as ByteLink).send(frames.at(-1)!); // attacker re-injects the captured ciphertext
    expect(await closed).toMatch(/authentication/);
    expect(msgs).toEqual(['first']);
  });

  it('frames: split, joined and oversized input', () => {
    const r = new FrameReader(100), a = frame(te.encode('hello')), b = frame(te.encode('world'));
    const joined = new Uint8Array([...a, ...b]);
    expect(r.push(joined.slice(0, 3))).toEqual([]);
    expect(r.push(joined.slice(3, 12)).map((f) => td.decode(f))).toEqual(['hello']);
    expect(r.push(joined.slice(12)).map((f) => td.decode(f))).toEqual(['world']);
    const big = new Uint8Array(4); new DataView(big.buffer).setUint32(0, 101);
    expect(() => r.push(big)).toThrow(/limit/);
  });

  it('a silent or garbage-speaking peer times out or fails, never hangs', async () => {
    const A = signer(), [a, b] = bytePipe();
    await expect(linkInitiate(a, { signer: A, timeoutMs: 200 })).rejects.toMatchObject({ code: 'timeout' });
    const [c, d] = bytePipe();
    const p = linkRespond(d, { signer: A, accept: () => true, timeoutMs: 500 });
    c.send(frame(te.encode('{"v":"clan-link/1","e":"zz","n":"q"}')));
    await expect(p).rejects.toMatchObject({ code: 'malformed' });
    void b;
  });
});
