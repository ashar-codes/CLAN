# BTC-2F — private Smart Timetable

Branch: `btc-2df-control-timetable`. Independent `timetable` domain and adapters; no RemoteControl dependencies.

## Implemented

Private local versions, explicitly selected active version per device, manual period editing, duplication, archive/restore and confirmed deletion with durable sync tombstones. Periods carry weekday, subject, optional Course ID, teacher, room, time, class/lab/break and notes. Versions carry semester, time zone, effective dates and original private image reference. Holidays and per-date cancellation/rescheduling merge without losing earlier corrections. Courses are never edited through Timetable.

The deterministic engine uses actual device time (or an explicit IANA zone), start-inclusive/end-exclusive comparisons, overlap, overnight periods, empty days and clock transitions. Fall-back repeated times use their first occurrence; nonexistent spring-forward times are flagged for correction, never guessed. Today/current/next and a weekly overview update at exact schedule boundaries, with at most 30-second clock-change detection and resume refresh.

PNG/JPEG imports are copied into the canonical private SHA-verified store, bounded to 15 MB/20 MP, and retain their originals. JSON schedule imports are strictly validated and bounded to 120 KB. SVG, arbitrary PDFs and unbounded document decoding are not supported. Original-image zoom/rotation affects the view only. Camera capture is available on phones through normal permission requests. No cloud OCR or AI upload.

macOS runs a small local Vision helper; iOS includes a small native Vision Expo module. Android/Windows currently show OCR unavailable and support full offline manual editing and image viewing. Recognition is conservative: readable weekday/time rows become editable candidates; ambiguous grids remain raw text/manual entry. Reviewed fields require explicit confirmation before applying and saving. Unknown subject/teacher/room fields are not fabricated.

Personal linked-device sync uses the existing encrypted/authenticated transport and preserve-conflict policy. Keep Both creates an inactive copy; active selection and notification ledger remain device-local. Timetable tables are explicitly excluded from CLAN host handover. No CLAN member or AI context provider receives private schedules automatically. Original images remain in private Files after timetable deletion.

Optional generic class reminders respect global permissions, quiet hours and bounded occurrence IDs. Mobile native local alarms are refreshed after edits, personal sync, preference changes and resume; cap 48 future requests within an overall 60-request budget. Desktop reminders use a durable duplicate-alert ledger and require the app/tray to remain running. Force-stop, long periods without refresh and OS policy remain limits. Change-notification subscriptions and automatic PDF/table-grid extraction are not implemented.

## Evidence at feature checkpoint

- PASS: eight deterministic domain tests covering boundaries, overlap, empty/break days, holidays/rescheduling, overnight/effective dates, time zones/DST, corrected extraction, manual CRUD, owner/AI isolation, database restart, sync validation, Course preservation, quiet hours, duplicate-safe reminders and bounded image formats.
- PASS: actual personal-device synchronization of timetable metadata and original image bytes; deletion/tombstones, inactive selection, offline conflicts and Keep Both convergence.
- PASS: real Electron manual CRUD/import, actual Mac Vision recognition, mandatory extraction review, original viewing and restart persistence.
- PASS: Android standalone bundled/native Gradle build; iOS simulator native Xcode build including Vision module.
- PASS: iOS simulator native timetable manual creation/selection/period restart persistence; one XCTest executed, not a zero-test build.
- Native Android UI initially exposed test taps into fixed bottom tabs and inaccessible long editor controls. The test driver now respects viewport bounds and native keyboard dismissal. Mobile editing uses a separate modal with persistent Save/Cancel controls. Final Android/iOS repeats are recorded in the combined verification document.
- NOT TESTED: physical iPhone/Android cameras, OS alarm delivery across lock/force-stop, Windows physical notifications and OCR across diverse real timetable photographs. Manual editing stays functional when OCR or permissions are unavailable.

Build Mac OCR with `sh native/timetable-ocr/build.sh`; Expo autolinking adds the iOS pod. Desktop packaging requires the local Mac OCR helper. No installer or physical IPA was produced in this stage.

## Acceptance

Core offline schedule, privacy, persistence and personal-sync gates pass. OCR is platform-specific and explicitly optional. Hardware notification/photo gates remain open. See [combined verification](BTC_2DF_VERIFICATION.md) for final software/native PASS, FAIL, SKIPPED and NOT TESTED results.
