import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopApi } from '../shared.ts';

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
};
contextBridge.exposeInMainWorld('classroom', api);
