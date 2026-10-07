# Protocol (v1)

Source of truth: `packages/protocol/src/index.ts`. All inbound data is validated with zod.

## Discovery (untrusted hint)
DNS-SD service `_classroomlan._tcp` pointing at the **bootstrap** port, TXT `{ v: "1", sid: <session uuid>, title }`.
Nothing in it is trusted; the code is never advertised. See [PAIRING_AND_TRUST.md](PAIRING_AND_TRUST.md) for the full flow.

## Bootstrap listener (plaintext HTTP, OPAQUE only)
| Method | Path | Body | Response |
|---|---|---|---|
| GET | `/api/info` | — | `{product, protocol, title, sessionId}` (untrusted; only helps a manual-address client pick the OPAQUE user id) |
| POST | `/api/pair/start` | `{v:1, sessionId, startLoginRequest}` (OPAQUE KE1) | `{pairingId, loginResponse}` (KE2) |
| POST | `/api/pair/finish` | `{v:1, pairingId, finishLoginRequest}` (KE3) | `{binding, mac}` — `TlsBinding` + HMAC-SHA256(K_bind, JCS(binding)) |
| POST | `/api/pair/abort` | `{v:1, pairingId}` | `204` — honest client saw OPAQUE fail; counted as a failed guess |

OPAQUE: `@serenity-kit/opaque` 1.1, `userIdentifier = sessionId`, identifiers
`{client: "classroom-lan/v1/student/<sessionId>", server: "classroom-lan/v1/classroom/<sessionId>"}`, default key stretching.
`K_bind`, `K_join` = HKDF-SHA256(ikm = OPAQUE session key, salt = "classroom-lan/v1/pairing", info = "classroom-lan/v1 tls-binding mac" | "classroom-lan/v1 join-proof mac", 32 bytes).
`TlsBinding = {type:"classroom-lan/tls-binding", v:1, sessionId, pairingId, title, httpsPort, spkiSha256 (leaf SPKI, base64), certificate (session CA, base64 DER), teacherPublicKey (Ed25519 raw, base64url), challenge (32 B base64url), issuedAt, expiresAt}` (≤ 2 min).
Errors: `400 invalid`, `403 bad_code` (pairing failed — no other detail), `410 ended`, `423 locked`, `429 throttled|busy` + `Retry-After`.
**Nothing else is served on this port** (classroom routes → 404, no WebSocket).

## HTTPS listener (TLS 1.3; everything else)
| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/api/join` | OPAQUE MAC + device signature | `{v:1, pairingId, profile{fullName, rollNo, deviceName, devicePublicKey}, proof{mac, signature}}` → `{memberId, token, status, classroom}` |
| POST | `/api/reconnect/challenge` | — (rate-limited) | `{v:1, devicePublicKey}` → `{challengeId, challenge, expiresAt}` (60 s, single use, bound to that key) |
| POST | `/api/reconnect` | device signature | `{v:1, challengeId, devicePublicKey, signature}` → `{memberId, token, status, classroom}` for a device already in this session |
| GET | `/api/resources` | bearer | list (student: ready+available; teacher: all + per-student transfer states) |
| GET | `/api/resources/:id/content` | bearer | file bytes; Range/If-Range/ETag — see FILE_TRANSFER.md |
| GET | `/api/assignments` | bearer | student: assignments + own latest signed receipt; teacher: per-student status |
| POST | `/api/uploads` | bearer (student) | `UploadInit` → `UploadStatus` (idempotent on `idempotencyKey`) |
| GET | `/api/uploads/:id` | bearer (owner) | `UploadStatus` (current offset, signed receipt when complete) |
| PUT | `/api/uploads/:id` | bearer (owner) | raw bytes, `Content-Type: application/offset+octet-stream`, `Upload-Offset` |

Signed payloads (JCS, RFC 8785; Ed25519 over the UTF-8 bytes):
* join proof `{type:"classroom-lan/join-proof", v:1, sessionId, pairingId, challenge, deviceKeyFingerprint, fullName, rollNo, deviceName}` — also MACed with K_join;
* reconnect proof `{type:"classroom-lan/reconnect-proof", v:1, sessionId, challengeId, challenge, deviceKeyFingerprint}`;
* receipt payload `ReceiptPayload` (see PAIRING_AND_TRUST.md) → `{payload, alg:"Ed25519", signature, teacherPublicKey}`.
`deviceKeyFingerprint` = base64url(SHA-256(raw Ed25519 public key)).

Join/reconnect errors: `403 bad_proof` (MAC/signature/challenge invalid, expired or reused), `403 blocked|removed|rejected`,
`404 not_member` (reconnect for a device that never joined), `410 ended`, `423 locked`, `429`.

No CORS headers; JSON (`application/json`) and upload bytes (`application/offset+octet-stream`) only — `text/plain` → `415`.

Bearer routes require: valid unexpired token for **this** session, class not ended, and (students) status `approved`.
`401` = token invalid/expired/removed/blocked; `403` = pending student or wrong role; `404` = not found **or not yours**
(identical response for other-class, hidden, and nonexistent ids — no enumeration oracle). Ids are opaque UUIDs; no
filesystem path ever appears in a URL.

Bodies over 16 KB → `413`.

## WebSocket `wss://…/ws`
Origin policy: no Origin (native clients), `file://`/`null` (Electron renderer) or `http://127.0.0.1|localhost:*` (dev renderer); any other origin is refused at upgrade.

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

## Data plane (Milestone 2.75)

HTTPS (teacher), all bearer-authenticated, approved students only (teacher may read):

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/resources/:id/manifest` | teacher-signed `SignedManifest` (same visibility as the resource) |
| POST | `/api/peer/endorse` | `{v:1, tlsCa, tlsSpkiSha256, port}` → `PeerEndorsement` (409 if Peer Assistance is off) |
| POST | `/api/peer/capability` | → `PeerCapability` (15 min) |
| POST | `/api/peer/have` | `{v:1, resourceId, chunks: base64url bitfield}` (length must match the manifest) |
| POST | `/api/peer/stats` | `{v:1, uploadedBytes}` |
| GET | `/api/peer/sources/:id` | `{peerAssist, swarm, sources: [{fingerprint, url, endorsement, have}]}` |

Peer servers (HTTPS with the endorsed TLS identity; `Authorization: Peer base64url(JSON{capability, proof})`):
`GET /peer/v1/chunk/:resourceId/:index` (bytes), `GET /peer/v1/manifest/:resourceId`, `GET /peer/v1/have/:resourceId`.
`401` bad/expired/forged capability or proof, `403` revoked or other class, `404` unknown/not held, `429` busy/rate limited, `503` paused.

WebSocket additions: teacher `class.peerAssist {enabled}`; server → students `resource.seed {resourceId}`, `peer.revoked {fingerprints}`;
`class.state` carries `connectivity` and `peerAssist`; teacher `stats` adds `peers, peerUploadedBytes, peerBytesPerSec`.
Signed object formats: [PEER_ASSISTED_MODE.md](PEER_ASSISTED_MODE.md).

## Mobile OPAQUE bridge (Milestone 2.6)
App ↔ WebView messages (JSON strings via `postMessage`): `{id, op:'startLogin', password}` → `{id, ok, result:{clientLoginState: <handle>, startLoginRequest}}`;
`{id, op:'finishLogin', handle, loginResponse, password, identifiers}` → `{id, ok, result: {finishLoginRequest, sessionKey} | null}`;
`{id, op:'discard', handle}`. Anything else → `{ok:false, error:'unsupported operation'}`. Readiness: `{id:0, ok:true, result:'ready'}`.
