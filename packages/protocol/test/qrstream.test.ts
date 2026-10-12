// clan-qrx/1 optical transfer, end to end through real QR images: frames are rendered as QR codes (qrcode) and read
// back by a QR decoder (jsQR) — with dropped, duplicated, reordered and damaged frames — then verified.
import { describe, expect, it } from 'vitest';
import QRCode from 'qrcode';
import jsQRImport from 'jsqr';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ackCode, b64u, blocksFor, crc32, encodeTransfer, parseFrame, parseReceiveCode, QrxReceiver, receiveCode, verifyAck } from '../src/index.ts';

type Decode = (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
const jsQR = ((jsQRImport as unknown as { default?: Decode }).default ?? jsQRImport) as unknown as Decode;
const signer = () => { const sk = ed25519.utils.randomSecretKey(); return { publicKey: b64u.encode(ed25519.getPublicKey(sk)), sign: (b: Uint8Array) => b64u.encode(ed25519.sign(b, sk)) }; };
const random = (n: number, seed = 1) => { const b = new Uint8Array(n); let s = seed; for (let i = 0; i < n; i++) { s = (s * 1103515245 + 12345) >>> 0; b[i] = s >>> 24; } return b; };

/** Render text as a QR image and read it back like a camera frame would be (optionally damaging the image). */
function optical(text: string, damage = 0): string | null {
  const qr = QRCode.create(text, { errorCorrectionLevel: 'L' });
  const n = qr.modules.size, scale = 3, quiet = 4, w = (n + 2 * quiet) * scale;
  const px = new Uint8ClampedArray(w * w * 4).fill(255);
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.modules.data[y * n + x]) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) { const o = (((y + quiet) * scale + dy) * w + (x + quiet) * scale + dx) * 4; px[o] = px[o + 1] = px[o + 2] = 0; }
  }
  for (let i = 0; i < damage; i++) { const o = Math.floor(Math.random() * w * w) * 4; px[o] = px[o + 1] = px[o + 2] = 255 - px[o]!; }
  return jsQR(px, w, w)?.data ?? null;
}

