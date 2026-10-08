import type { DiscoveredClassroom } from '@classroom/server/discovery';
import type { Iface } from '@classroom/server';
import type { ChatMessageView, ChatThreadView, ClassroomInfo, ClientMessage, JoinPolicy, MemberStatus, Receipt, ResourceView, StudentProfile, TransferState } from '@classroom/protocol';
import type { KeystoreStatus } from './main/keystore.ts';
import type { Clan, ClanType, Collection, DiaryEntry, FileView, Note, Reminder, SavedItem, InboxItem, NoticePrefs, DeliveredNotice,
  Course, Topic, Lecture, CourseLink, Task, Exam, Deck, Card, StudySession, AssignmentItem, AgendaItem,
  AISettings, AIRequest, RunResult, Preview, AIScope, Include, Action, ProposalView, SourceKind, Board, BoardOwner, Tape, TapeEvent, TapeEventKind } from '@clan/core';
import type { Grade, Recurrence, ResourceKind, TaskStatus, ExamStatus, TopicState, countdown, readiness, Citation, ProposalKind, WbLogged, WbOp } from '@classroom/protocol';
export type { Clan, ClanType, Collection, DiaryEntry, FileView, Note, Reminder, SavedItem, InboxItem, NoticePrefs, DeliveredNotice,
  Course, Topic, Lecture, CourseLink, Task, Exam, Deck, Card, StudySession, AssignmentItem, AgendaItem, Grade, Recurrence, ResourceKind, TaskStatus, ExamStatus, TopicState,
  AISettings, AIRequest, RunResult, Preview, AIScope, Include, Action, ProposalView, SourceKind, Citation, ProposalKind, Board, BoardOwner, Tape, TapeEvent, TapeEventKind };

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
  today: AgendaItem[];
  /** Next two weeks (semester board pins). */
  upcoming: AgendaItem[];
  session: StudySession | null;
  latestCourse: Course | null;
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
/** Campus building: floors = topics (solid = marked Confident), lit windows = real activity this week, exam flag = exam within 14 days. */
export type CourseView = { id: string; name: string; code: string; term: string; clanId: string | null; clanName: string | null;
  topics: { id: string; title: string; state: TopicState }[]; recent: number; files: number; openTasks: number;
  nextExam: { id: string; name: string; at: number; soon: boolean } | null; dueCards: number };
export type CourseDetail = { course: Course; clanName: string | null; topics: Topic[]; lectures: Lecture[]; links: CourseLink[]; tasks: Task[]; exams: Exam[];
  decks: Deck[]; sessions: StudySession[]; assignments: AssignmentItem[]; reminders: Reminder[]; tapes: Tape[] };
export type Countdown = ReturnType<typeof countdown>;
export type ExamCenter = { exam: Exam; course: Course; countdown: Countdown; topics: Topic[]; readiness: ReturnType<typeof readiness>; covered: Topic[]; remaining: Topic[];
  pastPapers: CourseLink[]; resources: CourseLink[]; notes: CourseLink[]; saved: CourseLink[]; decks: Deck[]; dueCards: number; tasks: Task[]; sessions: StudySession[]; reminders: Reminder[] };
export type HistoryRow = { courseId: string | null; course: string; sessions: number; minutes: number; topics: number; reviews: number };
type LinkModule = 'notes' | 'files' | 'saved';

