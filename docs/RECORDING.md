# Study Tapes (recording)

`modules/recordings` (metadata + timeline) · desktop `main/tape.ts` (disk, recovery, playback scheme) ·
`renderer/world/tape/*` (recorder, indicator, player). Independent of screen sharing: LiveKit transmits, recording persists.

## Capture
Explicit action only, with a chosen source (screen or window; the source picker never offers CLAN itself). Optional
microphone (granted only for ~15 s after the student starts a tape with *Microphone* ticked; audio only) and system sound
where the platform supports it (Windows loopback; not offered on macOS/Linux). A persistent **Recording** indicator with
the clock and ⭐ 📝 📸 🔖 Stop stays on every screen until it stops. Test builds can record a deterministic canvas source
(`CLAN_TEST_CAPTURE=1`).

**Consent**: ticking "This captures other people" (default when recording from a room) requires confirming permission;
CLAN states it cannot know institutional or legal rules. Own-screen-only recordings are not nagged.

## Storage
MediaRecorder WebM (VP9/VP8 + Opus — open, plays in browsers/VLC), 1-second chunks streamed over IPC and appended to
`<userData>/recordings/<id>.webm.part` (memory does not grow with length). Stop → the file is hashed once and **moved**
into the Resource Store as a personal file (no second copy). SQLite holds only metadata (`rec_tapes`) and the timeline
(`rec_events`). Disk is checked before start (< 512 MB refused) and every 10 s (< 2 GB warns, < 512 MB stops and saves);
a write failure stops and keeps what was written; the source closing stops and saves; sleep/resume add markers; a crash
leaves the `.part`, finalized as *recovered* on next start (WebM is streamable, so it plays up to the last chunk).
Playback: `clan-media://<refId>` (Range-capable; only this person's readable media/image files). Seeking: MediaRecorder
WebM has no cue index, so the player lets Chromium scan once for the duration.

## Timeline
Important · Note · Screenshot (an explicitly captured frame → personal PNG Resource) · Bookmark · Marker, each at a
millisecond offset; editable and removable. *Create full Note* makes a Notes-module note referencing `clan://tape/<id>?t=ms`
(linked to the tape's lecture). Search indexes tape titles and each timeline entry (`tapeId:atMs`) — never media; a hit
opens the player at that moment.

## Integration
Course › Recordings, lecture rows show their Study Tape, Study › Study Tapes shelf; Study Session › Record (linked to
the session) and *End session* offers to end the recording; Quick Capture adds bookmark / note / screenshot while
recording; My Space desk shows the recording. Sharing into a CLAN is explicit and creates a file reference (no copy).

## AI / transcription
AI may use only the tape's timeline text, only when the student includes *Study Tapes* for a request (off by default),
labelled "No transcript exists". Summarize / Revision notes / Flashcards / Quiz / Key topics are shown unavailable until a
transcript exists. `TranscriptionProvider` (protocol) is the boundary; none ships. Audio/video is never sent anywhere.

## Performance (`PERF=1` E2E, deterministic 30 fps canvas source, M-series laptop, while a Study Session runs and notes are added)
| | CPU (all processes) | memory start → end (60 s) | file | write rate |
|---|---|---|---|---|
| 1280×720 | 8 % | 560 → 495 MB | 4.9 MB/min | 79 KB/s |
| 1920×1080 | 11 % | 668 → 563 MB | 4.9 MB/min | 79 KB/s |
Write path (`main/chunkWriter.ts`) is unit-tested: a ≈2-hour run of 1 s chunks streams in order with flat memory; a disk
failure stops cleanly, reports once and keeps what was written; disk-watch thresholds.
The synthetic source compresses far better than real screens; real-content size, multi-hour runs, low-end hardware,
real screen/window capture, microphone and system audio were **not measured** (no such hardware run).
