# BTC-2B — Direct video and group audio

Branch: `btc-2bc-media`, based on BTC-2A documentation checkpoint `258f657d3ec867878236b38811947cfc9ffbae97` (including implementation `4b0ad6b`). Application evidence and final revision are recorded in [BTC-2B+C verification](BTC_2BC_VERIFICATION.md). No installers, existing installations, profiles, identities or signing keys were replaced. PRs #1–#4 remain draft and unmerged.

## Direct calls

The shared People CallEngine retains authenticated, recipient-verified signed signaling, call attempts and the original audio state machine. Audio and video use WebRTC DTLS-SRTP with no public STUN/TURN. A reserved video transceiver supports explicit camera upgrades without a new call. The answerer adopts the offered transceiver; streamless remote tracks are combined for rendering on Chromium and React Native. Camera permission is requested only after Start/Answer/Camera on. Camera off and hangup stop tracks. Late microphone/camera permission responses are fenced against cancelled/replaced calls.

Desktop offers camera selection where multiple cameras are enumerated. Phones offer front/back switching using the installed native WebRTC adapter. Camera capture stops on backgrounding; returning does not silently restart it. Existing Android foreground microphone policy remains in force. A shared capture lease prevents a direct call and a meeting publishing the microphone simultaneously.

Chat headers remain visible with independent message scrolling/composers. Audio/video actions invoke the real engine. The overflow menu provides contact details, search of loaded history, loaded shared files/media, device notification preferences and confirmed clear/end/remove actions. Search is explicitly limited to loaded messages; earlier pages can be loaded. Notification settings are device-wide, not a newly invented per-chat mute feature.

## Group audio

An approved participant with PRESENT capability or the CLAN host can create a meeting in an active CLAN; Friends and Study Groups reuse their existing capability policy. Classroom students ask the host. Phones initiate invitations and join an authorized **desktop-hosted SFU**; they do not embed an SFU. There is no standalone group outside a joined CLAN in this stage.

Each group has at most eight invited participants and eight SFU participants. The host supports at most four rooms; meetings expire after two hours. An explicit invite is required. Invitees can join, decline, leave and rejoin; declining removes the current invitation until reinvited. The organizer and CLAN host moderate. Leaving does not end a room for others; the organizer or CLAN host can explicitly end it. Removing an organizer from the CLAN ends their rooms. Closing/fencing the desktop host ends media.

Names, mute/connection status, active speaker, count/duration, local notifications and late joining use actual SFU/authorized-host state. Local blocking prevents joining a room containing a known blocked identity and causes an active client to leave; host blocking revokes the participant at the SFU. These client-side block preferences do not confer moderation power over other approved CLAN members.

## Scope and remaining evidence

Real Electron processes and a real locally hosted SFU were used. Test camera/tone/screen sources are deterministic; decoded non-silent samples and changing frames, not SDP alone, are asserted. Physical Mac/Windows/Android/iPhone camera/microphone interoperability, real network loss/roaming and hardware performance at eight participants require the next authorized hardware stage. Internet calls, TURN, APNs/FCM, public relay and push wake-up are not implemented here.
