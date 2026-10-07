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

## Durable vs temporary

| Durable (archived on the teacher machine, survives restart; tested) | Temporary |
|---|---|
| sessions, members, presence, events | session tokens (30 min idle expiry, die when the class ends) |
| resource metadata + bytes (until the teacher removes the file) | throttle / rate-limit counters (memory) |
| assignments, submissions + files, uploads history | in-flight upload bytes in `storage/tmp` (swept at next start; the attempt is marked failed) |
| transfer state history | live transfer accounting (active count, bytes/s) |

Ending or restarting the teacher app ends the session: a restart creates a **new** session with a new code; the old
session's ids are not reachable through it (tested). Previous classes are listed on the teacher's start screen with a
"Submissions folder" link. Browsing an old session's data inside the app is the Milestone 9 archive.

Student devices (desktop): `profile.json`, `downloads.json` (completed downloads per session+resource), `pending-uploads.json`
(idempotency keys of unfinished submissions), `receipts/*.json`. Mobile: the same files under `Documents/Classroom LAN/`
(profile in secure storage).

Student devices: desktop stores the profile + persistent random `deviceId` in `<userData>/profile.json`; mobile stores
them in `expo-secure-store`. Session tokens are held in memory only.
