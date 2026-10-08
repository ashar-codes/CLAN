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

export const SCHEMAS: ModuleSchema[] = [eventsSchema, permissionsSchema, identitySchema, resourcesSchema, searchSchema, clansSchema, notesSchema, savedSchema, diarySchema, remindersSchema, chatSchema, captureSchema, notifySchema];

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
  const capture = new Capture(db, bus, { clans, files, notes, saved }, now);
  const share = new Share({ clans, files, notes, saved, capture });
  const notifications = new Notifications(db, bus, chat, clans, local, now);

  const search = new SearchIndex(db, bus, permissions);
  search.register(notes.searchProvider());
  search.register(saved.searchProvider());
  search.register(chat.searchProvider());
  const context = new ContextBroker(permissions);
  for (const p of [notes.contextProvider(), saved.contextProvider(), diary.contextProvider()]) context.register(p);

  me = identity.localUser(opts.localName);
  bus.deliverPending();
  /** Classroom history → CLASSROOM CLANs (+ their files). Idempotent; call at startup and when a class ends. */
  const syncClassrooms = () => { const r = clans.importClassrooms(me); return { ...r, files: files.adoptClassroomFiles(opts.storageDir) }; };
  syncClassrooms();

  return { db, bus, identity, permissions, store, search, context, clans, files, notes, saved, diary, reminders, share, chat, capture, notifications, me, syncClassrooms };
}

export type { Principal, Scope } from './core/permissions.ts';
export type { ClanEvent, EventDef } from './core/events.ts';
export type { AIContextReference, ContextResult } from './core/context.ts';
export { CAPABILITIES, CLAN_TYPES, type Clan, type ClanType, type Capability } from './modules/clans/index.ts';
export type { Note } from './modules/notes/index.ts';
export type { SavedItem, Collection } from './modules/saved/index.ts';
export type { Entry as DiaryEntry } from './modules/diary/index.ts';
export type { Reminder } from './modules/reminders/index.ts';
export type { FileView } from './modules/files/index.ts';
export type { ShareInput, ShareTarget, ShareResult } from './modules/share/index.ts';
export { parseIntake } from './modules/share/index.ts';
export { fetchLinkMeta } from './modules/saved/index.ts';
export { Chat, ChatError, schema as chatSchema } from './modules/chat/index.ts';
export * as ChatEvents from './modules/chat/index.ts';
export type { InboxItem, CaptureInput, CaptureTarget } from './modules/capture/index.ts';
export type { NoticePrefs, DeliveredNotice } from './modules/notifications/index.ts';
export { AI_GRANTEE } from './core/context.ts';
export * as ScreenShareEvents from './modules/screenshare/index.ts';
