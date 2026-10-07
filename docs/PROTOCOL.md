# Protocol (v1)

Source of truth: `packages/protocol/src/index.ts`. All inbound data is validated with zod.

## Discovery
DNS-SD service `_classroomlan._tcp`, TXT `{ v: "1", sid: <session uuid>, title: <class name> }`.
The join code is **never advertised**: a student's app sends the code to each discovered classroom and the one that
accepts it is the match (codes are verified server-side with throttling).

## HTTP
| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/info` | none | product/protocol/title probe |
| POST | `/api/join` | code | `{code, profile, protocol:1}` → `{memberId, token, status, classroom}` |
| GET | `/api/resources` | bearer | list (student: ready+available; teacher: all + per-student transfer states) |
| GET | `/api/resources/:id/content` | bearer | file bytes; Range/If-Range/ETag — see FILE_TRANSFER.md |
| GET | `/api/assignments` | bearer | student: assignments + own latest receipt; teacher: per-student status |
| POST | `/api/uploads` | bearer (student) | `UploadInit` → `UploadStatus` (idempotent on `idempotencyKey`) |
| GET | `/api/uploads/:id` | bearer (owner) | `UploadStatus` (current offset, receipt when complete) |
| PUT | `/api/uploads/:id` | bearer (owner) | raw bytes, `Content-Type: application/offset+octet-stream`, `Upload-Offset` |

Bearer routes require: valid unexpired token for **this** session, class not ended, and (students) status `approved`.
`401` = token invalid/expired/removed/blocked; `403` = pending student or wrong role; `404` = not found **or not yours**
(identical response for other-class, hidden, and nonexistent ids — no enumeration oracle). Ids are opaque UUIDs; no
filesystem path ever appears in a URL.

Join errors: `400 invalid`, `403 bad_code|blocked`, `410 ended`, `423 locked`, `429 throttled|too_many_pending`
(with `Retry-After`), `413` body over 16 KB.

## WebSocket `/ws`
First message must be `{t:"auth", token}` within 5 s. Then:

Client → server: `ping`; teacher-only `member.approve|reject|remove|block`, `class.lock`, `class.policy`, `class.end`,
`resource.available|remove|push`, `assignment.create|close`; student-only `transfer.state`.
Teacher-only messages from a student get `{t:"error", code:"forbidden"}`.

Server → client: `hello`, `pong`, `class.state`, `member.status`, `resources`, `assignments`, `resource.push`, `error`;
teachers also get `roster`, `timeline` and `stats` (active transfers, bytes/s, failures — every 1 s).
`resources`/`assignments` broadcasts are coalesced to at most one per 150 ms so 40 students reporting progress
don't flood the teacher UI.

Close codes: `4001` auth failed/expired, `4003` removed/rejected/blocked, `4004` class ended, `4400` malformed JSON.
Other closes are transient: the client reconnects with jittered exponential backoff (max 10 s) and re-authenticates
with the same token. A ping unanswered for 3 intervals forces a redial (dead Wi-Fi links may never deliver a TCP close).
Max WS message 64 KB.
