// Watching a presentation on the phone: the subscribe side of MediaTransport over the host's LiveKit SFU (same as the
// desktop viewer). LiveKit's signalling (binary protobuf over WebSocket) is carried by the native PINNED socket to the
// host's /media route — the platform WebSocket can't pin the per-CLAN CA and is never used for it. Media itself is
// WebRTC (DTLS-SRTP) straight to the host. Phones only view; they never publish (tokens are subscribe-only anyway).
import { registerGlobals } from '@livekit/react-native';
import { ConnectionQuality, Room, RoomEvent, Track, VideoQuality, type RemoteTrackPublication, type RemoteVideoTrack } from 'livekit-client';
import type { WebSocketLike } from '@classroom/client';
import type { PinnedNativeTransport } from '../native';

let globalsReady = false;
const RNWebSocket = globalThis.WebSocket;
const pinned = new Map<string, PinnedNativeTransport>(); // "host:port" of a CLAN → its pinned transport

/** A W3C-WebSocket façade over the pinned native socket, used only for registered CLAN origins. */
class PinnedWebSocket {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer'; protocol = ''; extensions = ''; bufferedAmount = 0; url: string;
  onopen: ((e: unknown) => void) | null = null; onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string; wasClean: boolean }) => void) | null = null; onerror: ((e: unknown) => void) | null = null;
  private l = new Map<string, Set<{ f: (e: never) => void; once: boolean }>>();
  private s: WebSocketLike;
  constructor(url: string, t: PinnedNativeTransport) {
    this.url = url;
    this.s = t.openWebSocket(url);
    this.s.onopen = (e) => this.fire('open', e);
    this.s.onmessage = (e) => this.fire('message', { data: e.data });
    this.s.onclose = (e) => { if (e.code !== 1000) this.fire('error', { message: e.reason }); this.fire('close', { code: e.code, reason: e.reason, wasClean: e.code === 1000 }); };
  }
  get readyState() { return this.s.readyState; }
  private fire(type: string, e: unknown) {
    (this as unknown as Record<string, ((e: unknown) => void) | null>)[`on${type}`]?.(e);
    for (const x of [...(this.l.get(type) ?? [])]) { x.f(e as never); if (x.once) this.l.get(type)!.delete(x); }
  }
  addEventListener(type: string, f: (e: never) => void, o?: { once?: boolean }) { if (!this.l.has(type)) this.l.set(type, new Set()); this.l.get(type)!.add({ f, once: !!o?.once }); }
  removeEventListener(type: string, f: (e: never) => void) { for (const x of this.l.get(type) ?? []) if (x.f === f) this.l.get(type)!.delete(x); }
  send(d: string | ArrayBuffer | ArrayBufferView) { this.s.send(d); }
  close(code?: number, reason?: string) { this.s.close(code, reason); }
}

function install() {
  if (globalsReady) return;
  registerGlobals();
  // Route only registered CLAN origins through the pinned socket; any other WebSocket use keeps the platform one.
  const Platform = globalThis.WebSocket ?? RNWebSocket;
  const Routed = function (this: unknown, url: string, protocols?: string | string[]) {
    const t = /^wss:\/\//.test(url) ? pinned.get(new URL(url).host) : undefined;
    if (t) return new PinnedWebSocket(url, t);
    if (/^wss:\/\/(\d+\.){3}\d+/.test(url)) throw new Error('Refusing an unpinned connection to a CLAN host.');
    return new (Platform as unknown as new (u: string, p?: string | string[]) => unknown)(url, protocols);
  } as unknown as typeof WebSocket;
  Object.assign(Routed, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  globalThis.WebSocket = Routed;
  globalsReady = true;
}

export type ScreenState = { track: RemoteVideoTrack | null; presenter: string | null; state: 'connecting' | 'connected' | 'reconnecting' | 'disconnected'; quality: 'good' | 'fair' | 'poor' | 'unknown' };

/** Joins the CLAN's media room as a viewer. `onChange` fires on every screen / connection / quality change. */
export async function watch(c: { url: string; token: string; transport: PinnedNativeTransport }, onChange: (s: ScreenState) => void) {
  install();
  const origin = c.url.replace(/^https/, 'wss'), host = new URL(c.url).host;
  pinned.set(host, c.transport);
  const r = await c.transport.fetch(`${c.url}/api/media/token`, { method: 'POST', headers: { authorization: `Bearer ${c.token}`, 'content-type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(((await r.json().catch(() => ({}))) as { message?: string }).message ?? 'Screen sharing is not available on this host.');
  const { token } = (await r.json()) as { token: string };
  const room = new Room({ adaptiveStream: true, dynacast: true });
  let s: ScreenState = { track: null, presenter: null, state: 'connecting', quality: 'unknown' };
  const emit = (p: Partial<ScreenState>) => { s = { ...s, ...p }; onChange(s); };
  const screen = () => {
    const pubs = [...room.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()].map((t) => ({ p, t: t as RemoteTrackPublication })));
    const v = pubs.find(({ t }) => t.source === Track.Source.ScreenShare && t.track);
    emit({ track: (v?.t.track as RemoteVideoTrack | undefined) ?? null, presenter: v?.p.name || v?.p.identity || null });
  };
  const Q: Record<string, ScreenState['quality']> = { [ConnectionQuality.Excellent]: 'good', [ConnectionQuality.Good]: 'good', [ConnectionQuality.Poor]: 'poor', [ConnectionQuality.Lost]: 'poor' };
  room.on(RoomEvent.TrackSubscribed, screen).on(RoomEvent.TrackUnsubscribed, screen).on(RoomEvent.TrackUnpublished, screen).on(RoomEvent.ParticipantDisconnected, screen)
    .on(RoomEvent.Reconnecting, () => emit({ state: 'reconnecting' })).on(RoomEvent.Reconnected, () => { emit({ state: 'connected' }); screen(); })
    .on(RoomEvent.Disconnected, () => emit({ state: 'disconnected', track: null }))
    .on(RoomEvent.ConnectionQualityChanged, (q, p) => { if (p.isLocal) emit({ quality: Q[q] ?? 'unknown' }); });
  await room.connect(`${origin}/media`, token, { autoSubscribe: true, rtcConfig: { iceServers: [] } });
  emit({ state: 'connected' }); screen();
  return {
    /** Small view → low layer; fullscreen → the sharp layer (text on slides). */
    setFullscreen(on: boolean) { const pub = [...room.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()]).find((t) => t.source === Track.Source.ScreenShare) as RemoteTrackPublication | undefined; pub?.setVideoQuality(on ? VideoQuality.HIGH : VideoQuality.LOW); },
    stop: async () => { await room.disconnect(); pinned.delete(host); },
  };
}
