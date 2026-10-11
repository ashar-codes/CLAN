// Composition root: the only place that knows every module. Modules receive their collaborators here and talk to each
// other only through public APIs (modules/<name>/index.ts), events and the core services.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { migrateModules, tx, type Db, type ModuleSchema } from './core/db.ts';
import { EventBus, eventsSchema } from './core/events.ts';
import { Identity, identitySchema } from './core/identity.ts';
import { Permissions, permissionsSchema } from './core/permissions.ts';
import { ResourceStore, resourcesSchema } from './core/resources.ts';
import { SearchIndex, searchSchema } from './core/search.ts';
import { ContextBroker } from './core/context.ts';
import { Clans, schema as clansSchema } from './modules/clans/index.ts';
import { Files } from './modules/files/index.ts';
import { Notes, schema as notesSchema } from './modules/notes/index.ts';
import { Saved, schema as savedSchema } from './modules/saved/index.ts';
import { Diary, schema as diarySchema } from './modules/diary/index.ts';
import { Reminders, schema as remindersSchema } from './modules/reminders/index.ts';
import { Share } from './modules/share/index.ts';
import { Chat, schema as chatSchema } from './modules/chat/index.ts';
import { Capture, schema as captureSchema } from './modules/capture/index.ts';
import { Notifications, schema as notifySchema } from './modules/notifications/index.ts';
import { Courses, schema as coursesSchema } from './modules/courses/index.ts';
import { Tasks, schema as tasksSchema } from './modules/tasks/index.ts';
import { Exams, schema as examsSchema } from './modules/exams/index.ts';
import { Flashcards, schema as flashcardsSchema } from './modules/flashcards/index.ts';
import { Study, schema as studySchema } from './modules/study/index.ts';
import { Assignments, schema as assignmentsSchema } from './modules/assignments/index.ts';
import { Agenda } from './modules/agenda/index.ts';
import { AI, schema as aiSchema, type ProviderSettings } from './modules/ai/index.ts';
import { Whiteboard, schema as whiteboardSchema } from './modules/whiteboard/index.ts';
import { Recordings, TapeChanged, schema as recordingsSchema } from './modules/recordings/index.ts';
import { PersonalSync, profileProvider, schema as syncSchema } from './modules/sync/index.ts';
import { HostAuthority, schema as hostingSchema } from './modules/hosting/index.ts';
import type { AIProvider } from '@classroom/protocol';

export const SCHEMAS: ModuleSchema[] = [eventsSchema, permissionsSchema, identitySchema, resourcesSchema, searchSchema, clansSchema, notesSchema, savedSchema, diarySchema, remindersSchema, chatSchema, captureSchema, notifySchema,
  coursesSchema, tasksSchema, examsSchema, flashcardsSchema, studySchema, assignmentsSchema, aiSchema, whiteboardSchema, recordingsSchema, syncSchema, hostingSchema];

export type ClanApp = ReturnType<typeof openClan>;

