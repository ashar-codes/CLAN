import { DatabaseSync } from 'node:sqlite';

// Append-only list. Never edit a shipped migration; add a new one.
export const MIGRATIONS: string[] = [
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
  // 2: classroom files + assignments (Milestone 2)
  `
  CREATE TABLE resources (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    original_name TEXT NOT NULL,
    safe_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT,
    added_at INTEGER NOT NULL,
    owner TEXT NOT NULL DEFAULT 'teacher',
    status TEXT NOT NULL CHECK (status IN ('importing','ready','failed','removed')),
    available INTEGER NOT NULL DEFAULT 1,
    pushed INTEGER NOT NULL DEFAULT 0,
    removed_at INTEGER
  );
  CREATE INDEX resources_session ON resources(session_id);
  -- Latest download state per student per resource, as reported by the student app.
  CREATE TABLE transfers (
    resource_id TEXT NOT NULL REFERENCES resources(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    state TEXT NOT NULL,
    bytes INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (resource_id, member_id)
  );
  CREATE TABLE assignments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    title TEXT NOT NULL,
    instructions TEXT NOT NULL,
    due_at INTEGER,
    allowed_ext TEXT NOT NULL,
    max_bytes INTEGER NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('individual','group')),
    created_at INTEGER NOT NULL,
    closed_at INTEGER
  );
  CREATE INDEX assignments_session ON assignments(session_id);
  -- In-flight / finished upload attempts. (member_id, idempotency_key) makes retries return the same result.
  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    assignment_id TEXT NOT NULL REFERENCES assignments(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    idempotency_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('uploading','complete','failed')),
    error TEXT,
    submission_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (member_id, idempotency_key)
  );
  -- Accepted submissions. Resubmitting creates a new version; nothing is overwritten.
  CREATE TABLE submissions (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    assignment_id TEXT NOT NULL REFERENCES assignments(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    device_id TEXT NOT NULL,
    upload_id TEXT NOT NULL UNIQUE REFERENCES uploads(id),
    version INTEGER NOT NULL,
    file_name TEXT NOT NULL,
    safe_name TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    submitted_at INTEGER NOT NULL,
    late INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'accepted',
    UNIQUE (assignment_id, member_id, version)
  );
  `,
  // 3: Milestone 2.5 — cryptographic device identity, signed receipts. Plaintext join codes are scrubbed and no
  // longer stored. UUID-based known_devices are deliberately NOT migrated into trusted_devices: a copyable UUID
  // never becomes cryptographic trust; those students simply need one approval again.
  `
  UPDATE sessions SET join_code = '';
  ALTER TABLE sessions ADD COLUMN teacher_key TEXT;
  ALTER TABLE sessions ADD COLUMN tls_spki TEXT;
  ALTER TABLE members ADD COLUMN device_key TEXT;
  ALTER TABLE members ADD COLUMN trust TEXT NOT NULL DEFAULT 'legacy';
  ALTER TABLE members ADD COLUMN token_issued_at INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE trusted_devices (
    course TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    public_key TEXT NOT NULL,
    full_name TEXT NOT NULL,
    roll_no TEXT NOT NULL,
    first_approved_at INTEGER NOT NULL,
    last_approved_at INTEGER NOT NULL,
    PRIMARY KEY (course, fingerprint)
  );
  CREATE INDEX trusted_devices_roll ON trusted_devices(course, roll_no);
  ALTER TABLE submissions ADD COLUMN receipt TEXT;
  `,
  // 4: Milestone 2.75 — data plane. Session transport settings live with the session (not with any process), and every
  // resource carries a teacher-signed manifest with per-chunk hashes.
  `
  ALTER TABLE sessions ADD COLUMN connectivity TEXT NOT NULL DEFAULT 'lan';
  ALTER TABLE sessions ADD COLUMN peer_assist INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE resources ADD COLUMN chunk_size INTEGER;
  ALTER TABLE resources ADD COLUMN manifest TEXT;
  `,
  // 5: CLAN sessions — any CLAN type is hosted by the same session machinery. Old rows are classrooms.
  `
  ALTER TABLE sessions ADD COLUMN clan_type TEXT NOT NULL DEFAULT 'CLASSROOM';
  ALTER TABLE sessions ADD COLUMN clan_id TEXT;
  ALTER TABLE sessions ADD COLUMN description TEXT NOT NULL DEFAULT '';
  ALTER TABLE sessions ADD COLUMN expires_at INTEGER;
  `,
  // 6: screen sharing — control state only (who presented what kind of source, when). Never media or window titles.
  `
  CREATE TABLE presentations (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    presenter TEXT NOT NULL,
    source TEXT NOT NULL CHECK (source IN ('screen','window')),
    audio INTEGER NOT NULL DEFAULT 0,
    started_at INTEGER NOT NULL,
    stopped_at INTEGER,
    stop_reason TEXT
  );
  CREATE INDEX presentations_session ON presentations(session_id);
  `,
  // 7: chat & capture — files can be sent to specific CLANmates (audience = their chat handles; NULL = the whole CLAN),
  // and members can share files through the same resumable upload protocol as submissions.
  `
  ALTER TABLE resources ADD COLUMN audience TEXT;
  ALTER TABLE resources ADD COLUMN shared_by TEXT;
  CREATE INDEX resources_sha ON resources(sha256);
  CREATE TABLE share_uploads (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id),
    member_id TEXT NOT NULL REFERENCES members(id),
    idempotency_key TEXT NOT NULL,
    file_name TEXT NOT NULL,
    size INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    target TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('uploading','complete','failed')),
    error TEXT,
    resource_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (member_id, idempotency_key)
  );
  `,
];

export type Db = DatabaseSync;

export function openDb(path: string): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export function migrate(db: Db, upTo = MIGRATIONS.length): number {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < upTo; v++) {
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
  return Math.max(version, upTo);
}
