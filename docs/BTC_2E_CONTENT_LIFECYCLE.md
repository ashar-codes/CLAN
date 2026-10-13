# BTC-2E content lifecycle

Baseline `843edef`; repairs on `btc-2e-ux-completeness`. All destructive APIs act on the authenticated local owner; renderer/phone controls do not choose another owner. Named confirmations are UI safeguards, never substitutes for domain authorization.

| Entity | Management and deletion semantics | Sync / retention |
| --- | --- | --- |
| Course | Edit, archive, restore, delete active/archived; remove owned topic/lecture placements | Retained root identity prevents automatic classroom-course recreation and preserves independent board ownership. Deleted root is excluded from personal sync; engine emits durable tombstone. Independent CLANs, Notes, Files, Tasks, Exams, decks and study records remain. |
| Topic / lecture | Rename, confidence/status, remove own placement | Aggregate sync; course/topic-level references retained when removing a topic/lecture, underlying material never deleted. |
| Note | Create/edit/delete; mobile editor retains failed draft, named confirmation | Existing owner/shared permissions and preserve conflicts. Linked deletion uses tombstone; independently exported/copied content remains. |
| Diary | Select any date, open previous entries, edit, delete exact date | Private and excluded from shared/search/AI context by default; personal sync explicitly opt-in. Actual calendar-date validation; other days remain. |
| Timetable / periods | Existing create/edit/duplicate/archive/restore/delete | Private version aggregate and durable internal deletion; active selection local. Original file is retained while any live/archived version references it. Removing a timetable does not erase the library image. |
| Task | Edit/status/checklist/delete; canceled records reachable on phone | Delete own checklist/references atomically. Independent source material remains; personal tombstone. |
| Exam | Edit/status/delete | Delete own scope/reference rows atomically; independent Courses/material remain. Removing a Course leaves the exam manageable; course-dependent view availability is recorded separately. |
| Reminder | Edit text/time/recurrence, complete/dismiss/snooze/delete | One-off/recurrence behavior retained. Agent writes rejected. Text-only edits preserve fired/snooze state; rescheduling changes the occurrence. Target material retained. |
| Deck / card | Rename deck, edit cards, delete card/deck | Own card/review children removed transactionally; other decks/course material retained; personal sync. Reviews remain append-only during normal sync; causal deletion also fences concurrent union records. |
| Study record | Edit goal/reflection and delete non-active record | Active session must end/cancel first. Timestamps/durations are not rewritten by editing. Personal record sync; independent material retained. |
| Saved item | Edit title/note, move/share, delete | Remove own shares/item; remote website untouched; personal sync and preserve conflicts. |
| Collection | Custom create/rename/delete | Move items to Inbox before removing collection, including incoming sync deletion. Built-in Inbox/Watch Later cannot be removed/replaced through sync. |
| File | Scoped creator/active-CLAN-moderator removal with host fencing | Personal tombstones re-enter authorized removal. Refused while a Course/Timetable/Task/Exam/recording still references that stable ID. Independent resource references preserve bytes. Cleanup retains referenced CLAN files as personal references. |
| CLAN | Existing owner delete vs member local-copy removal, archive/restore/leave | Durable cleanup intent, ownership and host fencing retained. Offline disappearance is never deletion authorization. |
| Chat history | Existing local clear/remove/end | Other participant's independent copy remains. No claim of remote erasure. |
| Board | Create/rename/archive/restore/delete personal/course/session boards | Own drawing history is removed on delete; independent Notes/Files remain. CLAN boards cannot be renamed/deleted through personal APIs. Concurrent drawing cannot restore a deleted board. |
| Study tape | Existing recording/timeline/library management | Explicit user edits/removal; stop active recording before deleting. Referenced media/screenshots cannot be removed from Files while used. Mobile capture/playback remains unavailable. |
| Assignments / shared resources | Existing permission and module-specific capability rules | Teacher/member authority; no global purge or deletion of another user’s material. Complete rich reference editing is not declared finished. |

## Deletion conflicts

Ordinary stale/concurrent edits do not resurrect a deletion. Both devices keep the tombstone; a conflicting edit remains available for explicit recovery in My Devices. A deliberate conflict resolution carries causal history and can restore data. Concurrent union edits also respect deletion; ordinary drawing/review merging remains append-only. No device is removed because it went offline.

Sync aggregate child IDs cannot be moved onto another parent/owner by an incoming upsert. Duplicate/colliding IDs reject the transaction rather than overwrite an independent checklist/card/topic. Foreign-key rollback is tested.

## Evidence and limits

Domain lifecycle fixtures cover ownership, read-agent rejection, exact Diary deletion, calendar validation, active Study protection, independent references, collection migration, sync child collisions and protected timetable images. Authenticated two-device sync fixtures cover stale/concurrent deletion and explicit recovery convergence. Real Electron UI fixtures exercise named cancel/confirm flows, failed-save retention, archive/restore and restart. Native/CI results and unresolved coverage are in [verification](BTC_2E_VERIFICATION.md).

This is not a claim that every discoverable legacy screen has complete four-platform lifecycle parity. Unsupported paths and gaps remain in the feature matrix. Existing deleted-record metadata/audit retention is not forensic data erasure.

Mixed-version personal sync is not verified: the new deletion policy is tested with both peers on this BTC-2E source. Older clients may have different conflict behavior; BTC-2G must validate compatible upgrades on all linked devices before distribution. Mobile Note/Diary editors re-read current data before save and preserve a stale/deleted draft. Full online editing-race protection across every legacy editor is still incomplete.

Task and Exam deletion emits the existing change event inside the transaction so search removes the deleted document. Search disappearance is covered alongside dependent-row removal.

Search-retention follow-up: deleted flashcard text and study-tape title/timeline documents are invalidated through existing events. Authenticated personal-sync application also refreshes all timeline keys, so deleted or edited timeline text does not remain searchable on a linked device. Two-device signed fixtures cover timeline/card deletion and unchanged private ownership. This does not promise forensic erasure of immutable sync/audit history.
