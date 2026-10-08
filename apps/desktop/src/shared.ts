import type { DiscoveredClassroom } from '@classroom/server/discovery';
import type { Iface } from '@classroom/server';
import type { ChatMessageView, ChatThreadView, ClassroomInfo, ClientMessage, JoinPolicy, MemberStatus, Receipt, ResourceView, StudentProfile, TransferState } from '@classroom/protocol';
import type { KeystoreStatus } from './main/keystore.ts';
import type { Clan, ClanType, Collection, DiaryEntry, FileView, Note, Reminder, SavedItem, InboxItem, NoticePrefs, DeliveredNotice } from '@clan/core';
export type { Clan, ClanType, Collection, DiaryEntry, FileView, Note, Reminder, SavedItem, InboxItem, NoticePrefs, DeliveredNotice };

export type Capabilities = {
  platform: string;
  lanMode: boolean;
  directMode: { available: boolean; reason: string };
  interfaces: Iface[];
  hostname: string;
  keystore: KeystoreStatus;
};

/** Student's own profile; the public key comes from the OS-protected device key and can't be edited. */
export type OwnProfile = Partial<Pick<StudentProfile, 'fullName' | 'rollNo' | 'deviceName'>> & { devicePublicKey: string; fingerprint: string };
export type StoredReceipt = { receipt: Receipt; verified: boolean; reason?: string };
export type TeacherTrust = 'first' | 'known' | 'changed';
export type Joined = {
  url: string; token: string; memberId: string; status: MemberStatus; classroom: ClassroomInfo;
  teacherPublicKey: string; teacherFingerprint: string; teacherTrust: TeacherTrust;
};

export type StartedClassroom = { url: string; code: string; teacherToken: string; title: string; host: string; iface: string;
  direct: { ssid: string; band: '2.4' | '5' | '6' | null; strategy: string; vpn: string[] } | null };
export type DirectAvailability = { available: boolean; reason: string | null; strategy: string | null; bluetooth: string; backend: string | null; vpn: string[] };
export type DirectStatus = { up: boolean; ssid: string | null; band: string | null; hostAddress: string | null; interfaceName: string | null; connected: number; p2p: 'unknown' | 'available' | 'isolated' } | null;

export type FileState = { resourceId: string; state: TransferState; bytes: number; size: number; resumedFrom?: number; error?: string; canOpen?: boolean; via?: string };
/** `url` is informational: main routes every request through the session it paired with. */
export type Conn = { url: string; token: string; sessionId: string; classTitle: string };
export type PastClass = { sessionId: string; title: string; startedAt: number; endedAt: number | null; files: number; submissions: number };

export type HomeView = {
  me: { id: string; name: string };
  library: { notes: number; saved: number; courses: number; files: number };
  inboxCount: number;
  diaryToday: boolean;
  clans: { id: string; name: string; type: ClanType; members: number }[];
  continueNotes: { id: string; title: string; updatedAt: number }[];
  deadlines: Reminder[];
  inbox: SavedItem[];
  activity: { label: string; ts: number }[];
  /** No AI provider ships yet; the Guide entry says so instead of pretending. */
  aiProvider: null;
};
export type ClanDetail = {
  clan: Clan; mine: boolean; members: { userId: string; name: string; role: string }[]; sessions: number; files: FileView[];
  notes: { id: string; title: string; mine: boolean }[]; saved: SavedItem[];
};
export type SearchHit = { module: string; entityId: string; title: string; snippet: string };

export type ClanPlaceView = { id: string; name: string; type: ClanType; expiresAt: number | null; members: number; files: number; sessions: number; host: string | null; mine: boolean };
export type CourseView = { id: string; name: string; sessions: number; files: number; notes: number; recentNotes: number; exams: number };

