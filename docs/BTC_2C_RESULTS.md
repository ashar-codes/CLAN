# BTC-2C — Group video and meeting screen sharing

See [verification](BTC_2BC_VERIFICATION.md) for the exact application commit, counts and platform evidence. BTC-2B and BTC-2C share one branch but retain independent feature results. No BTC-2D remote control, recording or installers were introduced.

## Meetings

The existing local LiveKit SFU and CLAN pinned TLS signaling gateway are reused. Audio/video meetings have explicit membership invitations, microphone/camera controls, actual participant video grids, audio-only participants, active speaker/quality status, fullscreen viewing, count/duration, raise hand, bounded meeting chat, organizer/host invite/remove/mute controls and leave/end cleanup. Muting never grants permission to force a participant's microphone on.

A phone can create an immediate room and invite approved members through an available desktop CLAN host. There is no phone-hosted SFU, future calendar scheduler, permanent meeting history, unauthorized recording or automatic media capture. Meetings and chat are session-scoped and capped; ongoing meetings are not migrated across host handover. Handover fences/terminates old media and users explicitly create/join a room on the new authorized host.

## Screen sharing

Desktop explicitly selects an offered screen/window using the existing main-process capture gate. Sources can be switched; Stop sharing and hangup/unmount stop publication and tracks. A visible sharing indicator is shown. Fullscreen and LiveKit adaptive subscriptions/dynacast reuse existing quality behavior. Deterministic changing patterns exist only behind the existing development-only `CLAN_TEST_CAPTURE` gate; packaged apps cannot select them.

Android/iOS receive and display meeting screens, including fullscreen. Phone screen broadcasting is accurately marked unavailable; no enabled decorative broadcast button is supplied. ReplayKit/MediaProjection broadcasting requires a later separately tested implementation. Native receive/publish media interoperability and physical OS capture permission revocation are not claimed by desktop/Node fixtures.

## Security contract

- CLAN bearer authentication runs inside pinned TLS. Every room action uses existing membership/capability rules and host-epoch fencing.
- Two-minute SFU join JWTs scope room, participant identity, microphone/camera/screen sources and immutable lease metadata. Server SFU secrets remain on the host. Audio rooms cannot publish camera tracks.
- The gateway validates JWT signature, exact expiry, room-join grant, current approved membership and active room lease before forwarding. Leave/remove/reinvite invalidates old leases even while their JWT remains cryptographically valid.
- Removal/leave increments a per-participant authorization generation: an in-flight credential request cannot resurrect access after reinvitation. A closed or security-failed SFU cannot restart within the old session.
- Existing connections are removed on revocation; rooms expire after two hours. Host authority is rechecked on mutations, gateway admission and the bounded three-second media sweep. A failed SFU revocation RPC closes the SFU rather than silently retaining access.
- Host blocking is enforced by the host; attendee-local blocking prevents their own participation. Room chat requires actual connected membership. Controls are limited to 60/minute per CLAN identity, text to 2,000 characters, chat history to 100 entries, invitations to eight and rooms to four. Duplicate message IDs are scoped to their author.
- WebRTC transport is encrypted (DTLS-SRTP). **Group media is not end-to-end encrypted against the SFU host.** The UI states this; no group E2EE claim is made.
- Capture cancellation is fenced and all platforms stop camera capture when backgrounded. The capture lease prevents accidentally transmitting into a direct call and meeting simultaneously.
