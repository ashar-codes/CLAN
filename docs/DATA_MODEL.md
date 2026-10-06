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

Planned tables (files, transfers, assignments, submissions, chat, polls, attendance, whiteboard, recordings,
sync_outbox, …) are added by later migrations as each milestone lands.

Student devices: desktop stores the profile + persistent random `deviceId` in `<userData>/profile.json`; mobile stores
them in `expo-secure-store`. Session tokens are held in memory only.