/** CLAN services (window.classroom.clan). */
export type ClanApi = {
  home(): Promise<HomeView>;
  joined(a: { sessionId: string; clanId: string | null; type: ClanType; name: string; hostKey: string; expiresAt: number | null; hostName?: string | null }): Promise<void>;
  list(): Promise<Clan[]>;
  places(): Promise<ClanPlaceView[]>;
  courses(): Promise<CourseView[]>;
  personalFiles(): Promise<FileView[]>;
  addPersonalFile(): Promise<number>;
  detail(id: string): Promise<ClanDetail>;
  notes(): Promise<Note[]>;
  createNote(a: { title: string; body?: string }): Promise<Note>;
  updateNote(id: string, a: { title?: string; body?: string }): Promise<Note>;
  removeNote(id: string): Promise<void>;
  shareNote(id: string, clanId: string, on: boolean): Promise<void>;
  collections(): Promise<Collection[]>;
  savedItems(): Promise<SavedItem[]>;
  save(a: { url: string; title?: string; note?: string; tags?: string[]; collectionId?: string }): Promise<SavedItem>;
  createCollection(name: string): Promise<string>;
  moveSaved(id: string, collectionId: string): Promise<void>;
  shareSaved(id: string, clanId: string, on: boolean): Promise<void>;
  diaryDay(day: string): Promise<DiaryEntry | null>;
  writeDiary(a: { day: string; body: string; mood?: string | null }): Promise<DiaryEntry>;
  diaryRecent(): Promise<DiaryEntry[]>;
  remind(a: { text: string; dueAt: number; target?: { module: string; id: string } }): Promise<Reminder>;
  reminderDone(id: string): Promise<void>;
  search(q: string): Promise<SearchHit[]>;
  rename(name: string): Promise<void>;
  privacy(): Promise<{ aiDiary: boolean }>;
  setAiDiary(on: boolean): Promise<void>;
};

/** The pinned session a chat call goes through (main resolves the real route; `url` must match it). */
export type ChatConn = { url: string; token: string; sessionId: string };
export type ReceivedFile = ChatMessageView & { clanId: string; clanName: string };
export type ChatApi = {
  http<T>(c: ChatConn, req: { method: 'GET' | 'POST'; path: string; body?: { to: string } }): Promise<T>;
  outboxAdd(clanId: string, payload: Extract<ClientMessage, { t: 'chat.send' }>): Promise<void>;
  outbox(clanId: string): Promise<Extract<ClientMessage, { t: 'chat.send' }>[]>;
  outboxSent(id: string): Promise<void>;
  ingest(thread: ChatThreadView, me: string, messages: ChatMessageView[]): Promise<string[]>;
  setMe(clanId: string, handle: string): Promise<void>;
  local(clanId: string): Promise<ChatThreadView[]>;
  localPage(threadId: string, before?: number): Promise<ChatMessageView[]>;
  received(): Promise<ReceivedFile[]>;
  /** Files dropped in the window (real File objects, resolved to paths in the preload) or picked in a dialog. */
  sendDropped(c: ChatConn, files: File[], to: string): Promise<ResourceView[]>;
  sendPicked(c: ChatConn, to: string): Promise<ResourceView[]>;
  hostSave(resourceId: string): Promise<{ name: string }>;
  onUpload(cb: (p: { sent: number; size: number; name: string }) => void): () => void;
};
export type NotifyApi = {
  context(c: { viewing?: string | null; focus?: boolean }): Promise<void>;
  list(): Promise<DeliveredNotice[]>;
  readThread(threadId: string): Promise<void>;
  prefs(): Promise<NoticePrefs>;
  setPrefs(p: Partial<NoticePrefs>): Promise<NoticePrefs>;
  on(cb: (n: DeliveredNotice) => void): () => void;
};
export type CaptureApi = {
  add(i: { kind: 'note'; title?: string; body?: string } | { kind: 'link'; url: string; title?: string; note?: string; tags?: string[]; collectionId?: string } | { kind: 'text'; text: string }): Promise<InboxItem>;
  dropped(files: File[]): Promise<number>;
  pick(): Promise<number>;
  inbox(): Promise<InboxItem[]>;
  file(id: string, to: { kind: 'collection'; collectionId: string } | { kind: 'clan' | 'course'; clanId: string } | { kind: 'done' }): Promise<void>;
  onAdded(cb: () => void): () => void;
};

