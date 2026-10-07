import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared.ts';

const listen = <T>(channel: string, cb: (v: T) => void) => {
  const h = (_e: unknown, v: T) => cb(v);
  ipcRenderer.on(channel, h);
  return () => { ipcRenderer.off(channel, h); };
};

const api: DesktopApi = {
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
