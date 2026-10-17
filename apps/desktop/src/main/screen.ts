// Screen/window capture for CLAN presentations (main process). The renderer never gets to choose a source silently:
// it can only ask for the list, then the user's explicit pick is the one source the display-media handler will grant.
import { app, BrowserWindow, desktopCapturer, ipcMain, session, shell, systemPreferences } from 'electron';
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

/** A pick expires if no capture follows it (e.g. the renderer failed between choosing and capturing). */
const PICK_TTL_MS = 30_000;
let chosen: { id: string; audio: boolean; room:string|null; ticket:string;owner:number; at: number } | null = null;
/** True only between the user's explicit pick and the capture it authorizes. */
export const displayArmed = () => !!chosen && Date.now() - chosen.at < PICK_TTL_MS;
/** Stages of the last capture attempt (docs/SCREEN_SHARING_ROOT_CAUSE.md). No source names, titles or thumbnails. */
type CaptureDiag = { at: number | null; picked: boolean; permissionAsked: boolean; permissionGranted: boolean | null; handlerRan: boolean; sourceFound: boolean | null; sourceKind: 'screen' | 'window' | null };
let diag: CaptureDiag = { at: null, picked: false, permissionAsked: false, permissionGranted: null, handlerRan: false, sourceFound: null, sourceKind: null };
/** Called by the session permission handler for the request Chromium makes on getDisplayMedia. */
export const notePermission = (granted: boolean) => { diag = { ...diag, permissionAsked: true, permissionGranted: granted }; };
const screenStatus = () => process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';

export function registerScreen() {
  MediaService.cleanStale(mediaWorkDir()); // a crashed host may have left the SFU running
  let offered = new Set<string>();

  ipcMain.handle('media:permission', () => ({
    platform: process.platform,
    screen: screenStatus(),
    audio: systemAudioSupported(),
    testCapture: testCapture(),
  }));
  ipcMain.handle('media:diagnostics', () => ({ platform: process.platform, osVersion: process.getSystemVersion(), packaged: app.isPackaged, electron: process.versions.electron, screen: screenStatus(), ...diag }));
  ipcMain.handle('media:openSettings', () => process.platform === 'darwin'
    ? shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture').then(() => true)
    : false);

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
    chosen = { id: s, audio: z.boolean().parse(audio) && systemAudioSupported(),room:room===undefined?null:z.string().regex(/^m-[a-f0-9-]{36}$/).parse(room),ticket:randomUUID(),owner:e.sender.id, at: Date.now() };
    diag = { at: Date.now(), picked: true, permissionAsked: false, permissionGranted: null, handlerRan: false, sourceFound: null, sourceKind: chosen.id.startsWith('screen:') ? 'screen' : 'window' };
    return chosen.ticket;
  });

  ipcMain.handle('control:screen',(e,ticket:unknown,room:unknown,track:unknown)=>captures.bind(z.uuid().parse(ticket),z.string().regex(/^m-[a-f0-9-]{36}$/).parse(room),z.string().min(1).max(128).parse(track),e.sender.id));

  session.defaultSession.setDisplayMediaRequestHandler(async (_req, cb) => {
    const pick = displayArmed() ? chosen : null; chosen = null;
    diag = { ...diag, handlerRan: true };
    if (!pick) return cb({}); // no explicit choice → nothing is captured
    const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    const src = sources.find((x) => x.id === pick.id);
    diag = { ...diag, sourceFound: !!src };
    if (!src) return cb({});
    captures.picked(pick.ticket,pick.room,src.id.startsWith('screen:')?src.display_id:null,pick.owner);
    cb(pick.audio ? { video: src, audio: 'loopback' } : { video: src });
  }, { useSystemPicker: false });
}
