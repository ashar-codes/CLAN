// Long-lived secrets (device key, teacher signing key, OPAQUE server setup), encrypted with Electron safeStorage
// (macOS Keychain, Windows DPAPI, Linux libsecret/kwallet). Never silently stored in plaintext.
import { app, safeStorage } from 'electron';
import { mkdirSync, readFileSync, writeFileSync, existsSync, openSync, closeSync, fsyncSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type KeystoreStatus = {
  /** Secrets are protected by the OS. */
  secure: boolean;
  /** Explicit, development-only plaintext mode (unpackaged builds + CLASSROOM_DEV_INSECURE_KEYSTORE=1). */
  insecureDev: boolean;
  /** Legacy status field. Existing unreadable secrets are never regenerated automatically. */
  regenerated: string[];
  error?: string;
};

export class KeystoreUnavailable extends Error {}

/** Chromium persists Windows' DPAPI-wrapped encryption key asynchronously.
 * Do not create durable identity ciphertext before that wrapping key is durable.
 * This never writes/replaces metadata, decrypts it, or regenerates existing identities. */
export async function waitForWindowsKeyMetadata(path: string, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  do {
    let fd: number | undefined;
    try {
      if (statSync(path).size > 4 * 1024 * 1024) throw new Error('Oversized key metadata');
      const value = JSON.parse(readFileSync(path, 'utf8')).os_crypt?.encrypted_key;
      if (typeof value !== 'string' || value.length > 4096) throw new Error('Key metadata is pending');
      const wrapped = Buffer.from(value, 'base64');
      if (wrapped.length <= 5 || wrapped.subarray(0, 5).toString() !== 'DPAPI') throw new Error('Key metadata is pending');
      // Windows FlushFileBuffers requires a writable handle. No bytes are changed.
      fd = openSync(path, 'r+'); fsyncSync(fd);
      return;
    } catch { /* Never log metadata or key material; Chromium may still be saving it. */ }
    finally { if (fd !== undefined) closeSync(fd); }
    if (Date.now() >= end) break;
    await new Promise(resolve => setTimeout(resolve, 50));
  } while (Date.now() <= end);
  throw new KeystoreUnavailable('Windows protected key metadata is not durable yet. CLAN has not replaced any identity. Retry after secure storage is available.');
}

export class Keystore {
  readonly status: KeystoreStatus = { secure: false, insecureDev: false, regenerated: [] };
  private dir = join(app.getPath('userData'), 'keys');
  private cache = new Map<string, string>();
  private metadataReady = process.platform !== 'win32';

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

  async ready() {
    if (this.status.secure && !this.metadataReady) {
      try { await waitForWindowsKeyMetadata(join(app.getPath('sessionData'), 'Local State')); }
      catch (error) { this.status.error = (error as Error).message; throw error; }
      this.metadataReady = true;
    }
  }

  /** Returns the secret named `name`, creating it with `create()` on first use. */
  get(name: string, create: () => string): string {
    const hit = this.cache.get(name);
    if (hit) return hit;
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error('bad key name');
    if (!this.status.secure && !this.status.insecureDev) throw new KeystoreUnavailable(this.status.error);
    if (this.status.secure && !this.metadataReady) throw new KeystoreUnavailable('Windows protected key storage is not ready. No identity was replaced.');
    const file = join(this.dir, `${name}.${this.status.secure ? 'enc' : 'insecure-dev'}`);
    let value: string | null = null;
    if (existsSync(file)) {
      try {
        const raw = readFileSync(file);
        value = this.status.secure ? safeStorage.decryptString(raw) : raw.toString('utf8');
        if (!value) throw new Error('empty');
      } catch {
        this.status.error = 'CLAN could not unlock an existing identity key. Its original file is preserved. Restore Keychain access or the matching secure backup before continuing.';
        throw new KeystoreUnavailable(this.status.error);
      }
    }
    if (value === null) {
      value = create();
      writeFileSync(file, this.status.secure ? safeStorage.encryptString(value) : value, { mode: 0o600, flag: 'wx', flush: true });
    }
    this.cache.set(name, value);
    return value;
  }
}
