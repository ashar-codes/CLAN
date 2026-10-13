# BTC-2E UX audit

Baseline `843edef`, clean worktree; approximately 14.9 GiB free. BTC-1 packages/installed app, profiles, keys and other worktrees protected. No AGENTS.md or CLAUDE.md found in repository/ancestor instruction locations.

## Initial findings

- P0: full Electron second-member approval timeout; isolated six chat tests pass. Baseline controlled full rerun passed; final expanded regression is recorded in verification. Discovery advertisement != authenticated reachability; stage diagnosis remains open.
- Mobile Courses: creation/topic confidence only; missing edit/archive/restore/delete and topic rename/removal.
- Diary: previous mobile entries read-only; no per-entry removal domain API. Today draft does not clear when the selected record is absent.
- Mobile Notes: destructive action lacks confirmation; editor closes on failure, losing actionable state.
- Tasks/Exams: domain creation/update/status exists but actual deletion APIs absent.
- Flashcards: card removal exists; deck rename/removal absent.
- Study sessions: active/ended/planned lifecycle exists; stored-record deletion absent.
- Saved: mobile existing collections/items read-only; collection/item management APIs require audit.
- Courses archive cannot be restored through existing API. Topic removal detaches references, not underlying Notes/Files.
- Mobile forms embedded in long scrolling screens require keyboard-aware modal editing with persistent actions.
- Phone Home has Timetable shortcut but needs actual current/next summary using the shared engine.
- Core personal-sync child upserts require parent/identity collision review before exposing more lifecycle controls.

Detailed screen inventory: BTC_2E_FEATURE_MATRIX.md. Repairs and runtime evidence will be appended after validation; this initial inventory is not a PASS report.

## Implemented repairs

- Reliability: late actual discovery results can enter the existing bounded OPAQUE/pinned join attempt; deduplicated/capped candidates and monotonic deadline. Bonjour endpoint/TXT updates and expiry are processed. Original full-suite timeout was not reproduced on baseline: no claim that its exact historical cause is established.
- Core: owner-only lifecycle writes; child-parent identity collision rejection; deletion wins concurrent edit until explicit recovery; transactional dependent-row cleanup; protected file references, including sync removal.
- Desktop: contextual Study management for active/archived Courses, Tasks, Exams, decks, study records and reminders. Modal focus/escape handling, validation error retention and save/delete busy guards. Saved links/collections/files management; previous-date Diary editing and named deletion.
- Mobile: Course edit/archive/restore/delete, topic rename/remove; confirmed Note deletion; keyboard-aware editing sheet with fixed actions and unsaved-change warning; Task/Exam/reminder editing; deck/card and ended study record management; Saved links/collections/files management.
- Navigation: phone Study tab strip remains above independent content scroll; bottom bar stays inside the existing root safe area without duplicate bottom padding. Major edit sheets scroll fields separately from actions. Home current/next timetable uses the shared schedule engine, refreshes while active and on resume; no Diary preview added.
- Create forms: mobile Course/Topic/Task/Exam/Reminder/Deck/Card input is cleared only after a successful mutation; review state advances only after successful card grading. Capture filing retains its selection on failure.

## Remaining gaps

Mobile study tapes have no functional entry point. Complete rich-reference/attachment editing, all configuration-object lifecycles and comprehensive small-device/landscape/back-navigation unsaved-draft coverage remain incomplete. Existing fixed communication headers/actions are reused; no replacement signaling/media/control implementation. Physical OS permissions, devices and routers are not inferred from shared-source or CI results. The broad acceptance gate remains BLOCKED where any required path/evidence is missing.

Follow-up: personal board archive/restore/delete and lecture removal now have domain/desktop/mobile controls. Deleted board synchronization is fenced against concurrent drawing. Recording edits/deletes reject agents and active deletion; Files protects timeline/media references. New Electron lifecycle test additionally verifies actual lecture removal retaining a Note, and board create/rename/archive/restore/cancel/confirmed delete. Electron prompt-based renaming was replaced with real modal forms after runtime evidence showed it did not rename.

Native runtime finding: the Course creation button was not hittable with the iOS keyboard open. Shared Screen now uses supported native automatic keyboard insets on iOS and drag dismissal on both phone platforms. This supplements fixed-action editor sheets; the existing assertion is retained for the repeat.

Follow-up Windows CI exposed direct-conversation request processing after paint and a pagination anchor cleared by requestAnimationFrame before React necessarily committed. Direct requests now use the layout phase; pagination anchors are tied to the actual page commit/loading state. Task/Exam deletion now publishes the existing change event to remove stale search documents, tested through the real search API.

Android driver diagnostics found native accessibility reports of clipped children behind fixed Study and bottom tabs. Driver coordinates now respect actual scroll-ancestor bounds rather than guessed display percentages; assertions are unchanged. Native failures and reruns are retained separately in verification.

Native list usability: Course creation moved before the growing list; local name/code/instructor search makes a specific course manageable without traversing every older course. CLAN cleanup now retains recording timeline/media references as well as Course/Timetable/Task/Exam references, with real store/restart assertions.

Windows follow-up: direct-message visibility passed after the layout-phase fix, but pagination still shifted 415.5 px. The commit-tied anchor change is not claimed to resolve that platform failure. A controlled 1024×768 Mac reproduction passed, so narrow layout alone is not proven causal. A restarted outbox test DB was left open; registered for existing teardown close after Windows EPERM evidence.

Windows pagination fixture diagnosis: beforeY 781.90625 was measured before clicking brought the page-level control into view; resulting shift was -415.5 with fonts already loaded. Corrected measurement setup brings the control into view first and adds viewport bounds assertions. The original exact-message/<3 px anchor assertions remain unchanged. This is a verification precondition repair, not a claim of a new pagination defect fixed in production.

Search-retention follow-up: deleted flashcard text and study-tape title/timeline documents are invalidated through existing events. Authenticated personal-sync application also refreshes all timeline keys, so deleted or edited timeline text does not remain searchable on a linked device. Two-device signed fixtures cover timeline/card deletion and unchanged private ownership. This does not promise forensic erasure of immutable sync/audit history.

Verification outcome: the visible-anchor precondition repair passed all 22 Windows Electron tests and the original <3 px assertion; both Windows/Linux units passed. The earlier pagination failure is resolved as a fixture precondition issue, not presented as a production fix. The exact historical Mac join timeout remains unproven despite controlled green runs.
