# Study Engine

Non-AI, offline. Every module owns its own tables (see MODULES.md / DATA_MODEL.md); cross-module things are references.

## Course
A **Course** is the student's own structure: name, code, instructor, term, schedule, ordered **Topics** (each with the
student's own mark: Not started / Learning / Needs review / Confident), **Lectures** (title, date, topics, status, optional
classroom session id), and **references** (`courses_links`) to Notes, Files (Resource Store refs) and Saved items, each
optionally placed on a topic or lecture; files carry a kind (Lecture material, Past paper, Assignment, Book, Reference, Other).
Tasks, Exams and Decks point at a course from their own modules. Removing a reference never deletes the item; a deleted or
no-longer-visible item shows as “no longer available”. Shared material shows provenance (“Shared by <host> in <CLAN>”).

## Course ↔ Classroom
A Course **may link** a CLASSROOM CLAN (`clan_id`); it is never the CLAN. `Courses.linkClassrooms` gives every Classroom
you belong to one linked Course (idempotent: UNIQUE(owner, clan); an archived one is not recreated). It runs with
`syncClassrooms()` (startup, class start/end) and when a member joins a Classroom. Nothing of the CLAN is copied: its files
and notes stay in the CLAN until you link them, and the Course keeps working when the CLAN is offline or gone.

## Classroom assignments
Stay in the Classroom (authoritative). `modules/assignments` projects them: the host reads its classroom tables read-only;
a member device stores the last list the host sent (`assign_seen`, replaced wholesale) with its own receipt status
(submitted / late / missing). They appear in Today, the Course and the Semester Board marked **Classroom Assignment**, and
are never Tasks.

## Exams and the Exam Command Center
Exam = course, name, time, location, topics in scope, references, notes, status (Upcoming / Completed / Cancelled). A result
(grade, total, reflection) exists only if typed by the student. The Command Center shows: countdown, topics in scope split
into **remaining** and **covered** (= marked Confident), past papers, resources/notes/saved of those topics, decks and
“N cards due” (a count query), open tasks, recent sessions, reminders. The only readiness figure is
`readiness()` in `@classroom/protocol`: **“N of M topics marked Confident”**, with the full breakdown of the student's own
marks shown next to it. With no topics in scope there is no figure. Suggested reminders (1 week / 1 day before) are
created only when ticked.

## Reminders
Target any (module, id) — course, exam, task, file, saved item, note — or nothing. Recurrence none/daily/weekly/monthly,
computed in local wall-clock time from the first occurrence (`nextOccurrence`; monthly clamps to month end without
drifting). Done/dismiss closes a one-off or moves a recurring one to its next occurrence (missed ones are not replayed);
snooze delays only the current occurrence. `fire()` emits `ReminderDue` once per occurrence.

## Today and the Semester Board
`modules/agenda` is a read projection (no tables): tasks (overdue + due today), reminders, Classroom assignments due within
a week (missing ones for members, all for hosts), exams within two weeks, planned study today. The Semester Board shows the
same sources for a window (Agenda = 14 days, Week, Month; at most 62 days per query). Each item says which module and id
it opens.

## Study Sessions and Focus
Start (course, optional topic, goal, optional planned minutes, Focus on/off), see a timer and shortcuts (Notes, Course,
Flashcards, Tasks), end with an optional reflection. Stored: start, end, course/topic, goal, reflection — nothing about
keystrokes, windows or the mouse. One session at a time. A Focus session turns on Focus Mode (veil, quieter navigation) and
holds non-critical notices (your own reminders still ring); ending restores the previous state. No streaks, no penalties.
History (Study › History): sessions, minutes, topics and card reviews per course for 30 days, personal only.

## Knowledge Campus
Building = Course. **Floors = Topics** (solid = marked Confident, accented = Learning / Needs review). Lit windows = real
course activity this week (links added, linked notes edited). Roof flag = a real upcoming exam within 14 days. Kiosks =
linked files. Full (3D, lazy chunk), Reduced (2D towers) and List views read the same small view model.

## Notifications
Through the existing Notifications module: reminder due, task due within 24 h, exam within 24 h, planned study within
10 min, daily “cards due” (off by default). One notice per occurrence (`notify_sent`). The host app calls `tick()` once a
minute.

## AI boundary (not implemented)
`Agenda.courseContext / lectureContext / examContext / studyContext` return permission-aware references (ids, titles,
marks, counts). No summaries, generated cards, quizzes, plans or RAG exist.

## Mobile
The phone has its own Study screen (Today, Courses, Tasks, Exams, Cards, Session) over a local JSON document
(`apps/mobile/src/study`) using the same shared algorithms. Phone data stays on the phone (no desktop sync yet); a joined
Classroom's assignments are projected the same way. Typecheck + model unit test only; **device runtime UNVERIFIED**.

## Study Tapes and boards
A Study Session can start a recording (RECORDING.md) and a Course has Recordings and a Board (WHITEBOARD.md); both are
linked by reference, never copied.

## Known limits
No sync of study data between a person's devices. Presence never broadcasts Focus or study state (only your own beacon shows
it). Dates on the phone are typed (no picker). Lectures are not auto-created from class sessions.
