# RC1 hardware gates

Use disposable accounts/data and the candidate hashes in the RC1 manifest. Record device, OS, build hash, time,
PASS/FAIL and a short sanitized symptom for every line. These gates are **not** satisfied by desktop responsive views
or the Android emulator. Follow the existing [teacher](../release/beta-v0.1.0/TEACHER_CHECKLIST.md) and
[student](../release/beta-v0.1.0/STUDENT_CHECKLIST.md) checklists for the full class exercise.

## Windows 10 and 11 (each)

1. On a clean Windows machine, check the installer SHA-256 with `Get-FileHash`, install, launch and confirm there are no
   debug windows, development endpoints or unexplained privilege prompts. The current installer is unsigned: record
   SmartScreen behavior; do not tell testers to disable system protection.
2. Create a CLAN, close/reopen it, approve and remove a student, exchange a file, chat and whiteboard text. Verify the
   firewall prompt, mDNS discovery and Direct helper consent. Confirm refusal of a revoked device.
3. Install the update over a disposable older build with the same identity; confirm local notes, Diary, CLAN data and
   device identity survive. Test an export and a supported rollback on a disposable profile. Uninstall and document
   what remains in the user profile. Inspect Event Viewer for crashes.

## Physical Android phone

1. Verify APK SHA-256 (`sha256sum` or `Get-FileHash`), package `app.classroomlan.student`, versionCode and signing
   certificate digest before installing. Use Android's normal install prompt.
2. Onboard; create a note and private Diary entry. Join a real LAN CLAN; add whiteboard text with the keyboard open,
   wait for host visibility, disconnect Wi-Fi, reconnect and check it appears exactly once. Repeat after host restart.
3. Exchange a file and chat, try background/foreground, battery saver, low memory and screen rotation. Check accessibility
   labels and focus order. Update in place and confirm profile, notes, Diary and device link survive. Record Android model,
   OS and radio/Wi-Fi details; measure battery and performance on that phone before making phone-performance claims.

## macOS DMG

1. Verify the DMG SHA-256, mount, drag CLAN to Applications and launch. Record Gatekeeper behavior; this ad-hoc build
   has no Developer ID/notarization. Do not bypass protections on a user's primary machine.
2. Exercise create/reopen CLAN, local study, sync link, file, chat, whiteboard and export. Inspect Console for crashes.
3. On a disposable profile, update over the previous build, check data/keychain identity and rollback only where the
   schema is compatible. Uninstall and document remaining profile data.

## Two-device classroom Wi-Fi

Use a real teacher laptop and student phone on the same classroom Wi-Fi. Record SSID class (not the private SSID),
client isolation, multicast support and IP family. Create a CLAN, discover/join/approve, then verify chat, file hash,
whiteboard text and reconnect after roaming, sleep and host restart. Repeat with internet disabled while LAN remains.
Confirm no precise location is shown and no cloud access is needed. Test removal/revocation and unauthorized whiteboard
edits. Run one session with at least two students before distribution.

## Direct Mode, supported hardware only

Record host/phone radio support first. With no infrastructure Wi-Fi, initiate Direct Mode, follow the OS network/BLE
permission prompts, join and exercise chat, file, whiteboard and reconnect. Check cleanup restores the prior network
state and does not leave a privileged helper running. Mark NOT TESTED on unsupported hardware, not PASS.

## iOS prerequisites

Full Xcode, CocoaPods, an Apple Developer team, the app/share-extension IDs, App Group and Hotspot Configuration
entitlement are required; see [beta readiness](BETA_READINESS.md#ios-handoff-phase-14-audit-not-built). Build and sign
on the Apple team machine, then test local-network permission, Keychain/SQLCipher, join, share extension and Direct Mode
on a physical iPhone. No iOS archive or physical-iOS result exists in this RC.