/** API exposed by the preload as window.classroom. */
export type DesktopApi = {
  clan: ClanApi;
  chat: ChatApi;
  notify: NotifyApi;
  capture: CaptureApi;
  capabilities(): Promise<Capabilities>;
  getProfile(): Promise<OwnProfile>;
  saveProfile(p: Pick<StudentProfile, 'fullName' | 'rollNo' | 'deviceName'>): Promise<OwnProfile>;
  /** Secure join: discovery + OPAQUE with the code + pinned TLS + device-key proof, all in the main process. */
  joinClass(code: string, manualAddress?: string): Promise<Joined>;
  /** Device-key reconnect to an already-paired session (token expired, app restarted). No code needed. */
  rejoin(sessionId: string): Promise<Joined>;
  lastSession(): Promise<{ sessionId: string; title: string; savedAt: number } | null>;
  trustTeacher(title: string, teacherPublicKey: string): Promise<void>;
  /** Host any CLAN type (historical name). */
  startClassroom(a: { title: string; policy: JoinPolicy; host?: string; type?: ClanType; description?: string; hours?: number; clanId?: string; connectivity?: 'lan' | 'direct'; distribution?: 'host' | 'peer' }): Promise<StartedClassroom>;
  directAvailability(): Promise<DirectAvailability>;
  directStatus(): Promise<DirectStatus>;
  directQr(): Promise<{ dataUrl: string; expiresAt: number }>;
  joinQr(qr: string, code: string): Promise<Joined>;
  peerProbe(targets: string[]): Promise<{ tried: number; reachable: number }>;
  mediaPermission(): Promise<{ platform: string; screen: string; audio: boolean; testCapture: boolean }>;
  mediaSources(): Promise<{ id: string; kind: 'screen' | 'window'; name: string; thumbnail: string }[]>;
  mediaChoose(id: string, audio: boolean): Promise<void>;
  mediaToken(c: { url: string; token: string; sessionId: string }): Promise<{ token: string }>;
  stopClassroom(): Promise<void>;
  discover(onList: (list: DiscoveredClassroom[]) => void): () => void;

  // teacher
  addFiles(): Promise<{ added: number; errors: string[] }>;
  /** Files dropped on the room table (paths resolved in the preload from real dropped File objects). */
  addDropped(files: File[]): Promise<{ added: number; errors: string[] }>;
  onImportProgress(cb: (p: { resourceId: string; bytes: number; size: number }) => void): () => void;
  revealSubmission(submissionId: string): Promise<void>;
  pastClasses(): Promise<PastClass[]>;
  revealPastClass(sessionId: string): Promise<void>;

  // student
  fileStatus(c: Conn, resources: ResourceView[]): Promise<FileState[]>;
  /** `hostOnly`: chat attachments and files sent to you come from the host directly (never from peers). */
  download(c: Conn, r: ResourceView, hostOnly?: boolean): Promise<void>;
  pause(resourceId: string): Promise<void>;
  showFile(sessionId: string, resourceId: string): Promise<void>;
  openFile(sessionId: string, resourceId: string): Promise<void>;
  onFileState(cb: (s: FileState) => void): () => void;
  pickSubmission(allowedExtensions: string[]): Promise<{ pickId: string; name: string; size: number } | null>;
  submit(c: Conn, assignmentId: string, pickId: string): Promise<StoredReceipt>;
  onUploadProgress(cb: (p: { assignmentId: string; sent: number; size: number }) => void): () => void;
  receipts(sessionId?: string): Promise<StoredReceipt[]>;
  /** Forward control-plane state the data plane needs (peer assistance on/off, revoked devices). */
  peerState(c: Conn, s: { peerAssist: boolean; revoked: string[] }): Promise<void>;
  setSharing(on: boolean): Promise<void>;
  verifyReceipt(r: Receipt): Promise<StoredReceipt>;
};
