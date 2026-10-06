import { DatabaseSync } from 'node:sqlite';

// Append-only list. Never edit a shipped migration; add a new one.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    join_code TEXT NOT NULL,
    network_mode TEXT NOT NULL,
    join_policy TEXT NOT NULL DEFAULT 'approval',
    locked INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    ended_at INTEGER
  );
  CREATE TABLE members (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    device_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    roll_no TEXT NOT NULL,
    device_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected','removed','blocked')),
    token_hash TEXT NOT NULL UNIQUE,
    token_expires INTEGER NOT NULL,
    joined_at INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    UNIQUE (session_id, device_id)
  );
  CREATE INDEX members_session ON members(session_id);
  -- Devices the teacher has approved before, keyed by title (course) for the 'known' join policy.
  CREATE TABLE known_devices (
    course TEXT NOT NULL,
    device_id TEXT NOT NULL,
    full_name TEXT NOT NULL,
    roll_no TEXT NOT NULL,
    first_approved_at INTEGER NOT NULL,
    PRIMARY KEY (course, device_id)
  );
  -- Raw presence log; confirmed attendance is a separate (later) table.
  CREATE TABLE presence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    kind TEXT NOT NULL CHECK (kind IN ('connected','disconnected','reconnected')),
    ts INTEGER NOT NULL
  );
  CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    ts INTEGER NOT NULL,
    type TEXT NOT NULL,
    actor TEXT,
    data TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX events_session ON events(session_id, id);
  `,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: Db): number {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  return MIGRATIONS.length;
}
