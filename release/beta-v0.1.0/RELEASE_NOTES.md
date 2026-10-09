# CLAN v0.1.0 — closed beta

CLAN is a local-network study and classroom app: everything runs between the devices on one Wi-Fi, with no accounts and
no cloud. This is the first build for a small group of real students and teachers.

## What to try
* **Classroom / Study group:** host with a 6-digit code, approve devices, chat (group, one member, direct), shared files
  with SHA-256 verification, assignments with signed receipts, whiteboard, screen presentation, recording (Study Tape).
* **Your own study space:** courses, topics, notes, tasks, exams, flashcards, Inbox, private Diary — all offline.
* **Your devices:** link phone and laptop with a code and approval; personal data syncs over the local network, with
  conflicts shown for you to choose. Diary syncs only if you turn it on.
* **Your data:** Me › Your data — export, import, back up now, show backups. Me › Beta feedback — save a local report.

## In this build (since the hardening phase)
* Installers: macOS arm64 DMG (ad-hoc signed), Windows x64 installer (built, unverified), Android arm64 APK (beta-signed,
  versionCode 1).
* Packaging fails loudly when a native helper (Bluetooth helper, Direct Network helper, screen-sharing server) is missing.
* Windows installer: per-machine install with local-subnet firewall rules for discovery (UDP) and screen sharing (UDP)
  in addition to the main TCP rule; uninstall removes them.
* Android: release builds are signed with the CLAN beta key (never the debug key) and refuse to build without it;
  the overlay permission (`SYSTEM_ALERT_WINDOW`) pulled in by the WebRTC plugin is blocked.
* iOS project: accurate camera/photo/microphone texts, no remote-push entitlement (CLAN has no push server), share
  extension version follows the app's.
* Packaged desktop builds ignore every test-only switch (downloads/export folders, upload throttle, test AI provider).
* macOS: personal-sync discovery (`_clansync._tcp`) declared for Local Network privacy.

## Before you start
Read `SETUP.md` (installing unsigned builds) and `KNOWN_LIMITATIONS.md` (what has and hasn't been tested). Use the
checklists to report results. **Phone uninstall deletes the phone's CLAN data.**
