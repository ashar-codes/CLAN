# Data model

Teacher database: `<userData>/teacher.db` (SQLite via `node:sqlite`, WAL, foreign keys on).
Migrations: append-only array in `packages/server/src/db.ts`, tracked with `PRAGMA user_version`, each run in a transaction.

Implemented (migration 1):

| Table | Purpose |
|---|---|
| `sessions` | one row per classroom session: title, join code, network mode, join policy, locked, start/end |
| `members` | a device's membership in a session: profile snapshot, status, **SHA-256 of** the session token, sliding expiry |
| `known_devices` | devices the teacher approved before, per course title (for the "auto-approve known" policy) |
| `presence` | raw connect / disconnect / reconnect log (not attendance) |
| `events` | append-only timeline/audit log |

Implemented (migration 2, Milestone 2):

| Table | Purpose |
|---|---|
| `resources` | classroom file metadata: original (display) name, sanitized name, MIME (informational), size, SHA-256, owner, status `importing/ready/failed/removed`, `available`, `pushed`. Bytes at `storage/resources/<id>` |
| `transfers` | latest student-reported download state per (resource, student) |
| `assignments` | title, instructions, due time, allowed extensions (JSON), max bytes, mode (`individual`; `group` reserved), closed time |
| `uploads` | every submission attempt: idempotency key (unique per student), declared name/size/SHA, state `uploading/complete/failed`, error, resulting submission |
| `submissions` | accepted submissions only: version (unique per assignment+student), stored relative path, size, SHA-256, server `submitted_at`, `late`, device id |

Migration 3 (Milestone 2.5):

| Change | Why |
|---|---|
| `sessions.join_code` set to `''` for all rows; no longer written | the code must not be persisted |
| `sessions.teacher_key`, `sessions.tls_spki` | which teacher key / TLS pin served the session (archive verification) |
| `members.device_id` now holds the **device key fingerprint** (pre-2.5 rows keep their UUID); `members.device_key` (raw Ed25519 public key), `members.trust` (`first/known/new_device/legacy`), `members.token_issued_at` | cryptographic identity, absolute token lifetime |
| `trusted_devices(course, fingerprint, public_key, full_name, roll_no, first_approved_at, last_approved_at)` | approved device keys per course (replaces UUID-based `known_devices`, which is kept but never consulted) |
| `submissions.receipt` | the signed receipt, stored verbatim at acceptance |

Existing archived classes stay readable; their members show `legacy` trust, and their submissions get a receipt signed by the
current teacher key the first time one is requested.

## Durable vs temporary

| Durable (archived on the teacher machine, survives restart; tested) | Temporary |
|---|---|
| sessions, members, presence, events | session tokens (30 min idle / 8 h absolute, die when the class ends); OPAQUE registration record, pairing attempts, challenges; TLS keys (memory only) |
| resource metadata + bytes (until the teacher removes the file) | throttle / rate-limit counters (memory) |
| assignments, submissions + files, uploads history | in-flight upload bytes in `storage/tmp` (swept at next start; the attempt is marked failed) |
| transfer state history | live transfer accounting (active count, bytes/s) |

Ending or restarting the teacher app ends the session: a restart creates a **new** session with a new code; the old
session's ids are not reachable through it (tested). Previous classes are listed on the teacher's start screen with a
"Submissions folder" link. Browsing an old session's data inside the app is the Milestone 9 archive.

Student devices (desktop): `keys/*.enc` (safeStorage-encrypted device key), `profile.json` (names only; a pre-2.5 `deviceId`
is kept as `legacyDeviceId` and ignored), `paired-sessions.json` (session id → URL, session CA, pin, teacher key; 24 h),
`paired-teacher-keys.json` (append-only receipt trust anchors), `known-teachers.json` (class name → teacher key),
`downloads.json`, `pending-uploads.json`, `receipts/*.json` (signed receipts). Teacher desktop additionally:
`keys/teacher-ed25519.enc`, `keys/opaque-server-setup.enc`. Mobile: device seed and profile in `expo-secure-store`; files under
`Documents/CLAN/`.

Student devices: desktop stores the profile + persistent random `deviceId` in `<userData>/profile.json`; mobile stores
them in `expo-secure-store`. Session tokens are held in memory only.
