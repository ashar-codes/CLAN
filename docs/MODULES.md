# Modules

| Module | Kind | Owns (tables) | Public API (`index.ts`) | Events produced |
|---|---|---|---|---|
| events | core | `core_events`, `core_consumed` | `EventBus`, `defineEvent` | — |
| permissions | core | `core_grants` | `Permissions`, `Principal`, `Scope` | — |
| identity | core | `identity_users`, `identity_devices`, `identity_local` | `Identity` | — |
| resources | core | `resources_objects`, `resources_refs` | `ResourceStore` | ResourceAdded |
| search | core | `search_docs` (projection) | `SearchIndex` | — (consumes) |
| context | core | — | `ContextBroker` (AI Context API) | — |
| networking / sync / notifications | core contracts | — | interfaces in `core/contracts.ts` | — |
| clans | product | `clans_clans`, `clans_memberships`, `clans_classroom_sessions`, `clans_classroom_members` | `Clans`, `CAPABILITIES` | CLANCreated, MemberJoined |
| files | product | refs in `resources_refs` (module `files`) | `Files` | ResourceShared |
| notes | product | `notes_notes`, `notes_shares` | `Notes` | NoteCreated, NoteUpdated, NoteShared |
| saved | product | `saved_collections`, `saved_items`, `saved_shares` | `Saved` | SavedItemAdded, SavedItemChanged, SavedItemShared |
| diary | product | `diary_entries` | `Diary` | none (private) |
| reminders | product | `reminders_reminders` (+ recurrence, anchor, snooze, dismissed, fired) | `Reminders` | ReminderCreated, ReminderDue |
| courses | product | `courses_courses`, `courses_topics`, `courses_lectures`, `courses_lecture_topics`, `courses_links` (references only) | `Courses` | CourseCreated, CourseChanged, TopicCreated, TopicConfidenceChanged |
| tasks | product | `tasks_tasks`, `tasks_checklist`, `tasks_refs` | `Tasks` | TaskChanged |
| exams | product | `exams_exams`, `exams_topics`, `exams_refs` | `Exams` | ExamCreated (v2), ExamChanged |
| flashcards | product | `flashcards_decks`, `flashcards_cards`, `flashcards_reviews` | `Flashcards` (SM-2) | DeckChanged, FlashcardReviewed |
| study | product | `study_sessions` | `Study` (sessions) | StudySessionStarted, StudySessionEnded |
| assignments | product (projection) | `assign_seen` (member device's last host list); host reads `assignments`/`submissions` read-only | `Assignments` | — |
| agenda | product (read projection) | — | `Agenda` (Today, Semester Board, Course/Lecture/Exam/StudyContext) | — |
| share | product | — | `Share` (Share-to-CLAN) | — |
| screenshare | product (events) | `presentations` (server migration 6: control state only, never media) | `ScreenShareEvents` | PresentationRequested, PresentationApproved, PresentationDeclined, PresentationStarted, PresentationSourceChanged, PresentationStopped |
| chat | product | `chat_threads`, `chat_messages`, `chat_reactions`, `chat_cursors`, `chat_names`, `chat_me`, `chat_outbox` | `Chat` (host authority + member cache + Outbox) | MessageCreated, MessageEdited, MessageRemoved, ReactionChanged, ResourceSentToMember |
| capture | product | `capture_items` (pointers to canonical notes/links/files) | `Capture` | CaptureItemCreated |
| notifications | product (consumer) | `notify_notices`, `notify_prefs`, `notify_sent` | `Notifications` (core contract) | — (consumes MessageCreated, ReminderDue, StudySession*; `tick()` checks tasks/exams/sessions/cards due) |
| ai | product (reads via module APIs; writes only via accepted proposals) | `ai_settings`, `ai_sources`, `ai_chunks`, `ai_fts` (FTS5), `ai_vectors`, `ai_conversations`, `ai_turns`, `ai_proposals`, `ai_quizzes`, `ai_quiz_attempts`, `ai_paper_questions`, `ai_usage` | `AI` (run, preview, search, proposals, quiz, past papers, exam gaps) | — |
| recordings, whiteboard, profile | contracts only | — | `modules/contracts.ts` | — |
| classroom (legacy) | `@classroom/server` | `sessions`, `members`, `resources`, `assignments`, `uploads`, `submissions`, … | server API (hosts every CLAN type) | its own `events` log |

**Session capabilities** (who may do what in a live CLAN session) are in `@classroom/protocol` `capabilitiesFor(type, host|member)`
and enforced by the host server. **CLAN types → module capabilities** (`CAPABILITIES`): CLASSROOM files/notes/chat/screenShare/assignments/teacherAuthority ·
STUDY_GROUP and PROJECT_TEAM files/notes/chat/studyRoom/screenShare · FRIENDS files/chat · TEMPORARY files/notes/chat/expires
(must have `expires_at`; access ends then). Code asks `clans.has(id, capability)`, never `type === …`.
Chat: SEND_MESSAGE (all), SEND_FILES (members of non-Classroom types; the host uses SHARE_RESOURCE); direct conversations with
members need VIEW_MEMBERS, with the host never do. The host relay (`server/src/chat.ts`) uses `@clan/core`'s Chat through a
structural interface (see CHAT.md). Presentation capabilities: PRESENT, REQUEST_TO_PRESENT, MANAGE_PRESENTERS (defaults in MEDIA.md). Media runs behind
`MediaTransport`; only `renderer/world/media/livekit.ts` (client) and `server/src/media.ts` (host) know LiveKit.

Adding a module: `modules/<name>/index.ts` with `schema` (prefixed tables), a service class taking its collaborators, its
event definitions; register the schema in `SCHEMAS` and wire it in `openClan`.

## Legacy names

The product is **CLAN** (never expanded). These internal identifiers keep the old name because changing them would break
persisted data, signatures, installed apps or peers; none of them is shown to users.

| Identifier | Why it stays |
|---|---|
| `LEGACY_STORAGE_NAME = 'Classroom LAN'` (desktop `app.setName` before ready) | Keychain item `Classroom LAN Safe Storage` and the userData folder derive from it; renaming makes every stored key undecryptable (verified). The app switches to `CLAN` after the keystore is initialised. |
| `SERVICE_TYPE = 'classroomlan'` (mDNS `_classroomlan._tcp`) | Older clients discover by it. |
| `classroom-lan/*` signed payload `type` strings | Part of signed canonical bytes (receipts, manifests, endorsements, capabilities). |
| `@classroom/*` workspace packages, root package `classroom-lan` | Internal import paths only. |
| `app.classroomlan.desktop`, `app.classroomlan.student` | Bundle/application ids: changing them makes the OS treat it as a new app (lost keychain access, permissions). |
| Mobile Documents folder `Classroom LAN/` | Existing downloads and receipts live there. |
| SQLite tables `sessions`, `members`, `resources`, `assignments`, … and migrations 1–4 | Durable data; migrations are append-only. |
| `CLASSROOM_*` environment variables | Scripts and CI. |
| Device database file `teacher.db` | Existing installs keep their data; it now holds CLAN tables too. |
| `Classroom*` TypeScript symbols (`ClassroomConnection`, `ClassroomInfo`) | A classroom is still a real concept: the CLASSROOM CLAN type. |
