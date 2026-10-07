// Users and their devices. A device is identified by its Ed25519 key fingerprint (legacy classroom members without a
// key get a `legacy-device:` id). The local user owns this device's Personal Space.
import { randomUUID } from 'node:crypto';
import { tx, type Db, type ModuleSchema } from './db.ts';

export const identitySchema: ModuleSchema = {
  module: 'identity', prefix: 'identity',
  migrations: [`
    CREATE TABLE identity_users (id TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE identity_devices (device_id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES identity_users(id), public_key TEXT,
      added_at INTEGER NOT NULL);
    CREATE INDEX identity_devices_user ON identity_devices(user_id);
    CREATE TABLE identity_local (one INTEGER PRIMARY KEY CHECK (one = 1), user_id TEXT NOT NULL REFERENCES identity_users(id));
  `],
};

export class Identity {
  private db: Db; private now: () => number;
  constructor(db: Db, now = () => Date.now()) { this.db = db; this.now = now; }

  /** The person using this device (created on first use). */
  localUser(defaultName = 'Me'): string {
    const row = this.db.prepare('SELECT user_id FROM identity_local').get() as { user_id: string } | undefined;
    if (row) return row.user_id;
    return tx(this.db, () => {
      const id = this.createUser(defaultName);
      this.db.prepare('INSERT INTO identity_local (one, user_id) VALUES (1, ?)').run(id);
      return id;
    });
  }

  createUser(displayName: string): string {
    const id = randomUUID();
    this.db.prepare('INSERT INTO identity_users (id, display_name, created_at) VALUES (?, ?, ?)').run(id, displayName.slice(0, 80), this.now());
    return id;
  }

  /** The user behind a device, creating both on first sight. */
  userForDevice(deviceId: string, displayName: string, publicKey?: string): string {
    const hit = this.db.prepare('SELECT user_id FROM identity_devices WHERE device_id = ?').get(deviceId) as { user_id: string } | undefined;
    if (hit) return hit.user_id;
    return tx(this.db, () => {
      const id = this.createUser(displayName);
      this.db.prepare('INSERT INTO identity_devices (device_id, user_id, public_key, added_at) VALUES (?, ?, ?, ?)').run(deviceId, id, publicKey ?? null, this.now());
      return id;
    });
  }

  displayName(userId: string) {
    return (this.db.prepare('SELECT display_name n FROM identity_users WHERE id = ?').get(userId) as { n: string } | undefined)?.n ?? null;
  }
  rename(userId: string, displayName: string) {
    this.db.prepare('UPDATE identity_users SET display_name = ? WHERE id = ?').run(displayName.trim().slice(0, 80), userId);
  }
}
