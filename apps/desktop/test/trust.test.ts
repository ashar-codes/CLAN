// Desktop trust store (main process). Runs in plain Node: Trust only needs a keystore-like `get`.
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Trust, type PairedSession } from '../src/main/trust.ts';

const store = () => { const m = new Map<string, string>(); return { get: (k: string, c: () => string) => m.get(k) ?? (m.set(k, c()), m.get(k)!) } as never; };
const mk = () => new Trust(store(), mkdtempSync(join(tmpdir(), 'trust-')));
const sess = (over: Partial<PairedSession['binding']> = {}): PairedSession => ({
  sessionId: '0b6f1c8e-5b1a-4c55-9a8b-0f0e1d2c3b4a', url: 'https://192.168.1.20:5000', title: 'OS', savedAt: Date.now(),
  binding: { certificate: 'Q0E=', spkiSha256: 'pinA', teacherPublicKey: 'T'.repeat(43), ...over },
});

describe('desktop trust store', () => {
  it('teacher key: first sight recorded, same key known, different key flagged until explicitly trusted', () => {
    const t = mk();
    expect(t.teacherTrust('OS', 'A'.repeat(43))).toBe('first');
    expect(t.teacherTrust('OS', 'A'.repeat(43))).toBe('known');
    expect(t.teacherTrust('OS', 'B'.repeat(43))).toBe('changed');
    expect(t.teacherTrust('OS', 'B'.repeat(43))).toBe('changed'); // never silently replaced
    t.trustTeacher('OS', 'B'.repeat(43));
    expect(t.teacherTrust('OS', 'B'.repeat(43))).toBe('known');
  });

  it('a paired session never accepts a different pin or teacher key', () => {
    const t = mk();
    t.remember(sess());
    t.remember(sess()); // same identity again: fine
    expect(() => t.remember(sess({ spkiSha256: 'pinB' }))).toThrow(/different security identity/);
    expect(() => t.remember(sess({ teacherPublicKey: 'X'.repeat(43) }))).toThrow(/different security identity/);
    expect(t.lastSession()!.binding.spkiSha256).toBe('pinA');
  });

  it('receipt trust anchors survive session expiry', () => {
    const t = mk();
    t.remember({ ...sess(), savedAt: Date.now() - 25 * 60 * 60_000 });
    expect(t.lastSession()).toBeNull();
    expect(t.pairedTeacherKeys().has('T'.repeat(43))).toBe(true);
  });

  it('device identity is stable per keystore and differs across installs', () => {
    const a = mk(), b = mk();
    expect(a.device().publicKey).toBe(a.device().publicKey);
    expect(a.device().publicKey).not.toBe(b.device().publicKey);
  });
});
