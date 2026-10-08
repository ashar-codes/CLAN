import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopApi } from '../shared.ts';

const listen = <T>(channel: string, cb: (v: T) => void) => {
  const h = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => { ipcRenderer.off(channel, h); };
};

const inv = (ch: string) => (...a: unknown[]) => ipcRenderer.invoke(ch, ...a);
const api: DesktopApi = {
  clan: {
    home: inv('clan:home'), joined: inv('clan:joined'), places: inv('clan:places'), personalFiles: inv('files:personal'), addPersonalFile: inv('files:addPersonal'), list: inv('clan:list'), detail: inv('clan:detail'),
    notes: inv('notes:mine'), createNote: inv('notes:create'), updateNote: inv('notes:update'), removeNote: inv('notes:remove'), shareNote: inv('notes:share'),
    collections: inv('saved:collections'), savedItems: inv('saved:items'), save: inv('saved:add'), createCollection: inv('saved:collection'),
    moveSaved: inv('saved:move'), shareSaved: inv('saved:share'),
    diaryDay: inv('diary:day'), writeDiary: inv('diary:write'), diaryRecent: inv('diary:recent'),
    remind: inv('reminders:create'), search: inv('search'),
    rename: inv('me:rename'), privacy: inv('privacy:get'), setAiDiary: inv('privacy:aiDiary'),
  } as DesktopApi['clan'],
  chat: {
    http: inv('chat:http'), outboxAdd: inv('chat:outboxAdd'), outbox: inv('chat:outbox'), outboxSent: inv('chat:outboxSent'), ingest: inv('chat:ingest'), setMe: inv('chat:setMe'),
    local: inv('chat:local'), localPage: inv('chat:localPage'), received: inv('chat:received'), hostSave: inv('chat:hostSave'), sendPicked: inv('chat:sendPicked'),
    sendDropped: (c, files, to) => ipcRenderer.invoke('chat:sendDropped', c, files.slice(0, 20).map((f) => webUtils.getPathForFile(f)).filter(Boolean), to),
    onUpload: (cb) => listen('chat:upload', cb),
  } as DesktopApi['chat'],
  notify: {
    context: inv('notify:context'), list: inv('notify:list'), readThread: inv('notify:readThread'), prefs: inv('notify:prefs'), setPrefs: inv('notify:setPrefs'),
    on: (cb) => listen('notify', cb),
  } as DesktopApi['notify'],
  capture: {
    add: inv('capture:add'), pick: inv('capture:pick'), inbox: inv('capture:inbox'), file: inv('capture:file'),
    dropped: (files) => ipcRenderer.invoke('capture:dropped', files.slice(0, 20).map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
    onAdded: (cb) => listen('capture:added', () => cb()),
  } as DesktopApi['capture'],
  study: {
    courses: inv('study:courses'), createCourse: inv('study:createCourse'), updateCourse: inv('study:updateCourse'), archiveCourse: inv('study:archiveCourse'), linkClassrooms: inv('study:linkClassrooms'),
    course: inv('study:course'), addTopic: inv('study:addTopic'), renameTopic: inv('study:renameTopic'), moveTopic: inv('study:moveTopic'), removeTopic: inv('study:removeTopic'), setConfidence: inv('study:confidence'),
    addLecture: inv('study:addLecture'), setLecture: inv('study:setLecture'), link: inv('study:link'), unlink: inv('study:unlink'), classify: inv('study:classify'), importFiles: inv('study:importFiles'), linkable: inv('study:linkable'),
    tasks: inv('tasks:list'), createTask: inv('tasks:create'), updateTask: inv('tasks:update'), taskStatus: inv('tasks:status'), checkItem: inv('tasks:check'), addItem: inv('tasks:addItem'), attachToTask: inv('tasks:attach'),
    exams: inv('exams:list'), createExam: inv('exams:create'), updateExam: inv('exams:update'), examStatus: inv('exams:status'), attachToExam: inv('exams:attach'), examCenter: inv('exams:center'),
    remind: inv('reminders:create'), reminderDone: inv('reminders:done'), dismiss: inv('reminders:dismiss'), snooze: inv('reminders:snooze'), removeReminder: inv('reminders:remove'), reminders: inv('reminders:upcoming'),
    today: inv('study:today'), range: inv('study:range'), assignmentsSeen: inv('study:assignmentsSeen'),
    decks: inv('cards:decks'), createDeck: inv('cards:createDeck'), addCard: inv('cards:add'), editCard: inv('cards:edit'), removeCard: inv('cards:remove'), cards: inv('cards:list'), queue: inv('cards:queue'), review: inv('cards:review'), dueCount: inv('cards:dueCount'),
    activeSession: inv('session:active'), planSession: inv('session:plan'), startSession: inv('session:start'), endSession: inv('session:end'), cancelSession: inv('session:cancel'), history: inv('session:history'),
  } as DesktopApi['study'],
  ai: {
    status: inv('ai:status'), settings: inv('ai:settings'), setSettings: inv('ai:setSettings'), setKey: inv('ai:setKey'), deleteKey: inv('ai:deleteKey'), agents: inv('ai:agents'),
    preview: inv('ai:preview'), run: inv('ai:run'), cancel: inv('ai:cancel'), onDelta: (cb) => listen('ai:delta', cb), search: inv('ai:search'),
    proposals: inv('ai:proposals'), accept: inv('ai:accept'), dismiss: inv('ai:dismiss'), answerQuiz: inv('ai:answerQuiz'), analyzePaper: inv('ai:analyzePaper'),
    confirmPaperTopic: inv('ai:confirmPaperTopic'), proposeScope: inv('ai:proposeScope'), examGaps: inv('ai:examGaps'), openFile: inv('ai:openFile'),
    conversations: inv('ai:conversations'), deleteHistory: inv('ai:deleteHistory'), usage: inv('ai:usage'), rebuild: inv('ai:rebuild'),
  } as DesktopApi['ai'],
  capabilities: () => ipcRenderer.invoke('caps'),
  getProfile: () => ipcRenderer.invoke('profile:get'),
  saveProfile: (p) => ipcRenderer.invoke('profile:save', p),
  startClassroom: (a) => ipcRenderer.invoke('teacher:start', a),
  stopClassroom: () => ipcRenderer.invoke('teacher:stop'),
  directAvailability: () => ipcRenderer.invoke('direct:availability'),
  directStatus: () => ipcRenderer.invoke('direct:status'),
  directQr: () => ipcRenderer.invoke('direct:qr'),
  joinQr: (qr, code) => ipcRenderer.invoke('student:joinQr', qr, code),
  peerProbe: (t) => ipcRenderer.invoke('student:peerProbe', t),
  mediaPermission: () => ipcRenderer.invoke('media:permission'),
  mediaSources: () => ipcRenderer.invoke('media:sources'),
  mediaChoose: (id, audio) => ipcRenderer.invoke('media:choose', id, audio),
  mediaToken: (c) => ipcRenderer.invoke('media:token', c),
  discover(onList) {
    const h = (_e: unknown, list: Parameters<typeof onList>[0]) => onList(list);
    ipcRenderer.on('discover:list', h);
    ipcRenderer.invoke('discover:start');
    return () => { ipcRenderer.off('discover:list', h); ipcRenderer.invoke('discover:stop'); };
  },
  addFiles: () => ipcRenderer.invoke('teacher:addFiles'),
  // Only paths of real dropped files (webUtils returns '' for anything not backed by a disk file).
  addDropped: (files) => ipcRenderer.invoke('teacher:addPaths', files.slice(0, 20).map((f) => webUtils.getPathForFile(f)).filter(Boolean)),
  onImportProgress: (cb) => listen('teacher:import', cb),
  revealSubmission: (id) => ipcRenderer.invoke('teacher:revealSubmission', id),
  pastClasses: () => ipcRenderer.invoke('teacher:pastClasses'),
  revealPastClass: (id) => ipcRenderer.invoke('teacher:revealPastClass', id),
  fileStatus: (c, r) => ipcRenderer.invoke('student:fileStatus', c, r),
  download: (c, r, hostOnly) => ipcRenderer.invoke('student:download', c, r, hostOnly),
  pause: (id) => ipcRenderer.invoke('student:pause', id),
  showFile: (sid, id) => ipcRenderer.invoke('student:show', sid, id),
  openFile: (sid, id) => ipcRenderer.invoke('student:open', sid, id),
  onFileState: (cb) => listen('student:file', cb),
  pickSubmission: (ext) => ipcRenderer.invoke('student:pick', ext),
  submit: (c, a, p) => ipcRenderer.invoke('student:submit', c, a, p),
  onUploadProgress: (cb) => listen('student:upload', cb),
  receipts: (sid) => ipcRenderer.invoke('student:receipts', sid),
  peerState: (c, s) => ipcRenderer.invoke('student:peerState', c, s),
  setSharing: (on) => ipcRenderer.invoke('student:setSharing', on),
  verifyReceipt: (r) => ipcRenderer.invoke('student:verifyReceipt', r),
  joinClass: (code, manual) => ipcRenderer.invoke('student:join', code, manual),
  rejoin: (sid) => ipcRenderer.invoke('student:rejoin', sid),
  lastSession: () => ipcRenderer.invoke('student:lastSession'),
  trustTeacher: (title, key) => ipcRenderer.invoke('student:trustTeacher', title, key),
};
contextBridge.exposeInMainWorld('classroom', api);