/** Study Engine (window.classroom.study). */
export type StudyApi = {
  courses(): Promise<CourseView[]>;
  createCourse(a: { name: string; code?: string; instructor?: string; term?: string; schedule?: string; clanId?: string | null }): Promise<Course>;
  updateCourse(id: string, a: Partial<{ name: string; code: string; instructor: string; term: string; schedule: string; clanId: string | null }>): Promise<Course>;
  archiveCourse(id: string): Promise<void>;
  linkClassrooms(): Promise<number>;
  course(id: string): Promise<CourseDetail>;
  addTopic(courseId: string, title: string): Promise<Topic>;
  renameTopic(id: string, title: string): Promise<void>;
  moveTopic(id: string, index: number): Promise<void>;
  removeTopic(id: string): Promise<void>;
  setConfidence(id: string, state: TopicState): Promise<void>;
  addLecture(courseId: string, a: { title: string; at?: number | null; topicIds?: string[] }): Promise<Lecture>;
  setLecture(id: string, a: { status?: Lecture['status']; title?: string; at?: number | null }): Promise<void>;
  link(courseId: string, a: { module: LinkModule; entityId: string; topicId?: string | null; lectureId?: string | null; kind?: ResourceKind | null }): Promise<CourseLink>;
  unlink(id: string): Promise<void>;
  classify(id: string, kind: ResourceKind): Promise<void>;
  importFiles(courseId: string, a?: { topicId?: string | null; lectureId?: string | null; kind?: ResourceKind }): Promise<number>;
  linkable(): Promise<Record<LinkModule, { id: string; title: string }[]>>;
  tasks(a?: { courseId?: string; open?: boolean }): Promise<Task[]>;
  createTask(a: { title: string; description?: string; courseId?: string | null; topicId?: string | null; clanId?: string | null; dueAt?: number | null; priority?: Task['priority']; checklist?: string[] }): Promise<Task>;
  updateTask(id: string, a: Partial<{ title: string; description: string; dueAt: number | null; priority: Task['priority'] }>): Promise<Task>;
  taskStatus(id: string, s: TaskStatus): Promise<Task>;
  checkItem(id: string, itemId: string, done: boolean): Promise<void>;
  addItem(id: string, text: string): Promise<void>;
  attachToTask(id: string, module: LinkModule, entityId: string): Promise<void>;
  exams(): Promise<(Exam & { countdown: Countdown })[]>;
  createExam(a: { courseId: string; name: string; at: number; location?: string; topicIds?: string[]; notes?: string }, reminders: (7 | 1)[]): Promise<Exam>;
  updateExam(id: string, a: Partial<{ name: string; at: number; location: string; topicIds: string[]; notes: string }>): Promise<Exam>;
  examStatus(id: string, s: ExamStatus, result?: { grade?: string; total?: string; reflection?: string }): Promise<Exam>;
  attachToExam(id: string, module: LinkModule, entityId: string): Promise<void>;
  examCenter(id: string): Promise<ExamCenter>;
  remind(a: { text: string; dueAt: number; target?: { module: string; id: string }; recurrence?: Recurrence }): Promise<Reminder>;
  reminderDone(id: string): Promise<void>;
  dismiss(id: string): Promise<void>;
  snooze(id: string, until: number): Promise<void>;
  removeReminder(id: string): Promise<void>;
  reminders(): Promise<Reminder[]>;
  today(): Promise<AgendaItem[]>;
  range(from: number, to: number): Promise<AgendaItem[]>;
  assignmentsSeen(clanId: string, list: unknown): Promise<void>;
  decks(a?: { courseId?: string; examId?: string }): Promise<Deck[]>;
  createDeck(a: { name: string; courseId?: string | null; topicId?: string | null; examId?: string | null }): Promise<Deck>;
  addCard(deckId: string, a: { front: string; back: string; note?: string; ref?: { module: LinkModule; id: string } }): Promise<Card>;
  editCard(id: string, a: Partial<{ front: string; back: string; note: string }>): Promise<void>;
  removeCard(id: string): Promise<void>;
  cards(deckId: string, offset?: number): Promise<Card[]>;
  queue(deckId: string): Promise<Card[]>;
  review(id: string, g: Grade): Promise<Card>;
  dueCount(): Promise<number>;
  activeSession(): Promise<StudySession | null>;
  planSession(a: { courseId?: string | null; topicId?: string | null; goal?: string; at: number; minutes?: number | null }): Promise<StudySession>;
  startSession(a: { sessionId?: string; courseId?: string | null; topicId?: string | null; goal?: string; minutes?: number | null; focus?: boolean }): Promise<StudySession>;
  endSession(id: string, reflection?: string): Promise<StudySession>;
  cancelSession(id: string): Promise<void>;
  history(): Promise<HistoryRow[]>;
};

/** CLAN services (window.classroom.clan). */
export type ClanApi = {
  home(): Promise<HomeView>;
  joined(a: { sessionId: string; clanId: string | null; type: ClanType; name: string; hostKey: string; expiresAt: number | null; hostName?: string | null }): Promise<void>;
  list(): Promise<Clan[]>;
  places(): Promise<ClanPlaceView[]>;
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
  /** `into`: file straight into one of your courses (optionally a topic) instead of the Inbox. */
  add(i: { kind: 'note'; title?: string; body?: string } | { kind: 'link'; url: string; title?: string; note?: string; tags?: string[]; collectionId?: string } | { kind: 'text'; text: string }, into?: { courseId: string; topicId?: string | null }): Promise<InboxItem>;
  dropped(files: File[]): Promise<number>;
  pick(into?: { courseId: string; topicId?: string | null }): Promise<number>;
  inbox(): Promise<InboxItem[]>;
  file(id: string, to: { kind: 'collection'; collectionId: string } | { kind: 'clan'; clanId: string } | { kind: 'course'; courseId: string; topicId?: string | null } | { kind: 'done' }): Promise<void>;
  onAdded(cb: () => void): () => void;
};

export type AIStatus = { provider: { label: string; model: string; local: boolean } | null; message: string | null; diaryGranted: boolean; index: { sources: number; chunks: number; chars: number };
  hasKey: boolean; localAvailable: boolean; secureStorage: boolean };
export type PaperQuestion = { id: string; n: number; page: number | null; text: string; suggestedTopicId: string | null; confidence: string | null; method: string | null; topicId: string | null; cite: string; refId: string };
export type PaperResult = { status: 'ok' | 'unsupported' | 'denied'; reason: string | null; label?: string; topics?: { id: string; title: string }[]; questions: PaperQuestion[] };
export type QuizResult = { score: number; total: number; results: { i: number; correct: boolean; given: string; expected: string; explanation: string; citations: Citation[]; selfMarked: boolean }[];
  suggestions: { topicId: string; title: string; message: string; current: TopicState; proposal: ProposalView | null }[] };
