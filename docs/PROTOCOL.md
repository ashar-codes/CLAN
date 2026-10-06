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

Errors: `400 invalid`, `403 bad_code|blocked`, `410 ended`, `423 locked`, `429 throttled|too_many_pending`
(with `Retry-After`), `413` body over 16 KB.

## WebSocket `/ws`
First message must be `{t:"auth", token}` within 5 s. Then:

Client → server: `ping`, and teacher-only `member.approve|reject|remove|block`, `class.lock`, `class.policy`, `class.end`.
Teacher-only messages from a student get `{t:"error", code:"forbidden"}`.

Server → client: `hello`, `pong`, `class.state`, `member.status`, `error`; teachers also get `roster` and `timeline`.

Close codes: `4001` auth failed/expired, `4003` removed/rejected/blocked, `4004` class ended, `4400` malformed JSON.
Other closes are transient: the client reconnects with jittered exponential backoff (max 10 s) and re-authenticates
with the same token. A ping unanswered for 3 intervals forces a redial (dead Wi-Fi links may never deliver a TCP close).
Max WS message 64 KB.
