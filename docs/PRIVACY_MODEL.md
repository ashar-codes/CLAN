# Privacy model

**Scopes**: every readable thing is in a person's **Personal Space** (`personal`, owner only) or a **CLAN** (`clan`, active
members only; removed members and expired TEMPORARY CLANs lose access at once). `Permissions.canRead` is the single check.

| Data | Default | How it becomes shared |
|---|---|---|
| Notes | private | owner shares into a CLAN with the `notes` capability → `notes_shares` reference (live, revocable) |
| Saved items | private | owner shares into a CLAN → `saved_shares` reference |
| Files | private or the CLAN they were added to | new Resource Store ref per scope |
| Reminders, courses, topics + marks, tasks, exams + results, flashcards + reviews, study sessions + reflections | private (owner only) | never shared. A course links a CLASSROOM CLAN by id only; references resolve through their own module's permissions (a CLAN file you lose access to shows as “no longer available”) |
| Classroom assignments in Today/Course | the member's own status | projection of what the host already sent this member (own receipt state only) |
| Capture Inbox | private | filing shares the canonical item into a CLAN (a reference); nothing is shared by capturing |
| Group messages | the CLAN's members | — (they are CLAN content; searchable in that CLAN's scope) |
| Direct messages | the two participants | **relayed and stored by the host** (it can read them; never called private or encrypted). Never shown, notified or indexed on the host device unless the host is a participant |
| Files sent to a person | sender + recipient | audience-checked on list, manifest and download; peers never carry them |
| Diary | private | **never**: no sharing, no search, no events with content, agents refused |
| Classroom history | the CLASSROOM CLAN's members | existing classroom rules still apply on the wire (assignments are teacher-only) |

**Search** (`search_docs`) is a projection filtered by the caller's scopes at query time; Diary can't be registered. Rebuildable.

**AI Context API** (`core/context.ts`; boundary only: no providers, no agent execution):
* An agent is a principal acting **on behalf of** one user with explicit scopes (`notes:read`, …). Missing scope → DENIED.
* Results are references + short excerpts the user could read anyway; every item's scope is re-checked.
* Diary is `private`: **DENIED** unless the user grants `ai → diary` (Me → Privacy). Grants can expire and are revocable.
  Even granted, only the owner's entries are returned.

Notifications show who and where, and message text only if the person turns previews on. Focus mode (manual, or a Focus
study session) alerts nobody except for your own reminders; held notices stay in the list. Study notices are conservative:
one per task due date (24 h before), one per exam date (24 h before), planned study 10 min before, reminders when due; the
daily “cards due” notice is **off** by default; suggested exam reminders (1 week / 1 day) exist only if ticked. No streaks.
Study history is personal (never compared, never published). Presence never includes study time.
Link titles are fetched from the linked site when online (the site learns the link was opened); media is never fetched.

Writes are user-only: agent principals cannot create or modify notes, saved items, reminders, diary entries or any study data.
Study reads by agents need `tasks:read` / `exams:read` / `flashcards:read` / `reminders:read`. Course/Lecture/Exam/StudyContext
(modules/agenda) are reference-only inputs for a later AI phase; nothing is generated. Phone study data stays on the phone.
