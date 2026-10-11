# Phase 14.3 A+B — hardware tests still owed (for Codex / a human tester)

Everything below is **NOT TESTED** on real hardware. Cloud runs covered Linux Electron (Xvfb, fake capture devices,
loopback + container LAN) and Node stand-ins for the phone's native transport. Record PASS/FAIL with OS + build.

Setup: two or more devices on the same Wi-Fi (also try a phone hotspot network, and a network with client isolation,
where discovery is expected to fail and QR should explain it). Development builds; never production signing keys.

## Desktop (macOS 13+, Windows 10/11; ideally one of each)
1. **First run** — Friends tab › Your profile shows the student’s name. Set University visible to Everyone. Save.
2. **Firewall prompts** — macOS “accept incoming connections” and Windows Defender prompts appear for CLAN once;
   allow on Private networks only. Note the exact wording.
3. **Discovery** — A: Nearby › Everyone nearby (1 h). B: A appears within ~10 s with only Everyone fields. A: Invisible →
   gone from B within ~1 min. A: Friends only → not shown to B (stranger).
4. **QR** — A: Show my code. B: Scan with camera (first use prompts camera permission on macOS) → “Connected … matched
   the code”, card shows ✓ verified. Also: photo of the code → Scan a picture. Then A: Make a new code; the old picture
   must now fail.
5. **Friends** — request, accept, decline, cancel outgoing, remove, block (B cannot message A; A sees Not sent), unblock.
   Safety numbers equal on both screens.
6. **Chats** — saved chat; temporary 1 h chat via Change terms… (B must accept); messages show “disappears in …”;
   set the clock forward / wait and confirm both sides delete them. Quit B, send from A (Sending…), relaunch B →
   delivered. Load earlier messages after > 50 messages. Clear history on B leaves A’s copy.
7. **Files** — 1 GB file: accept, progress, cancel mid-way, retry/resume after pulling the network cable or toggling
   Wi-Fi, Verified on both sides; preview a PNG/text; Save a copy; Open with… (Windows: chooser dialog; macOS: default app).
   Fill the disk to < file size → accept refuses with a clear message.
8. **Voice notes** — first use prompts microphone permission (macOS System Settings › Privacy › Microphone). Record 10 s,
   listen back, send; receiver plays, pauses, seeks, replays.
9. **Calls** — A calls B: ring, answer, two-way audio for 2 min, mute/unmute, hang up; call line in chat. Busy: C calls
   A while in a call → C sees “on another call”. Deny microphone → clear error, other side sees unavailable. Turn
   Wi-Fi off for 15 s mid-call → Reconnecting…, then ended if not back in 10 s. No answer for 45 s → Missed call.
10. **Restart** — reboot both; friends, chats, files and verified marks persist; messages still deliver (same port).
11. **Phase 14.2 regression** — host a Classroom, join from the other computer, share a file, whiteboard, move hosting
    between linked computers; nothing changed in those flows apart from tab names (My CLANs, Nearby).

## Android (physical, Android 10+) and iOS (physical, iOS 16+) — A+B items (still valid)
1. Install a development build (`expo run:android` / Xcode); People tab present.
2. On a computer: Show my code → copy the code text to the phone (e.g. via a linked-device note) → People › Nearby ›
   Connect → verified. A wrong/edited code is refused.
3. Friend request from the phone; accept on the computer; phone shows the friend within seconds while the app is open.
4. Chat both ways; background the app for 2 min; computer sends; foreground → message arrives (no delivery while
   backgrounded — expected).
5. Files: computer → phone 200 MB (accept, progress, Share / Open after re-hash); phone → computer 50 MB (chunked
   upload, computer shows Verified, phone shows Verified). Low-storage refusal on the phone.
6. (Superseded by C+D below: camera QR, voice notes, calls and phone-to-phone are now implemented.)
7. iOS: Local Network permission prompt appears on first connect (NSLocalNetworkUsageDescription); deny → clear failure.

---

# Phase 14.3 C+D — owed on real hardware (all NOT TESTED)

Build a development client with the native modules (`apps/mobile`: `npx expo prebuild` then `expo run:android` /
Xcode). The cloud Kotlin type-check (`apps/mobile/scripts/kotlin-check/check.sh`) is not a substitute: do a full Gradle
build and an Xcode build first and record warnings. Never use production signing keys for test builds.

For every test record: devices + OS versions, path shown in the UI (Same network / Wi-Fi Direct / Wi-Fi Aware / Apple
peer-to-peer), time to connect, messages/files OK, and the exact text of any failure.

## C1. Android ↔ Android, no router (two phones, Wi-Fi on, no access point joined, mobile data off)
1. Both: People › Nearby. Mode "While using CLAN". Grant "Nearby devices" (13+) / Location (≤ 12) when asked.
2. **Wi-Fi Direct**: both tap Wi-Fi Direct. Each sees "Someone nearby" (strangers) — A taps "Connect directly"; B accepts
   the system invitation. Expect "Connected directly (Wi-Fi Direct)". If B is Everyone Nearby, A sees B's public profile;
   if Friends only, A sees nothing more until a code is scanned. Scan B's code (Show my code) → verified → Add friend →
   accept on B → chat (text, a 20 MB file, a voice note) → call 2 min.
