// Composition root: the only place that knows every module. Modules receive their collaborators here and talk to each
// other only through public APIs (modules/<name>/index.ts), events and the core services.
import { migrateModules, type Db, type ModuleSchema } from './core/db.ts';
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

export const SCHEMAS: ModuleSchema[] = [eventsSchema, permissionsSchema, identitySchema, resourcesSchema, searchSchema, clansSchema, notesSchema, savedSchema, diarySchema, remindersSchema, chatSchema, captureSchema, notifySchema,
  coursesSchema, tasksSchema, examsSchema, flashcardsSchema, studySchema, assignmentsSchema];

export type ClanApp = ReturnType<typeof openClan>;

/** Opens CLAN on an existing SQLite handle (the device database). `storageDir` holds Resource Store objects. */
export function openClan(db: Db, opts: { storageDir: string; now?: () => number; localName?: string }) {
  const now = opts.now ?? (() => Date.now());
  migrateModules(db, SCHEMAS);
  const bus = new EventBus(db, now);
  const identity = new Identity(db, now);
  const clans = new Clans(db, bus, identity, now);
  const permissions = new Permissions(db, clans, now);
  const store = new ResourceStore(db, bus, opts.storageDir, now);
  const files = new Files(db, bus, store, permissions, clans);
  const notes = new Notes(db, bus, permissions, clans, now);
  const saved = new Saved(db, bus, permissions, now);
  const diary = new Diary(db, now);
  const reminders = new Reminders(db, bus, now);
  let me = '';
  const local = () => me;
  const chat = new Chat(db, bus, permissions, now, local);
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
  const context = new ContextBroker(permissions);
  for (const p of [notes.contextProvider(), saved.contextProvider(), diary.contextProvider()]) context.register(p);

  me = identity.localUser(opts.localName);
  bus.deliverPending();
  /** Classroom history → CLASSROOM CLANs (+ their files). Idempotent; call at startup and when a class ends. */
  // Every CLASSROOM CLAN gets one linked Course (idempotent; references only).
  const syncClassrooms = () => { const r = clans.importClassrooms(me); const f = files.adoptClassroomFiles(opts.storageDir); return { ...r, files: f, courses: courses.linkClassrooms({ kind: 'user', userId: me }) }; };
  /** Reminders due → events; due-soon checks → notices. Call about once a minute. */
  const tick = (t = now()) => { reminders.fire(t); notifications.tick(t); };
  syncClassrooms();

  return { db, bus, identity, permissions, store, search, context, clans, files, notes, saved, diary, reminders, share, chat, capture, notifications, courses, tasks, exams, flashcards, study, assignments, agenda, me, syncClassrooms, tick };
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
export * as ScreenShareEvents from './modules/screenshare/index.ts';
