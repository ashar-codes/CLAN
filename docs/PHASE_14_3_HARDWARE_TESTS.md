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

## Android (physical, Android 10+) and iOS (physical, iOS 16+)
1. Install a development build (`expo run:android` / Xcode); People tab present.
2. On a computer: Show my code → copy the code text to the phone (e.g. via a linked-device note) → People › Nearby ›
   Connect → verified. A wrong/edited code is refused.
3. Friend request from the phone; accept on the computer; phone shows the friend within seconds while the app is open.
4. Chat both ways; background the app for 2 min; computer sends; foreground → message arrives (no delivery while
   backgrounded — expected).
5. Files: computer → phone 200 MB (accept, progress, Share / Open after re-hash); phone → computer 50 MB (chunked
   upload, computer shows Verified, phone shows Verified). Low-storage refusal on the phone.
6. Expected gaps (record, do not fail): no camera QR, no voice recording/playback, no calls, no phone-to-phone.
7. iOS: Local Network permission prompt appears on first connect (NSLocalNetworkUsageDescription); deny → clear failure.