3. Turn Wi-Fi off on B for 20 s and back: A shows Reconnecting… then Connected (after re-forming the group); queued
   messages arrive once; the file resumes, not restarts.
4. **Wi-Fi Aware** (if both report support): both tap Wi-Fi Aware; friends connect automatically (no OS prompt); repeat
   chat/file/call. Phones without Aware must not show the button.
5. **Hotspot**: A taps Start a hotspot → B scans the Wi-Fi code (Join a hotspot) → system join prompt → both appear
   (friends automatically). Repeat chat/file/call. Stop hotspot → B shows Offline; messages queue.
6. Privacy: with a third phone in Everyone Nearby running a packet capture (or a modified build logging probes), confirm
   Friends-Only phones never complete a handshake with their real key to it (only throwaway keys).

## C2. Android ↔ Mac / Windows
1. LAN with internet disabled on the router: both on the same Wi-Fi → phone and computer find each other (friends
   automatically, strangers only if Everyone Nearby); chat, files both ways (computer→phone 200 MB; phone→computer
   50 MB), call 5 min.
2. No router: Android starts a hotspot; the computer joins it in OS Wi-Fi settings → same tests.
3. Or the computer hosts a CLAN Direct network (Windows) → phone joins via its QR → people links work on it.
4. Firewall prompts (macOS/Windows) appear once for the link port; record wording; deny → phone shows Failed with a reason.

## C3. iPhone ↔ iPhone and iPhone ↔ Android
1. Two iPhones, Wi-Fi + Bluetooth on, no network joined: People › Nearby on both. Expect discovery via Apple
   peer-to-peer (path shown "Apple peer-to-peer"); allow Local Network on first use. Chat, 50 MB file, voice note, call.
2. Lock one iPhone for 2 min: it becomes unreachable (expected); unlock → reconnects; queued messages arrive.
3. iPhone ↔ Android: Android starts a hotspot; iPhone scans the Wi-Fi code in CLAN → iOS join confirmation → both
   appear; repeat tests. (Wi-Fi Direct/Aware must not be offered on the iPhone.)
4. iPhone Personal Hotspot → Android joins in Settings → same tests.

## C4. Hotspot-only network and LAN with internet disabled — covered in C1.5, C2.1, C3.3/4. Also verify that a joined
CLAN hotspot (no internet) does not break the phone's other CLAN features until it leaves the hotspot.

## C5. Background / foreground / restart
1. Mode "While using CLAN": background the app → the other side shows Offline within ~45 s; foreground → reconnects.
2. Mode "Stay available in a session" (Android): with a chat open, lock the screen → notification "CLAN is connected to
   people nearby" with Stop; messages and an incoming call notification still arrive; end the session → notification
   disappears; tap Stop → session closes and mode returns to While using.
3. Same on iPhone: messages arrive only while CLAN is open (plus a short moment); an ongoing call continues locked.
4. Force-quit and relaunch: chats, files (resume), friends, presence recognition and settings persist.

## D1. Optical QR transfer with every radio off (airplane mode, Wi-Fi and Bluetooth off)
1. Phone → phone, public: 50 KB PDF, 250 KB photo. Receiver: QR transfer › Receive a public transfer → offer shows name,
   size, sender identity → Accept → completes → Save to Inbox / Share → byte-identical (compare SHA-256 in a file app).
   Try 2/4/6/8 frames per second; note the fastest reliable speed per device pair and the distance.
2. Private: receiver shows the receive code; sender scans it; a third phone filming the stream sees "private, for
   someone else" and cannot accept; the intended receiver gets the file.
3. Receipt: receiver shows the receipt; sender scans → "Received intact by …"; a receipt for another file is rejected.
4. Computer ↔ phone both ways (webcam); a printed/photographed single code via "Scan a picture" for profile/link codes.
5. Interruptions: cover the camera mid-transfer, then continue — it completes without restarting. Limit: a 3 MB file is
   refused with advice to use a direct connection.

## D2. Real two-way voice calls and microphone permissions
Desktop↔phone, phone↔phone: first call asks for the microphone; deny → caller sees "could not take the call
(microphone unavailable)"; allow → audio both ways 5 min, mute, hang up from either side, busy when a third device
calls, missed call after 45 s, network loss → Reconnecting → ended after 10 s. iPhone: locked during a call keeps audio.
Voice notes: record on iPhone, play on Android and desktop (and reverse); desktop-recorded notes on iPhone (AAC on
macOS/Windows expected to play; a WebM note from Linux will not — known limitation).

## D3. Pictures and linked devices
1. Set a picture on a phone; a friend sees it after the next connection; a stranger (Friends Only) never receives it.
2. Link the owner's phone and computer (Me › My Devices; try the new QR scan). Within a minute friends see "Your
   friends' other devices": compare the safety number with the device itself, Trust → that device is a friend; Not now
   → nothing changes.