/** Opens CLAN on an existing SQLite handle (the device database). `storageDir` holds Resource Store objects. */
/** `aiProvider`: the host turns non-secret provider settings into a provider (reading the credential from its secure storage), or null. */
/** `freeBytes`: free disk space for incoming synced files (the host knows its volume). */
export function openClan(db: Db, opts: { storageDir: string; now?: () => number; localName?: string; aiProvider?: (s: ProviderSettings) => AIProvider | null; freeBytes?: () => Promise<number> }) {
  const now = opts.now ?? (() => Date.now());
  migrateModules(db, SCHEMAS);
  const bus = new EventBus(db, now);
  const identity = new Identity(db, now);
  const clans = new Clans(db, bus, identity, now);
  // Persistent hosting authority (signed epochs). Not yet used by any host path; see docs/PHASE_14_2_HOSTING_DESIGN.md.
  // Linked-device owner anchors: only verified, unrevoked devices of this personal account (never the current device).
  const hosting = new HostAuthority(db, clans, { now, dir: join(opts.storageDir, 'hosting'), me: () => me, linkedDeviceKey: (key) => sync.devices().some((d) => d.publicKey === key && !d.revoked && !d.current) });
  const permissions = new Permissions(db, clans, now);
  const store = new ResourceStore(db, bus, opts.storageDir, now);
  const files = new Files(db, bus, store, permissions, clans);
  const notes = new Notes(db, bus, permissions, clans, now);
  const saved = new Saved(db, bus, permissions, now);
  const diary = new Diary(db, now);
  const reminders = new Reminders(db, bus, now);
  let me = '';
  const local = () => me;
  const chat = new Chat(db, bus, permissions, now, local, (clanId) => !clans.cleanup(clanId));
  const courses = new Courses(db, bus, { clans, notes, files, saved, identity }, now);
  const tasks = new Tasks(db, bus, courses, (c, u) => clans.isActiveMember(c, u), now);
  const exams = new Exams(db, bus, courses, now);
  const flashcards = new Flashcards(db, bus, courses, now);
  const study = new Study(db, bus, courses, now);
  const assignments = new Assignments(db, clans, now);
  const agenda = new Agenda({ tasks, reminders, assignments, exams, study, courses, flashcards }, now);
  const capture = new Capture(db, bus, { clans, files, notes, saved, courses }, now);
  const share = new Share({ clans, files, notes, saved, capture });
  const notifications = new Notifications(db, bus, chat, clans, local, now);
  notifications.connectStudy({ reminderText: (id) => reminders.text(id), tasksDueSoon: (a, b) => tasks.dueSoon(a, b), examsSoon: (a, b) => exams.soon(a, b), sessionsStartingSoon: (a, b) => study.startingSoon(a, b), cardsDue: () => flashcards.dueOwners() });

  const search = new SearchIndex(db, bus, permissions);
  search.register(notes.searchProvider());
  search.register(saved.searchProvider());
  search.register(chat.searchProvider());
  for (const m of [courses, tasks, exams, flashcards]) search.register(m.searchProvider());
  const whiteboard = new Whiteboard(db, bus, permissions, { courseOwner: (id) => courses.ownerOf(id), sessionOwner: (id) => study.ownerOf(id) }, now);
  const recordings = new Recordings(db, bus, { courses, files, notes }, now);
  search.register(recordings.searchProvider());
  // timeline entries are their own search documents (so a hit opens the tape at that moment)
  bus.subscribe('search.recordings.events', TapeChanged, (e) => { search.forget('recordings', `${e.payload.tapeId}:`); for (const k of recordings.eventKeys(e.payload.tapeId)) search.reindex('recordings', k); }, { persistent: true });
  const context = new ContextBroker(permissions);
  for (const p of [notes.contextProvider(), saved.contextProvider(), diary.contextProvider()]) context.register(p);
  // CLAN Intelligence: reads through module APIs only; writes only via accepted proposals.
  const ai = new AI(db, { clans, courses, notes, files, saved, chat, exams, tasks, flashcards, study, recordings, reminders, store, broker: context }, permissions, opts.aiProvider ?? (() => null), now);

  // Personal device sync: only the owner's personal data, each module through its own provider.
  const sync = new PersonalSync(db, identity, { tmpDir: join(opts.storageDir, 'sync-incoming'), ingest: async (p, mime) => { await mkdir(join(opts.storageDir, 'sync-incoming'), { recursive: true }); return store.ingest(p, mime); }, freeBytes: opts.freeBytes }, now);
  sync.register(profileProvider(identity));
  for (const p of [notifications, courses, notes, saved, capture, diary, tasks, reminders, exams, flashcards, study, whiteboard, files, recordings].flatMap((m) => m.syncProviders())) sync.register(p);
  const SEARCH: Record<string, string> = { note: 'notes', 'saved-item': 'saved', course: 'courses', task: 'tasks', exam: 'exams', deck: 'flashcards', tape: 'recordings' };
  sync.onApplied((kind, id) => { if (SEARCH[kind]) search.reindex(SEARCH[kind], id); });

  // Persistent hosting checkpoint sections owned by CLAN modules (the host server adds its own section).
  for (const p of [clans.checkpointProvider(), chat.checkpointProvider(), whiteboard.checkpointProvider(), files.checkpointProvider()]) hosting.register(p);
  me = identity.localUser(opts.localName);
  bus.deliverPending();
  /** Classroom history → CLASSROOM CLANs (+ their files). Idempotent; call at startup and when a class ends. */
  // Every CLASSROOM CLAN gets one linked Course (idempotent; references only).
  const syncClassrooms = () => { const r = clans.importClassrooms(me); const f = files.adoptClassroomFiles(opts.storageDir); return { ...r, files: f, courses: courses.linkClassrooms({ kind: 'user', userId: me }) }; };
  /** Reminders due → events; due-soon checks → notices. Call about once a minute. */
  const tick = (t = now()) => { reminders.fire(t); notifications.tick(t); };
  syncClassrooms();
  hosting.onActivated(() => { syncClassrooms(); });
  // Direct local edits to CLAN-owned data follow the same fence as the host server.
  for (const m of [chat, whiteboard, files]) m.guardHostWrites((clanId) => hosting.localWriteBlocked(clanId)); // member links and adopted classroom files of the imported CLAN

  /** Internal lifecycle step. Requires durable authorized intent; filesystem/server cleanup still must succeed
   * before completeCleanup. It deliberately never deletes private study rows, signing identities or other CLANs. */
  const purgeClanProjection = (clanId: string) => {
    const intent = clans.cleanup(clanId);
    if (!intent || intent.userId !== me) throw new Error('Authorized cleanup intent is required.');
    return tx(db, () => {
      const candidates = files.forgetClan(clanId, { ownerId: me, refIds: courses.fileReferences(me) });
      clans.recordCleanupObjects(clanId, candidates);
      notes.forgetClan(clanId); saved.forgetClan(clanId);
      notifications.forgetThreads(chat.forgetClan(clanId));
      assignments.forgetClan(clanId); whiteboard.purgeOwner('clan', clanId); search.forgetClan(clanId);
      return clans.cleanupObjects(clanId);
    });
  };

  return { db, bus, identity, permissions, store, search, context, clans, files, notes, saved, diary, reminders, share, chat, capture, notifications, courses, tasks, exams, flashcards, study, assignments, agenda, ai, whiteboard, recordings, sync, hosting, me, syncClassrooms, tick, purgeClanProjection };
}

