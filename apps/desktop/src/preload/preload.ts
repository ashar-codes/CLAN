import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared.ts';

const listen = <T>(channel: string, cb: (v: T) => void) => {
  const h = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => { ipcRenderer.off(channel, h); };
};

const inv = (ch: string) => (...a: unknown[]) => ipcRenderer.invoke(ch, ...a);
const api: DesktopApi = {
  clan: {
    home: inv('clan:home'), joined: inv('clan:joined'), list: inv('clan:list'), detail: inv('clan:detail'),
    notes: inv('notes:mine'), createNote: inv('notes:create'), updateNote: inv('notes:update'), removeNote: inv('notes:remove'), shareNote: inv('notes:share'),
    collections: inv('saved:collections'), savedItems: inv('saved:items'), save: inv('saved:add'), createCollection: inv('saved:collection'),
    moveSaved: inv('saved:move'), shareSaved: inv('saved:share'),
    diaryDay: inv('diary:day'), writeDiary: inv('diary:write'), diaryRecent: inv('diary:recent'),
    remind: inv('reminders:create'), reminderDone: inv('reminders:done'), search: inv('search'),
    rename: inv('me:rename'), privacy: inv('privacy:get'), setAiDiary: inv('privacy:aiDiary'),
  } as DesktopApi['clan'],
  capabilities: () => ipcRenderer.invoke('caps'),
  getProfile: () => ipcRenderer.invoke('profile:get'),
  saveProfile: (p) => ipcRenderer.invoke('profile:save', p),
  startClassroom: (a) => ipcRenderer.invoke('teacher:start', a),
  stopClassroom: () => ipcRenderer.invoke('teacher:stop'),
  discover(onList) {
    const h = (_e: unknown, list: Parameters<typeof onList>[0]) => onList(list);
    ipcRenderer.on('discover:list', h);
    ipcRenderer.invoke('discover:start');
    return () => { ipcRenderer.off('discover:list', h); ipcRenderer.invoke('discover:stop'); };
  },
  addFiles: () => ipcRenderer.invoke('teacher:addFiles'),
  onImportProgress: (cb) => listen('teacher:import', cb),
  revealSubmission: (id) => ipcRenderer.invoke('teacher:revealSubmission', id),
  pastClasses: () => ipcRenderer.invoke('teacher:pastClasses'),
  revealPastClass: (id) => ipcRenderer.invoke('teacher:revealPastClass', id),
  fileStatus: (c, r) => ipcRenderer.invoke('student:fileStatus', c, r),
  download: (c, r) => ipcRenderer.invoke('student:download', c, r),
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