describe('clan-qrx/1 animated QR transfer', () => {
  it('recovers a full-rank fountain cycle with no singleton symbols', () => {
    const bytes = random(48), tx = encodeTransfer({ bytes, name: 'cycle.txt', mime: 'text/plain' }, { blockSize: 16 });
    const rx = new QrxReceiver(); rx.push(tx.frame(0)); rx.accept();
    const wanted = new Set(['0,1', '1,2', '0,1,2']);
    for (let n = 4; n < 5000 && wanted.size; n++) {
      const frame = tx.frame(n), f = parseFrame(frame);
      if (f?.kind !== 'data' || f.index < 3) continue;
      const row = blocksFor(f.index, 3, parseInt(tx.id.slice(0, 8), 16)).sort().join(',');
      if (wanted.delete(row)) rx.push(frame);
    }
    expect(wanted.size).toBe(0);
    expect(rx.result().bytes).toEqual(bytes);
  });

  it('recovers across independent transfer salts with burst loss within two stream lengths', () => {
    const bytes = random(40_000, 7);
    for (let run = 0; run < 50; run++) {
      const tx = encodeTransfer({ bytes, name: 'loss.bin', mime: 'application/octet-stream' }, { blockSize: 400 });
      const rx = new QrxReceiver(); rx.push(tx.frame(0)); rx.accept();
      let done = false;
      for (let n = 1; n < tx.minFrames * 2; n++) {
        if (n % 13 === 5 || n % 17 === 0 || n % 29 === 0 || n < 5) continue;
        if (rx.push(tx.frame(n)) === 'done') { done = true; break; }
      }
      expect(done).toBe(true);
      expect(rx.result().bytes).toEqual(bytes);
    }
  });

  it('drops a CRC-valid data frame whose header is truncated', () => {
    const bytes = new Uint8Array(10 + 13 + 4); bytes[0] = 1; bytes[1] = 1;
    new DataView(bytes.buffer).setUint32(bytes.length - 4, crc32(bytes.subarray(0, bytes.length - 4)));
    expect(parseFrame('CLQ1' + b64u.encode(bytes))).toBeNull();
  });

  it('does not display a malformed or unsafe public file description', () => {
    const tx = encodeTransfer({ bytes: random(16), name: 'a.txt', mime: 'text/plain' });
    const original = b64u.decode(tx.frame(0).slice(4));
    for (const name of [{ hostile: 'object' }, '../secret.txt', 'bad\u0000name']) {
      const meta = JSON.parse(new TextDecoder().decode(original.subarray(10, original.length - 4)));
      meta.info.name = name;
      const body = new TextEncoder().encode(JSON.stringify(meta)), frame = new Uint8Array(14 + body.length);
      frame.set(original.subarray(0, 10)); frame.set(body, 10);
      new DataView(frame.buffer).setUint32(frame.length - 4, crc32(frame.subarray(0, frame.length - 4)));
      expect(new QrxReceiver().push('CLQ1' + b64u.encode(frame))).toBeNull();
    }
  });
  it('public file through real QR images: drops, duplicates, reordering and damage; exact bytes verified', () => {
    const bytes = random(40_000, 7), tx = encodeTransfer({ bytes, name: 'notes.pdf', mime: 'application/pdf' }, { blockSize: 400 });
    const rx = new QrxReceiver();
    let shown = 0, done = false;
    const seq: number[] = [];
    for (let n = 0; n < 2000 && !done; n++) seq.push(n);
    // the receiver looks away now and then, sees some frames twice, and sees bursts out of order
    const order = seq.flatMap((x) => (x % 13 === 5 ? [] : x % 11 === 3 ? [x, x] : [x]));
    for (let j = 0; j + 4 < order.length; j += 5) [order[j], order[j + 3]] = [order[j + 3]!, order[j]!];
    let accepted = false, unreadable = 0;
    for (const n of order) {
      const text = optical(tx.frame(n), n % 17 === 0 ? 3000 : 0); shown++;
      if (text === null) { unreadable++; continue; }
      const r = rx.push(n % 29 === 0 ? text.slice(0, -3) + 'AAA' : text); // some misreads that survive the QR decoder
      if (r === 'meta' && !accepted) {
        expect(rx.offer).toMatchObject({ mode: 'public', name: 'notes.pdf', size: 40_000, forMe: true, from: null });
        rx.accept(); accepted = true;
      }
      if (r === 'done') { done = true; break; }
    }
    expect(done).toBe(true);
    const out = rx.result();
    expect(out.bytes).toEqual(bytes);
    expect(out.name).toBe('notes.pdf');
    expect(rx.stats.duplicates).toBeGreaterThan(0);
    expect(rx.stats.dropped).toBeGreaterThan(0);
    expect(shown).toBeLessThan(tx.minFrames * 2); // fountain overhead stays modest despite losses
    expect(unreadable).toBeGreaterThan(0); // damaged images really were unreadable and simply skipped
  }, 120_000);

  it('private transfer: only the receive code it was made for can open it; frames reveal no name or content', () => {
    const me = receiveCode('Bilal'), other = receiveCode('Mallory');
    const sender = signer(), bytes = new TextEncoder().encode('Lecture 9 solutions — confidential '.repeat(200));
    const to = parseReceiveCode(optical(me.text)!)!;
    const tx = encodeTransfer({ bytes, name: 'solutions-week9.txt', mime: 'text/plain' }, { blockSize: 600, to, signer: sender });
    const frames = Array.from({ length: tx.minFrames * 2 }, (_, n) => tx.frame(n));
    for (const f of frames) { expect(f).not.toContain('solutions'); expect(atob(f.slice(4).replace(/-/g, '+').replace(/_/g, '/'))).not.toContain('confidential'); }
    const wrong = new QrxReceiver({ receive: other });
    wrong.push(frames[0]!);
    expect(wrong.offer).toMatchObject({ mode: 'private', forMe: false, name: null });
    expect(() => wrong.accept()).toThrow(/different receive code/);
    const rx = new QrxReceiver({ receive: me });
    rx.push(frames[0]!);
    expect(rx.offer).toMatchObject({ mode: 'private', forMe: true, name: 'solutions-week9.txt', from: sender.publicKey });
    rx.accept();
    let done = false;
    for (const f of frames.slice(1).reverse()) if (rx.push(f) === 'done') { done = true; break; }
    expect(done).toBe(true);
    expect(new TextDecoder().decode(rx.result().bytes)).toContain('Lecture 9 solutions');
  });

  it('signed receipt by reverse scan; forged or mismatched receipts are rejected', () => {
    const tx = encodeTransfer({ bytes: random(3000), name: 'a.png', mime: 'image/png' }, { blockSize: 200 });
    const rx = new QrxReceiver(); rx.push(tx.frame(0)); rx.accept();
    for (let n = 1; n < 400; n++) if (rx.push(tx.frame(n)) === 'done') break;
    const got = rx.result(), me = signer();
    const ack = optical(ackCode({ id: tx.id, sha256: got.sha256, signer: me }))!;
    expect(verifyAck(ack, { id: tx.id, sha256: tx.info.sha256 })).toEqual({ key: me.publicKey });
    expect(verifyAck(ack, { id: tx.id, sha256: '0'.repeat(64) })).toBeNull();
    expect(verifyAck(ack.replace(/s=[^&]+/, `s=${'A'.repeat(86)}`), { id: tx.id, sha256: tx.info.sha256 })).toBeNull();
  });

  it('defends against malformed frames, oversized offers, foreign streams, forged data and tampered descriptions', () => {
    expect(() => encodeTransfer({ bytes: new Uint8Array(3 * 1024 * 1024), name: 'big.mp4', mime: 'video/mp4' })).toThrow(/limited/);
    for (const junk of ['', 'CLQ1', 'CLQ1!!!!', 'CLQ1' + 'A'.repeat(5000), 'hello', 'CLQ1AAAAAAAAAAAAAAAAAAAAAAAA']) expect(parseFrame(junk)).toBeNull();
    const a = encodeTransfer({ bytes: random(5000, 3), name: 'a.txt', mime: 'text/plain' }, { blockSize: 200 });
    const b = encodeTransfer({ bytes: random(5000, 4), name: 'b.txt', mime: 'text/plain' }, { blockSize: 200 });
    const rx = new QrxReceiver();
    expect(rx.push(a.frame(1))).toBeNull(); // nothing kept before an offer is accepted
    rx.push(a.frame(0)); rx.accept();
    for (let n = 1; n < 20; n++) rx.push(b.frame(n)); // another transfer on a nearby screen
    expect(rx.stats.foreign).toBeGreaterThan(0);
    // a forged data frame with a valid CRC but wrong content (an attacker recomputed the CRC): caught by the blob
    // SHA-256, never returned as the file
    const rx2 = new QrxReceiver(); rx2.push(a.frame(0)); rx2.accept();
    let done = false;
    for (let n = 1; n < 200 && !done; n++) {
      let f = a.frame(n);
      if (n === 2) f = tamper(f);
      done = rx2.push(f) === 'done';
    }
    expect(done).toBe(true);
    expect(() => rx2.result()).toThrow(/fingerprint/);
    // a tampered (re-signed by nobody) description loses its sender identity
    const s = signer(), t = encodeTransfer({ bytes: random(100), name: 'x.txt', mime: 'text/plain' }, { signer: s });
    const r3 = new QrxReceiver(); r3.push(t.frame(0)); expect(r3.offer?.from).toBe(s.publicKey);
    const r4 = new QrxReceiver(); r4.push(retitle(t.frame(0), 'x.txt', 'y.txt')); expect(r4.offer).toMatchObject({ name: 'y.txt', from: null });
  });
});

/** An attacker who can forge a frame with a valid CRC (flip payload bytes, recompute CRC). */
function tamper(frame: string) {
  const b = b64u.decode(frame.slice(4)); b[30]! ^= 0xff;
  return rebuild(b);
}
function retitle(frame: string, from: string, to: string) {
  const b = b64u.decode(frame.slice(4)), body = new TextDecoder().decode(b.subarray(10, b.length - 4)).replace(from, to);
  const enc = new TextEncoder().encode(body), out = new Uint8Array(10 + enc.length + 4); out.set(b.subarray(0, 10)); out.set(enc, 10);
  return rebuild(out);
}
function rebuild(b: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < b.length - 4; i++) { c ^= b[i]!; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  new DataView(b.buffer, b.byteOffset, b.length).setUint32(b.length - 4, (c ^ 0xffffffff) >>> 0);
  return 'CLQ1' + b64u.encode(b);
}