export type { Principal, Scope } from './core/permissions.ts';
export type { ClanEvent, EventDef } from './core/events.ts';
export type { AIContextReference, ContextResult } from './core/context.ts';
export { CAPABILITIES, CLAN_TYPES, type Clan, type ClanType, type Capability } from './modules/clans/index.ts';
export type { Note } from './modules/notes/index.ts';
export type { SavedItem, Collection } from './modules/saved/index.ts';
export type { Entry as DiaryEntry } from './modules/diary/index.ts';
export type { Reminder } from './modules/reminders/index.ts';
export * as StudyEvents from './modules/study-events.ts';
export type { FileView } from './modules/files/index.ts';
export type { ShareInput, ShareTarget, ShareResult } from './modules/share/index.ts';
export { parseIntake } from './modules/share/index.ts';
export { fetchLinkMeta } from './modules/saved/index.ts';
export { Chat, ChatError, schema as chatSchema } from './modules/chat/index.ts';
export * as ChatEvents from './modules/chat/index.ts';
export type { InboxItem, CaptureInput, CaptureTarget } from './modules/capture/index.ts';
export type { NoticePrefs, DeliveredNotice } from './modules/notifications/index.ts';
export type { Course, Topic, Lecture, CourseLink } from './modules/courses/index.ts';
export type { Task } from './modules/tasks/index.ts';
export type { Exam } from './modules/exams/index.ts';
export type { Deck, Card } from './modules/flashcards/index.ts';
export type { StudySession } from './modules/study/index.ts';
export type { AssignmentItem } from './modules/assignments/index.ts';
export type { AgendaItem, CourseContext, LectureContext, ExamContext, StudyContext } from './modules/agenda/index.ts';
export { AI_GRANTEE } from './core/context.ts';
export type { AISettings, ProviderSettings, AIRequest, RunResult, Preview, SourceUse, AIScope, Include, OpenTarget, Action, AgentDefinition, SourceKind, ProposalView } from './modules/ai/index.ts';
export { AGENTS } from './modules/ai/index.ts';
export type { Board, BoardOwner } from './modules/whiteboard/index.ts';
export type { Tape, TapeEvent, TapeEventKind } from './modules/recordings/index.ts';
export { PersonalSync, SyncAuthError, contentHash, verifyEd25519, linkProof, fpOf, SMALL_FILE, type SyncSettings, type DeviceView, type ConflictView, type SelfDevice } from './modules/sync/index.ts';
export { HostAuthority, HostingError, CLAN_TABLES, classifyTable, type HostState, type HostStatus } from './modules/hosting/index.ts';
export { clock as tapeClock } from './modules/recordings/index.ts';
export * as ScreenShareEvents from './modules/screenshare/index.ts';
