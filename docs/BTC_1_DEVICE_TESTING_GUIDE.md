# BTC-1 device testing guide

TEST / UNVERIFIED. Install using the supplied INSTALLATION-GUIDE.md, then complete these checks.

## Personal-device checklist

Use disposable test names/files and a common Wi-Fi first. For each row, tick exactly one result. Leave NOT TESTED if the hardware or permission is unavailable. A call “Delivered” means the intended recipient accepted it; a queued item must not show Delivered prematurely.

| Test | Expected result | PASS | FAIL | NOT TESTED |
| --- | --- | --- | --- | --- |
| Mac ↔ Windows | Join the same CLAN; chat and a small file work both ways | [ ] | [ ] | [ ] |
| Android ↔ Mac/Windows, apps open | Friend pairing, messages and notifications work; identity/safety numbers match | [ ] | [ ] | [ ] |
| Android background with Keep mode | Persistent notification remains; receive a new message without reopening | [ ] | [ ] | [ ] |
| Android locked with Keep mode | Receive a new message/notification while locked under permitted OS/network conditions | [ ] | [ ] | [ ] |
| Mac tray hidden | Enable Keep, close the window, send from phone; receive a notification; Open CLAN shows it | [ ] | [ ] | [ ] |
| Disconnect/reconnect | Queue text, voice note and file offer; reconnect; deliver automatically exactly once; accept file before bytes arrive | [ ] | [ ] | [ ] |
| Incoming/unanswered/offline call | Reachable call rings; unanswered ringing call is missed; offline attempt appears later as “did not ring” | [ ] | [ ] | [ ] |
| Voice notes and two-way call | Audio is heard both ways; hangup releases microphone; no unwanted capture | [ ] | [ ] | [ ] |
| Friend reconnect alert | Off by default; verified-friend opt-in alerts once, not repeatedly | [ ] | [ ] | [ ] |
| iPhone ↔ iPhone and iPhone ↔ Mac | Foreground pairing/chat/file/call work; reopening reconnects; no continuous suspended-LAN claim | [ ] | [ ] | [ ] |
| Android mobile Create CLAN | Create each type offline; see ownership, archive/restore, confirm owner delete; no false live-host state | [ ] | [ ] | [ ] |
| People/CLAN Radar | Only actual visible peers/CLANs appear; actions work; Invisible/blocking prevent access; no distance claims | [ ] | [ ] | [ ] |
| Router-free supported networking | Two Android phones use actual Wi-Fi Direct/Aware if supported; two iPhones test supported native peer networking | [ ] | [ ] | [ ] |
| Hotspot, no internet | Android hotspot peers join; messages/files work without internet | [ ] | [ ] | [ ] |
| QR invitations/animated transfer | Pair using real camera; radios disabled optical transfer reconstructs identical bytes | [ ] | [ ] | [ ] |
| Classroom/secure handover | Transfer hosting to linked computer; only current host writes; revoked host cannot continue | [ ] | [ ] | [ ] |
| Restart/update persistence | Notes, chats, friends, keys and files remain; pending items survive; do not clear storage | [ ] | [ ] | [ ] |

Physical delivery/call/radio tests for this revision remain yours to complete. The Redmi foreground service/persistent notification/wake lock and compatible in-place update were observed; those checks do not prove actual locked message delivery. User-reported prior Mac↔Android calls/voice notes predate this candidate.
