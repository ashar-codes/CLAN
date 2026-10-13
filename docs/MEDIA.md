# Media (screen sharing)

```
 Presenter app ──capture──▶ livekit-client ──DTLS-SRTP (UDP, CLAN interface only)──▶ ┐
                                                                                      │  Host: LiveKit SFU v1.13.9
 Viewer apps ◀──────────── DTLS-SRTP ─────────────────────────────────────────────── ┘  (child process, lazy)
       │ signaling: wss://host/media/* (existing pinned TLS) ─▶ Fastify proxy ─▶ ws://127.0.0.1:<port> (loopback only)
       │ control:   WSS present.* messages + POST /api/media/token  (CLAN auth required)
```

* **SFU, not a file swarm.** The presenter uploads one stream to the host; the host forwards it to every viewer. Peers never
  relay media (unlike peer-assisted files). Host outbound grows with viewers; the presenter's does not.
* **Behind `MediaTransport`** (`@classroom/client`). Product code (rooms, Beacons, wheel) never imports LiveKit;
  `apps/desktop/src/renderer/world/media/livekit.ts` is the only implementation and is a lazily loaded chunk.
* **Local only.** Bundled binary (`native/livekit/fetch.sh`: pinned SHA-256 release for Windows/Linux, built from the tagged
  source on macOS). No LiveKit Cloud, no STUN/TURN, no external IP lookup; works with the WAN unplugged.
* **Lifecycle** (`MediaService`, host side): started on the first token request; free ports chosen per start; config written
  0600 and deleted once ready; pid file for stale-process cleanup at next launch; one automatic restart after a crash
  (presentation stops with `media_failed`, viewers see the wall return); killed (SIGTERM → SIGKILL) when the CLAN ends or
  the app quits. Sleep/network change: clients reconnect; the presenter has a 20 s grace (`reconnecting`) before the
  presentation is stopped.

## Presenting

| CLAN type | Members | Host |
|---|---|---|
| CLASSROOM | REQUEST_TO_PRESENT (policy "after asking") | PRESENT, MANAGE_PRESENTERS |
| STUDY_GROUP, PROJECT_TEAM, FRIENDS, TEMPORARY | PRESENT (policy "freely") | + MANAGE_PRESENTERS |

* Server-enforced: request → host Allow/Decline → approved member may start once. One presenter at a time; a second attempt
  gets `busy` ("Sara is currently presenting"); a manager can "Stop Sara and switch". The host can stop anyone.
* Publish rights live on the SFU: tokens are subscribe-only; the host grants `canPublish` to the presenter's identity when
  the presentation starts and revokes it when it stops. A viewer that tries to publish is refused by the SFU (tested).
* Desktop picker: screens and windows with thumbnails (CLAN's own windows excluded); the display-media handler grants only
  the source the user explicitly picked, otherwise denies. Switching source replaces the track without ending.
* Quality profiles: Text (1080p, 8 fps, detail), Motion (720p, 30 fps), Auto (1080p, 15 fps); VP8 simulcast
  (360p + 720p layers), adaptive stream + dynacast. Codec is shown in Diagnostics only.

## Audio and permissions by platform

| | Screen | Window | System audio | Permission |
|---|---|---|---|---|
| macOS | ✓ | ✓ | not offered | Screen Recording (System Settings → Privacy & Security); picker shows instructions when denied |
| Windows | ✓ | ✓ | ✓ loopback (whole system) | none |
| Linux | best effort, untested | best effort, untested | not offered | Wayland needs the PipeWire portal (untested) |
| iOS / Android | — | — | — | viewing only; presenting is a later feature |

Microphone is never captured. Frames are never stored, thumbnailed for analytics or recorded; picker thumbnails exist only
in memory while the picker is open.

## Viewing

The room wall is the media surface (`RoomSurface`: DEFAULT / SCREEN_SHARE; WHITEBOARD and DOCUMENT_PRESENTATION reserved).
Controls: Fullscreen (and double-click), Fit / Actual size, Mute (when audio), quality indicator, Leave view, Escape.
Presenter: bar with "You are presenting", Switch source, Stop. Minimal experience mode shows the surface without the room.

**Mobile (viewing):** `apps/mobile/src/media` implements the subscribe side with `@livekit/react-native` and WebRTC.
LiveKit's binary signaling runs through the pinned native socket, which carries binary frames in Kotlin and Swift. A
`WebSocket` shim routes only registered CLAN hosts there and refuses unpinned `wss://<ip>`. Controls: fit, fullscreen
(requests the sharp layer), quality dot, reconnecting, Leave view. Verified on the Android emulator watching a desktop
presentation, including a network drop and resume; iOS is not built. Phones don't present; ReplayKit / MediaProjection
are a later feature.

## Direct Mode

Architecturally identical: the SFU binds to whichever interface carries the CLAN (Direct hotspot or LAN). Not run on a
Direct network yet.

## Airtime caveat

On one access point every viewer's copy crosses the same radio channel: 20 viewers × ~2–3 Mb/s is 40–60 Mb/s of airtime on
top of everything else. The SFU removes the presenter's uplink as the bottleneck; it does not add Wi-Fi capacity. Lower
quality profiles and simulcast help. See BENCHMARKS.md (simulated only).

## BTC-2B+C extension

Personal video retains signed People signaling and the direct CallEngine, with reserved/adopted video transceivers and native capture adapters. Group rooms reuse MediaService and the pinned `/media` gateway; authenticated room actions live at `/api/meetings`. See [BTC-2B](BTC_2B_RESULTS.md), [BTC-2C security/lifecycle contract](BTC_2C_RESULTS.md) and [test evidence](BTC_2BC_VERIFICATION.md). Short-lived leased tokens and current membership fence admission, while removal and host fencing terminate existing sessions. Group transport is DTLS-SRTP, not host-blind E2EE. Phones join available desktop SFUs and receive screens; phone broadcasting is unsupported.
