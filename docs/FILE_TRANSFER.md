# File transfer (Milestone 2, over TLS since Milestone 2.5)

All endpoints below are served only on the HTTPS listener (TLS 1.3, pinned per-class certificate — see PAIRING_AND_TRUST.md).
The file domain (`resources.ts`, `assignments.ts`) did not change for 2.5; only the transport did. Range/If-Range/ETag,
`.partial` resume, backpressure, SHA-256 verification, idempotent resumable uploads and rate limits behave exactly as below
(all 39 Milestone 2 file/assignment tests pass unchanged over TLS, including the 100 MB resume after a TCP cut). TLS adds no
buffering: responses are still streamed; server RSS stays flat across scenarios (BENCHMARKS.md). Receipts are now signed.

Code: `packages/server/src/{storage,resources,assignments,server}.ts`, `packages/client/src/{index,node}.ts`,
desktop `apps/desktop/src/main/student.ts`, mobile `apps/mobile/src/transfers.ts`.

## Teacher → students (classroom files)

1. **Import.** The teacher picks files in a native dialog (main process). Each file is stream-copied into managed storage
   `<userData>/storage/resources/<uuid>` while hashed (SHA-256). The original name is metadata only; the stored name is
   an opaque UUID. Size is re-checked after copy (file changed while copying → rejected). Free disk is checked first.
2. **Listing.** Students receive `resources` over WebSocket (ready + available only); the teacher's list adds per-student
   transfer states and counts.
3. **Download.** `GET /api/resources/:id/content` with `Authorization: Bearer`.
   * Body is streamed from disk (`createReadStream` → counting transform → response), with Node backpressure. Never base64,
     never through WebSocket, never fully buffered (server RSS stays ~200 MB while serving 40 × 10 MB; see BENCHMARKS.md).
   * `Content-Length`, `Accept-Ranges: bytes`, `ETag: "<sha256>"`, `Repr-Digest: sha-256=:…:` (RFC 9530),
     `Content-Type: application/octet-stream`, `X-Content-Type-Options: nosniff`, RFC 5987 `Content-Disposition`.
   * **Range:** one range only (`bytes=a-b`, `bytes=a-`, `bytes=-n`). Anything else → `416` with `Content-Range: bytes */size`
     (deliberately stricter than RFC "ignore"). `If-Range` with a different ETag → full `200` (client restarts).
4. **Client (desktop/Node).** `downloadResource()` writes `<dest>/.partial/<id>.part` + `<id>.json` (expected SHA/size).
   On resume it re-hashes the existing partial, requests `Range: bytes=<have>-` + `If-Range`, appends, then verifies
   size + SHA-256 and atomically renames to a unique, sanitized final name (`name (1).pdf` — never overwrites). A partial whose
   recorded SHA differs from the current resource is discarded. A hash mismatch deletes the partial and reports `failed`.
   429 → waits `Retry-After` with jitter and retries.
5. **States** reported by students over WS (`transfer.state`): `not_started, queued, downloading, paused, verifying, completed, failed`
   (+ UI shows "resumed"). The server only accepts reports for resources visible to that student and clamps byte counts.
6. **Send to Everyone** sets `pushed` and inserts `queued` transfer rows for every approved student, then broadcasts
   `resource.push`; each student app enqueues a normal download (students joining later see `pushed: true` and queue it too).
   The teacher never pushes bytes per student.
7. **Remove** marks the resource `removed`, deletes the managed copy (path derived from the validated UUID only) and
   never touches students' downloaded copies or the teacher's original. Bytes locked by an open download on Windows
   are swept at next start.

Desktop downloads land in `~/Downloads/CLAN/<class>/` (`CLASSROOM_DOWNLOADS_DIR` overrides, used by tests).
"Open" is offered only for PDF, text/CSV/Markdown, images, audio/video and modern non-macro Office/ODF (`docx pptx xlsx odt odp ods`);
legacy/macro-enabled Office, executables, scripts, archives and unknown types are "Show in folder" only. A matching hash
proves integrity (the teacher's exact file), not safety. Concurrency per
student app: 2 downloads; queue beyond that.

## Students → teacher (assignment submissions)

Resumable, idempotent, tus-like protocol (no custom crypto, no base64):

1. `POST /api/uploads {assignmentId, fileName, size, sha256, idempotencyKey}` → `UploadStatus`. Checks: assignment in this
   session and open, individual mode, extension allowed, size ≤ assignment max, pending-upload cap, free disk.
   **Same `(student, idempotencyKey)` returns the existing attempt** — including the final receipt if it already completed.
   Same key with different file metadata → `409 key_reused`.
2. `PUT /api/uploads/:id` with `Content-Type: application/offset+octet-stream` and `Upload-Offset: n`. `n` must equal the bytes
   already received (else `409 {offset}`), or `0` to restart. Bytes stream to `storage/tmp/<uploadId>.part`. A dropped
   connection keeps what arrived; `GET /api/uploads/:id` returns the current offset. More bytes than declared → `413` and the
   attempt fails.
3. When `offset == size` the server (still holding the per-upload lock) re-hashes the temp file; mismatch → `422`, temp
   deleted, attempt `failed`. Match → atomic rename to `storage/submissions/<session>/<submission>/<sanitized name>`,
   submission row + upload state in one transaction, **server time** as `submittedAt`, `late` computed server-side.
4. Response contains the **Ed25519-signed receipt**; the client verifies it against the teacher key from pairing, then stores it in `<userData>/receipts/<submissionId>.json`, mobile in
   `Documents/CLAN/receipts/`. Resubmitting with a new key creates **version n+1**; nothing is overwritten.

Clients persist the idempotency key per intended submission (session + assignment + file + size) before uploading, so a
retry after a lost response or an app restart returns the same receipt. Desktop resumes from the server offset; **mobile
re-sends from byte 0** on retry (Expo's `uploadAsync` can't start mid-file) — still idempotent, just slower.

## Limits (defaults in `DEFAULT_LIMITS`, overridable via `ServerOptions.limits`)

| Limit | Default |
|---|---|
| Concurrent downloads, whole server / per student | 128 / 4 (excess → 429 + Retry-After) |
| Content requests per student per minute | 120 |
| Concurrent upload streams, whole server / per student | 32 / 2 |
| Unfinished uploads per student | 5 |
| Max submission size the teacher may set | 2 GiB (assignment default in UI: 50 MB) |
| Disk reserve that imports/uploads may not consume | 1 GiB |
| Files / assignments per session | 1000 / 200 |
| Transfer idle timeout (no bytes moving) | 60 s → socket destroyed, slot freed |
| JSON body / WS message | 16 KB / 64 KB |
| Unfinished pairing attempts per source address | 4 (`pairInflightPerSource`) |
| Reconnect challenges per address per minute | 30 |

There is no total-time limit on transfers (`requestTimeout: 0`), so large lecture videos on slow Wi-Fi are fine; only *idle* transfers are cut.
Open file descriptors are bounded by the concurrency caps (one fd per active transfer).

## Chunked, peer-assisted path (Milestone 2.75)
Large files (> 4 MB) with Peer Assistance on use the teacher-signed manifest (1 MiB chunks, chosen by benchmark) and the swarm
scheduler; chunks may come from peers or the teacher (Range requests on the same content endpoint). Each chunk is verified before
it is written at its offset in the same `.partial/<id>.part` file; a verified-chunk bitmap lives in the meta file. Small files and
teacher-only mode keep the streaming path above. Either path adopts the other's partial (verified prefix / hashed whole chunks).
Details: PEER_ASSISTED_MODE.md.
