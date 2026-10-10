# Whiteboard

`modules/whiteboard` (store) · `protocol/whiteboard.ts` (object model, ops, reducer, wire) · `server/whiteboard.ts` (host relay).

## Boards
A board belongs to a **CLAN** (one per CLAN, keyed by CLAN id — survives *Host again*), a **Course**, a **Study Session** or
**Personal Space**. Tables: `wb_boards`, `wb_ops` (append-only log, `seq` per board, UNIQUE op id), `wb_snapshots`
(compacted state every 500 ops; rebuildable). The canonical board is the editable op log + objects, never an image.
Temporary CLAN boards are deleted when the Temporary CLAN ends. Personal/Course/Session boards are local to the owner.

## Objects and operations
Objects: stroke (points, optional pressure, highlighter), line, arrow, rect, ellipse, text, sticky, resource / note / link
cards (references only). Ops: `put`, `patch`, `del`, `restore` — each `{ id, obj, clock }`, small (strokes simplified,
≤ 1,500 points; client batches < 48 KB). Model: **per-field last-writer-wins map** ordered by (clock, author, op id);
visibility = latest put/restore vs latest delete. Idempotent (op id), order-independent (tested over shuffled arrivals),
replayable. The host additionally orders ops (`seq`) so clients resume with "everything after seq N"; far behind or new →
a compact snapshot, sent in ≤ 256 KB pieces. Undo/redo are inverse ops, so they sync like any edit. Optimistic local
apply + outbox; nacked ops trigger a resync to the host's truth.

## Wire (pinned WSS, host authority)
`wb.sync {since}` · `wb.ops {ops}` → `wb.ack` / `wb.nack` · `wb.op` (broadcast to viewers) · `wb.cursor` (ephemeral,
rate-limited) · `wb.wall {mode, takeover}` · `wb.memberEdit {on}` · `wb.state` / `wb.wall` to clients.

## Permissions
VIEW_WHITEBOARD · EDIT_WHITEBOARD · MANAGE_WHITEBOARD, enforced by the host on every op. Defaults: host all three;
CLASSROOM members view (the host may switch on *Students may draw*, stored with the board); STUDY_GROUP, PROJECT_TEAM,
FRIENDS, TEMPORARY members view + edit. Removed/blocked members lose access at once (socket closed, ops refused).
Cards: a `resource` must be a file **on this CLAN's table**; personal files are refused; note/link cards carry only the
title (and the link address) the person chose to place — never note content.

## The room wall
`RoomSurface` modes DEFAULT · SCREEN_SHARE · WHITEBOARD, one owner at a time (host state). Whiteboard over a live
presentation needs `takeover` by a board manager or the presenter ("Switch from Sara's screen to Whiteboard?"); it stops
the presentation cleanly, membership untouched. Presenting over the board needs the same explicit switch.

## Export
PNG (rendered from the objects, white background) and PDF (that PNG on an A4 page). Derived output only.

## Performance (`node tools/sim/bench-board.ts`; `PERF=1` E2E for rendering; M-series laptop)
| ops | host load | snapshot | client apply | join sync (WSS) | op → other member p50/p95 | render in view / whole board |
|---|---|---|---|---|---|---|
| 1k | 5 ms | 0.8 MB | 1 ms | 20 ms | 0.4 / 0.6 ms | 1.0 / 2.4 ms |
| 5k | 35 ms | 4.0 MB | 8 ms | 105 ms | 0.4 / 1.4 ms | 4.4 / 7.9 ms |
| 10k | 58 ms | 8.0 MB | 10 ms | 240 ms | 0.4 / 0.8 ms | 7.6 / 11.8 ms |
In-app board open (10k objects): 371 ms. Rendering is on change only, culled to the viewport (60 fps budget held at 10k).
Renderer heap could not be measured precisely (Chromium reports a quantised value). Strokes are 24-point test strokes.

## Mobile
Same reducer over the phone's class connection; demand-rendered canvas layers, one-finger tools, two-finger pan + pinch
zoom, pen / highlighter / eraser / select / sticky / undo, stylus force as pressure. Pending operations retain their
original IDs and retry until `wb.ack` or echoed `wb.op`; reconnection replays them after state sync. Host `wb.nack`
removes rejected IDs and requests authoritative state. Android emulator coverage is recorded in the beta evidence;
physical-device behavior remains unverified.

## Limits
No image thumbnails on cards (cards show name/type); no PDF page snapshots; pages beyond 0 exist in the model but have no UI;
a board can't be shared from Personal Space into a CLAN board; the phone's local author id may differ from the host's
chat handle (only affects tie-breaking of simultaneous same-field edits until the host's order arrives).
