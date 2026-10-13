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
    archived: inv('clan:archived'), archiveLocal: inv('clan:archiveLocal'),
    storedCopies: inv('clan:storedCopies'),
    pendingCleanup: inv('clan:pendingCleanup'), cleanup: inv('clan:cleanup'),
    leaveLocal: inv('clan:leaveLocal'), leaveMembership: inv('clan:leaveMembership'),
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
    pendingShares: inv('chat:pendingShares'), reviewShare: inv('chat:reviewShare'),
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
  feedback: { preview: inv('feedback:preview'), save: inv('feedback:save') } as DesktopApi['feedback'],
  data: { export: inv('data:export'), import: inv('data:import'), backups: inv('data:backups'), backupNow: inv('data:backupNow') } as DesktopApi['data'],
  sync: {
    status: inv('sync:status'), startLink: inv('sync:startLink'), cancelLink: inv('sync:cancelLink'), approve: inv('sync:approve'), reject: inv('sync:reject'), join: inv('sync:join'),
    now: inv('sync:now'), unlink: inv('sync:unlink'), conflicts: inv('sync:conflicts'), resolve: inv('sync:resolve'), setSettings: inv('sync:setSettings'),
    onChanged: (cb) => listen('sync:changed', () => cb()), onData: (cb) => listen('sync:data', () => cb()),
  } as DesktopApi['sync'],
  people: {
    directory: inv('people:directory'), nearbyAlerts: inv('people:nearbyAlerts'),
    attempt: inv('people:attempt'),
    me: inv('people:me'), qrImage: inv('people:qrImage'), resetQr: inv('people:resetQr'), update: inv('people:update'), pickAvatar: inv('people:pickAvatar'), avatar: inv('people:avatar'),
    visibility: inv('people:visibility'), nearby: inv('people:nearby'), contacts: inv('people:contacts'), contact: inv('people:contact'), connectQr: inv('people:connectQr'), friend: inv('people:friend'),
    conversations: inv('people:conversations'), invite: inv('people:invite'), chat: inv('people:chat'), page: inv('people:page'), send: inv('people:send'), retry: inv('people:retry'),
    read: inv('people:read'), clear: inv('people:clear'), remove: inv('people:remove'),
    sendFile: (c, files) => ipcRenderer.invoke('people:sendFile', c, files ? files.slice(0, 10).map((f) => webUtils.getPathForFile(f)).filter(Boolean) : undefined),
    sendVoice: inv('people:sendVoice'), file: inv('people:file'), voiceBytes: inv('people:voiceBytes'), preview: inv('people:preview'), save: inv('people:save'), openWith: inv('people:openWith'),
    armMedia: inv('people:armMedia'),
    deviceOffers: inv('people:deviceOffers'), deviceOffer: inv('people:deviceOffer'),
    opticalStart: inv('people:opticalStart'), opticalFrames: inv('people:opticalFrames'), opticalStop: inv('people:opticalStop'), opticalReceipt: inv('people:opticalReceipt'),
    opticalAck: inv('people:opticalAck'), opticalSave: inv('people:opticalSave'), opticalInbox: inv('people:opticalInbox'), signal: inv('people:signal'), logCall: inv('people:logCall'),
    onOpen: (cb) => listen('people:open', cb), onChanged: (cb) => listen('people:changed', cb), onLive: (cb) => listen('people:live', cb),
  } as DesktopApi['people'],
  hosting: {
    status: inv('hosting:status'), enable: inv('hosting:enable'), request: inv('hosting:request'), decline: inv('hosting:decline'), revoke: inv('hosting:revoke'), handover: inv('hosting:handover'),
    cancel: inv('hosting:cancel'), resolve: inv('hosting:resolve'), exportCopy: inv('hosting:exportCopy'), acknowledgeSuperseded: inv('hosting:acknowledgeSuperseded'),
    onProgress: (cb) => listen('hosting:progress', cb), onChanged: (cb) => listen('hosting:changed', cb),
  } as DesktopApi['hosting'],
  board: {
    list: inv('board:list'), create: inv('board:create'), read: inv('board:read'), edit: inv('board:edit'), rename: inv('board:rename'), remove: inv('board:remove'), export: inv('board:export'),
  } as DesktopApi['board'],
  rec: {
    check: inv('rec:check'), start: inv('rec:start'), chunk: inv('rec:chunk'), stop: inv('rec:stop'), active: inv('rec:active'), mark: inv('rec:mark'), screenshot: inv('rec:screenshot'),
    editEvent: inv('rec:editEvent'), removeEvent: inv('rec:removeEvent'), toNote: inv('rec:toNote'), list: inv('rec:list'), get: inv('rec:get'), link: inv('rec:link'), rename: inv('rec:rename'), remove: inv('rec:remove'), share: inv('rec:share'),
    onProblem: (cb) => listen('rec:problem', cb),
  } as DesktopApi['rec'],
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
  meetingNotice:(c,id)=>ipcRenderer.invoke('meetings:notice',c,id),
  controlCapability:()=>ipcRenderer.invoke('control:capability'),
  controlPermission:()=>ipcRenderer.invoke('control:permission'),
  controlStop:()=>ipcRenderer.invoke('control:stop'),
  controlApprove:(c,room,request)=>ipcRenderer.invoke('control:approve',c,room,request),
  meetingRequest: (c,path,body) => ipcRenderer.invoke('meetings:request',c,path,body),
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
  previewFile: (sid, id) => ipcRenderer.invoke('student:preview', sid, id),
  saveFile: (sid, id) => ipcRenderer.invoke('student:save', sid, id),
  openWithFile: (sid, id) => ipcRenderer.invoke('student:openWith', sid, id),
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
