// Long-lived secrets (device key, teacher signing key, OPAQUE server setup), encrypted with Electron safeStorage
// (macOS Keychain, Windows DPAPI, Linux libsecret/kwallet). Never silently stored in plaintext.
import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type KeystoreStatus = {
  /** Secrets are protected by the OS. */
  secure: boolean;
  /** Explicit, development-only plaintext mode (unpackaged builds + CLASSROOM_DEV_INSECURE_KEYSTORE=1). */
  insecureDev: boolean;
  /** Secrets that could not be decrypted and were regenerated this run (identity changed!). */
  regenerated: string[];
  error?: string;
};

export class KeystoreUnavailable extends Error {}

export class Keystore {
  readonly status: KeystoreStatus = { secure: false, insecureDev: false, regenerated: [] };
  private dir = join(app.getPath('userData'), 'keys');
  private cache = new Map<string, string>();

  constructor() {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    if (safeStorage.isEncryptionAvailable()) {
      this.status.secure = true;
    } else if (!app.isPackaged && process.env.CLASSROOM_DEV_INSECURE_KEYSTORE === '1') {
      this.status.insecureDev = true;
    } else {
      this.status.error = 'This computer has no secure key storage available (OS keychain). CLAN cannot protect its identity keys.';
    }
  }

  /** Returns the secret named `name`, creating it with `create()` on first use. */
  get(name: string, create: () => string): string {
    const hit = this.cache.get(name);
    if (hit) return hit;
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('bad key name');
    if (!this.status.secure && !this.status.insecureDev) throw new KeystoreUnavailable(this.status.error);
    const file = join(this.dir, `${name}.${this.status.secure ? 'enc' : 'insecure-dev'}`);
    let value: string | null = null;
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file);
        value = this.status.secure ? safeStorage.decryptString(raw) : raw.toString('utf8');
        if (!value) throw new Error('empty');
      } catch {
        // Keychain item lost / app re-signed / file corrupted. Keep the old file for forensics, start a new identity.
        renameSync(file, `${file}.unreadable-${Date.now()}`);
        this.status.regenerated.push(name);
        value = null;
      }
    }
    if (value === null) {
      value = create();
      writeFileSync(file, this.status.secure ? safeStorage.encryptString(value) : value, { mode: 0o600 });
    }
    this.cache.set(name, value);
    return value;
  }
}
