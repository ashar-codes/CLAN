// Desktop trust state (main process only): identities from the OS keystore, PAKE-authenticated TLS pins enforced for
// both Node (undici/ws) and Chromium (renderer WSS), remembered sessions and teacher keys.
import type { Session } from 'electron';
import * as opaque from '@serenity-kit/opaque';
import { createHash, createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { keyFingerprint, type TlsBinding } from '@classroom/protocol';
import type { DeviceSigner, Transport } from '@classroom/client';
import { newEd25519, nodeSigner, pinnedTransport } from '@classroom/client/node';
import type { TeacherIdentity } from '@classroom/server';
import type { Keystore } from './keystore.ts';

export type PairedSession = { sessionId: string; url: string; title: string; binding: Pick<TlsBinding, 'certificate' | 'spkiSha256' | 'teacherPublicKey'>; savedAt: number };
export type TeacherTrust = 'first' | 'known' | 'changed';

const SESSION_MAX_AGE_MS = 24 * 60 * 60_000; // classroom certificates live 24 h

const readJson = <T>(p: string, fallback: T): T => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return fallback; } };

export class Trust {
  private keystore: Keystore; private dir: string;
  private pins = new Map<string, Set<string>>(); // host -> SPKI SHA-256 (base64)
  private transports = new Map<string, Transport>();

  constructor(keystore: Keystore, dataDir: string) { this.keystore = keystore; this.dir = dataDir; }

  /**
   * Chromium (renderer WebSocket) trust: for a host we paired with, accept ONLY the pinned SPKI — even a publicly
   * valid certificate is rejected. Hosts we never paired with get Chromium's normal verification.
   */
  installVerifyProc(s: Session) {
    s.setCertificateVerifyProc((req, cb) => {
      const pins = this.pins.get(req.hostname);
      if (!pins) return cb(-3);
      try {
        const spki = createHash('sha256').update(new X509Certificate(req.certificate.data).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
        cb(pins.has(spki) ? 0 : -2);
      } catch { cb(-2); }
    });
  }

  pin(url: string, spkiSha256: string) {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
    const set = this.pins.get(host) ?? new Set<string>();
    set.add(spkiSha256);
    this.pins.set(host, set);
  }

  // ---- identities ----
  device(): DeviceSigner {
    return nodeSigner(this.keystore.get('device-ed25519', () => newEd25519().privatePkcs8));
  }
  deviceFingerprint() { return keyFingerprint(this.device().publicKey); }

  async teacherIdentity(): Promise<TeacherIdentity> {
    await opaque.ready;
    // Separate keys by role: this Ed25519 key signs receipts; TLS keys are per session; OPAQUE setup is pairing-only.
    const pkcs8 = this.keystore.get('teacher-ed25519', () => newEd25519().privatePkcs8);
    const opaqueServerSetup = this.keystore.get('opaque-server-setup', () => opaque.server.createSetup());
    return { signingKey: createPrivateKey({ key: Buffer.from(pkcs8, 'base64'), format: 'der', type: 'pkcs8' }), opaqueServerSetup };
  }

  // ---- paired sessions (no secrets: certificate + pins + public keys) ----
  private sessionsFile() { return join(this.dir, 'paired-sessions.json'); }

  remember(s: PairedSession) {
    this.pin(s.url, s.binding.spkiSha256);
    const all = readJson<Record<string, PairedSession>>(this.sessionsFile(), {});
    const now = Date.now();
    for (const [k, v] of Object.entries(all)) if (now - v.savedAt > SESSION_MAX_AGE_MS) delete all[k];
    all[s.sessionId] = s;
    writeFileSync(this.sessionsFile(), JSON.stringify(all));
    // Receipt trust anchors outlive sessions (archived receipts must stay verifiable).
    const keys = new Set(readJson<string[]>(this.anchorsFile(), []));
    keys.add(s.binding.teacherPublicKey);
    writeFileSync(this.anchorsFile(), JSON.stringify([...keys]));
  }
  private anchorsFile() { return join(this.dir, 'paired-teacher-keys.json'); }

  /** A paired session's URL + pinned transport. Never re-pins: a session id always keeps the key it was paired with. */
  session(sessionId: string): (PairedSession & { transport: Transport }) | null {
    const s = readJson<Record<string, PairedSession>>(this.sessionsFile(), {})[sessionId];
    if (!s || Date.now() - s.savedAt > SESSION_MAX_AGE_MS) return null;
    this.pin(s.url, s.binding.spkiSha256);
    let t = this.transports.get(sessionId);
    if (!t) { t = pinnedTransport(s.binding); this.transports.set(sessionId, t); }
    return { ...s, transport: t };
  }

  lastSession(): PairedSession | null {
    const all = Object.values(readJson<Record<string, PairedSession>>(this.sessionsFile(), {})).filter((s) => Date.now() - s.savedAt < SESSION_MAX_AGE_MS);
    return all.sort((a, b) => b.savedAt - a.savedAt)[0] ?? null;
  }

  // ---- remembered teacher keys (per class name) ----
  private teachersFile() { return join(this.dir, 'known-teachers.json'); }

  teacherTrust(title: string, teacherPublicKey: string): TeacherTrust {
    const known = readJson<Record<string, string>>(this.teachersFile(), {})[title];
    if (!known) { this.trustTeacher(title, teacherPublicKey); return 'first'; }
    return known === teacherPublicKey ? 'known' : 'changed';
  }

  /** Explicit user decision only (first sight is recorded automatically; a change never is). */
  trustTeacher(title: string, teacherPublicKey: string) {
    const all = readJson<Record<string, string>>(this.teachersFile(), {});
    all[title] = teacherPublicKey;
    writeFileSync(this.teachersFile(), JSON.stringify(all));
  }

  /** Teacher keys this device obtained through a successful pairing (receipt trust anchors). */
  pairedTeacherKeys(): Set<string> {
    return new Set(readJson<string[]>(this.anchorsFile(), []));
  }
}
