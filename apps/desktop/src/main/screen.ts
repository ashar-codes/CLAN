// Screen/window capture for CLAN presentations (main process). The renderer never gets to choose a source silently:
// it can only ask for the list, then the user's explicit pick is the one source the display-media handler will grant.
import { app, BrowserWindow, desktopCapturer, ipcMain, session, systemPreferences } from 'electron';
import {randomUUID} from 'node:crypto';
import {ControlCapture} from '@classroom/client';
import { join } from 'node:path';
import { z } from 'zod';
import { MediaService } from '@classroom/server';

const captures=new ControlCapture();
export const controlDisplay = (room:string,track:string,owner:number) => captures.display(room,track,owner);
/** Bundled SFU (dev: native/livekit/bin/<platform>-<arch>; packaged: resources). */
export const mediaBinary = () => app.isPackaged
  ? join(process.resourcesPath, process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server')
  : join(app.getAppPath(), '..', '..', 'native', 'livekit', 'bin', `${process.platform}-${process.arch}`, process.platform === 'win32' ? 'livekit-server.exe' : 'livekit-server');
export const mediaWorkDir = () => join(app.getPath('userData'), 'media');

/** System audio of a shared screen: Windows supports loopback through Chromium; macOS/Linux are not offered. */
export const systemAudioSupported = () => process.platform === 'win32';
/** Deterministic test pattern instead of real capture — development/test builds only, never packaged. */
export const testCapture = () => !app.isPackaged && process.env.CLAN_TEST_CAPTURE === '1';

export type CaptureSource = { id: string; kind: 'screen' | 'window'; name: string; thumbnail: string };

export function registerScreen() {
  MediaService.cleanStale(mediaWorkDir()); // a crashed host may have left the SFU running
  let offered = new Set<string>();
  let chosen: { id: string; audio: boolean; room:string|null; ticket:string;owner:number } | null = null;

  ipcMain.handle('media:permission', () => ({
    platform: process.platform,
    screen: process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted',
    audio: systemAudioSupported(),
    testCapture: testCapture(),
  }));

  ipcMain.handle('media:sources', async (): Promise<CaptureSource[]> => {
    const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()));
    const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 }, fetchWindowIcons: false });
    const out = list.filter((s) => !own.has(s.id) && !(s.id.startsWith('window:') && /^CLAN$/.test(s.name))) // never offer CLAN itself
      .map((s) => ({ id: s.id, kind: s.id.startsWith('screen:') ? 'screen' as const : 'window' as const, name: s.name.slice(0, 120), thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL() }));
    offered = new Set(out.map((s) => s.id));
    return out;
  });

  /** The user's explicit choice; consumed by the next getDisplayMedia call only. */
  ipcMain.handle('media:choose', (e, id: unknown, audio: unknown, room:unknown) => {
    const s = z.string().max(200).parse(id);
    if (!offered.has(s)) throw new Error('That source is no longer available.');
    chosen = { id: s, audio: z.boolean().parse(audio) && systemAudioSupported(),room:room===undefined?null:z.string().regex(/^m-[a-f0-9-]{36}$/).parse(room),ticket:randomUUID(),owner:e.sender.id };
    return chosen.ticket;
  });

  ipcMain.handle('control:screen',(e,ticket:unknown,room:unknown,track:unknown)=>captures.bind(z.uuid().parse(ticket),z.string().regex(/^m-[a-f0-9-]{36}$/).parse(room),z.string().min(1).max(128).parse(track),e.sender.id));

  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const pick = chosen; chosen = null;
    if (!pick) return cb({}); // no explicit choice → nothing is captured
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    const src = sources.find((x) => x.id === pick.id);
    if (!src) return cb({});
    captures.picked(pick.ticket,pick.room,src.id.startsWith('screen:')?src.display_id:null,pick.owner);
    cb(pick.audio ? { video: src, audio: 'loopback' } : { video: src });
  }, { useSystemPicker: false });
}