export type ExamGap = { topicId: string; title: string; state: TopicState; reasons: string[]; gap: boolean };
/** CLAN Intelligence (window.classroom.ai). Keys go in via setKey and never come back out. */
export type AIApi = {
  status(): Promise<AIStatus>;
  settings(): Promise<AISettings>;
  setSettings(patch: Partial<AISettings>): Promise<AISettings>;
  setKey(key: string): Promise<void>;
  deleteKey(): Promise<void>;
  agents(): Promise<{ id: string; name: string; reads: SourceKind[]; proposals: ProposalKind[]; cannot: string[] }[]>;
  preview(r: Pick<AIRequest, 'action' | 'scope' | 'include' | 'agent'>): Promise<Preview>;
  run(runId: string, r: AIRequest): Promise<RunResult>;
  cancel(runId: string): Promise<void>;
  onDelta(cb: (d: { runId: string; text: string }) => void): () => void;
  search(q: string, scope?: AIScope): Promise<Citation[]>;
  proposals(status?: 'pending' | 'accepted' | 'dismissed' | 'expired' | 'all'): Promise<ProposalView[]>;
  accept(id: string, edited?: unknown): Promise<ProposalView>;
  dismiss(id: string): Promise<void>;
  answerQuiz(quizId: string, answers: { i: number; answer: string; selfCorrect?: boolean }[]): Promise<QuizResult>;
  analyzePaper(refId: string, examId?: string | null): Promise<PaperResult>;
  confirmPaperTopic(questionId: string, topicId: string | null): Promise<void>;
  proposeScope(refId: string, examId: string): Promise<ProposalView | null>;
  examGaps(examId: string): Promise<ExamGap[]>;
  openFile(refId: string): Promise<void>;
  conversations(): Promise<{ id: string; title: string; scope: string; updatedAt: number }[]>;
  deleteHistory(): Promise<void>;
  usage(): Promise<{ provider: string; model: string; requests: number; inputTokens: number | null; outputTokens: number | null }[]>;
  rebuild(): Promise<{ sources: number; chunks: number; chars: number }>;
};

/** Boards that belong to this person (Personal / Course / Study Session). CLAN boards go over the session's WSS. */
export type BoardApi = {
  list(owner: { kind: 'personal' | 'course' | 'session'; id: string }): Promise<Board[]>;
  create(owner: { kind: 'personal' | 'course' | 'session'; id: string }, title: string): Promise<Board>;
  read(id: string, since: number): Promise<{ ops: WbLogged[]; snapshot: boolean; head: number; title: string }>;
  edit(id: string, ops: WbOp[]): Promise<WbLogged[]>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Derived output; returns where it was saved (null = cancelled). */
  export(fmt: 'png' | 'pdf', pngDataUrl: string, title: string): Promise<string | null>;
};
export type RecProblem = { tapeId: string; kind: 'write_failed' | 'disk_low' | 'disk_critical'; message: string; freeBytes?: number };
/** Study Tapes (window.classroom.rec). Media is streamed to disk in chunks; nothing big crosses IPC at once. */
export type TapeApi = {
  check(): Promise<{ freeBytes: number; low: number; critical: number; mic: string; systemAudio: boolean }>;
  start(o: { title: string; source: 'screen' | 'window' | 'test'; mic: boolean; systemAudio: boolean; othersConsent: boolean; mime: string; courseId?: string | null; lectureId?: string | null; topicId?: string | null; studySessionId?: string | null }): Promise<Tape>;
  chunk(tapeId: string, data: Uint8Array): Promise<string | null>;
  stop(tapeId: string, o: { durationMs: number; reason: string }): Promise<Tape | null>;
  active(): Promise<Tape | null>;
  mark(tapeId: string, o: { kind: 'important' | 'note' | 'bookmark' | 'marker'; atMs: number; text?: string }): Promise<TapeEvent>;
  screenshot(tapeId: string, atMs: number, png: Uint8Array): Promise<TapeEvent>;
  editEvent(id: string, text: string): Promise<void>;
  removeEvent(id: string): Promise<void>;
  toNote(eventId: string): Promise<Note>;
  list(o?: { courseId?: string; lectureId?: string }): Promise<Tape[]>;
  get(id: string): Promise<{ tape: Tape; events: TapeEvent[] } | null>;
  link(id: string, o: { courseId: string | null; topicId?: string | null; lectureId?: string | null }): Promise<Tape>;
  rename(id: string, title: string): Promise<void>;
  remove(id: string): Promise<void>;
  /** Explicit: puts a reference to the recording file into a CLAN you belong to. */
  share(id: string, clanId: string): Promise<FileView>;
  onProblem(cb: (p: RecProblem) => void): () => void;
};

/** API exposed by the preload as window.classroom. */
export type DesktopApi = {
  clan: ClanApi;
  chat: ChatApi;
  notify: NotifyApi;
  capture: CaptureApi;
  study: StudyApi;
  ai: AIApi;
  board: BoardApi;
  rec: TapeApi;
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
