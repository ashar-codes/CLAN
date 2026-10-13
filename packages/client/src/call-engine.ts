import {acquireMedia,mediaBusy,releaseMedia} from './media-focus.ts';
// One-to-one audio call state machine, shared by the computer (Chromium WebRTC) and the phone (react-native-webrtc).
// Media is WebRTC with no STUN/TURN (local networks only). Every signal — offer, answer, reject, end — is a signed CLAN
// envelope sent by the caller-supplied `signal`; the offer/answer SDP carries the DTLS fingerprints that key the
// encrypted audio, so the media is bound to the authenticated person. Signals that do not match the current call and
// person are ignored. Platform specifics (peer connection, microphone, logging) are injected.

export type CallPhase = 'calling' | 'ringing' | 'connecting' | 'connected' | 'reconnecting' | 'ended';
export type CallView = { id: string; peerKey: string; peerName: string; dir: 'in' | 'out'; phase: CallPhase; note: string; muted: boolean; video: boolean; cameraOn: boolean; videoRx: number; connectedAt: number | null; rx: number };
export type Track = { enabled: boolean; stop(): void; kind?: string };
export type Stream = { getTracks(): Track[]; getAudioTracks(): Track[] };
type Desc = { type: string; sdp?: string | null } | null;
/** The parts of RTCPeerConnection the engine uses (Chromium's and react-native-webrtc's both fit). */
export type PeerLike = {
  iceGatheringState: string; connectionState: string; localDescription: Desc;
  addTrack(track: Track, stream: Stream): unknown;
  addTransceiver?(kind: string, options: unknown): { sender: { replaceTrack(track: Track | null): Promise<void> } };
  getTransceivers?(): {receiver:{track:{kind:string}};sender:{replaceTrack(track:Track|null):Promise<void>};direction:string}[];
  createOffer(o?: unknown): Promise<unknown>; createAnswer(o?: unknown): Promise<unknown>;
  setLocalDescription(d?: unknown): Promise<void>; setRemoteDescription(d: unknown): Promise<void>;
  addIceCandidate(c: unknown): Promise<void>;
  getStats(): Promise<{ forEach(cb: (s: { type: string; kind?: string; bytesReceived?: number }) => void): void }>;
  addEventListener(type: string, cb: (e: { streams?: Stream[]; track?: Track }) => void): void;
  close(): void;
};
export type CallDeps = {
  createPeer(): PeerLike;
  captureScope?:object;
  /** Open the microphone (asking the OS where needed). Throw a readable error if denied or missing. */
  microphone(): Promise<Stream>;
  camera?(): Promise<Stream>;
  onLocal?(stream: Stream | null): void;
  signal(peerKey: string, body: Record<string, unknown>): Promise<boolean>;
  attempt?(peerKey: string, callId: string): Promise<void>;
  log(o: { id: string; peerKey: string; direction: 'in' | 'out'; connectedAt?: number | null; endedAt?: number | null; outcome?: string }): void;
  nameOf(key: string): Promise<string | null>;
  onRemote?(stream: Stream | null): void;
  remoteStream?(tracks:Track[]):Stream;
  uuid(): string;
};

export const RING_MS = 45_000, CONNECT_MS = 20_000, RECOVER_MS = 10_000, GATHER_MS = 4000;

export class CallEngine {
  private cur: CallView | null = null;
  private pc: PeerLike | null = null;
  private mic: Stream | null = null;
  private cam: Stream | null = null;
  private videoSender: { replaceTrack(track: Track | null): Promise<void> } | null = null;
  private cameraBusy: string | null = null; private cameraEpoch = 0;
  private offer: string | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private subs = new Set<(c: CallView | null) => void>();
  private readonly d: CallDeps;
  constructor(deps: CallDeps) { this.d = deps; }

  get call() { return this.cur; }
  private now() { return this.cur; } // read through a method: TypeScript must not narrow across awaits
  get active() { return !!this.cur && this.cur.phase !== 'ended'; }
  subscribe(cb: (c: CallView | null) => void) { this.subs.add(cb); cb(this.cur); return () => { this.subs.delete(cb); }; }
  private set(patch: Partial<CallView> | null) {
    this.cur = patch === null ? null : { ...this.cur!, ...patch };
    for (const s of this.subs) s(this.cur);
  }
  private after(ms: number, f: () => void) { this.timers.push(setTimeout(f, ms)); }
  private cleanup() {
    for (const t of this.timers) clearTimeout(t); this.timers = [];
    if (this.statsTimer) clearInterval(this.statsTimer); this.statsTimer = null;
    this.pc?.close(); this.pc = null;
    this.mic?.getTracks().forEach((t) => t.stop()); this.mic = null;
    this.cameraEpoch++; this.cameraBusy = null; this.cam?.getTracks().forEach(t => t.stop()); this.cam = null; this.videoSender = null; this.d.onLocal?.(null);
    releaseMedia(this.d.captureScope ?? this);this.offer = null;
    this.d.onRemote?.(null);
  }
  /** End locally, tell the other side when asked, record it. */
  private finish(note: string, outcome: string, tell?: 'call.end' | 'call.reject', reason?: string) {
    const c = this.cur; if (!c || c.phase === 'ended') return;
    if (tell) void this.d.signal(c.peerKey, tell === 'call.end' ? { kind: 'call.end', callId: c.id, reason: reason ?? 'hangup' } : { kind: 'call.reject', callId: c.id, reason: reason ?? 'declined' }).catch(() => {});
    this.d.log({ id: c.id, peerKey: c.peerKey, direction: c.dir, connectedAt: c.connectedAt, endedAt: Date.now(), outcome });
    this.cleanup();
    this.set({ phase: 'ended', note });
    this.after(4000, () => { if (this.cur?.id === c.id) this.set(null); });
  }
  private gathered(pc: PeerLike) {
    return new Promise<void>((res) => {
      if (pc.iceGatheringState === 'complete') return res();
      const t = setTimeout(res, GATHER_MS);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
    });
  }
  private wire(pc: PeerLike) {
    const received=new Set<Track>();
    pc.addEventListener('track', (e) => {if(this.pc!==pc)return;if(e.track)received.add(e.track);for(const t of e.streams?.[0]?.getTracks() ?? [])received.add(t);this.d.onRemote?.(this.d.remoteStream ? this.d.remoteStream([...received]) : e.streams?.[0] ?? null);});
    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState, c = this.cur; if (!c || this.pc !== pc) return;
      if (s === 'connected') {
        const at = c.connectedAt ?? Date.now();
        this.set({ phase: 'connected', note: '', connectedAt: at });
        this.d.log({ id: c.id, peerKey: c.peerKey, direction: c.dir, connectedAt: at });
        if (!this.statsTimer) this.statsTimer = setInterval(() => void this.pc?.getStats().then((r) => { let rx = 0, videoRx = 0; r.forEach((x) => { if (x.type === 'inbound-rtp' && x.kind === 'audio') rx += x.bytesReceived ?? 0; if (x.type === 'inbound-rtp' && x.kind === 'video') videoRx += x.bytesReceived ?? 0; }); if (this.pc === pc && this.cur) this.set({ rx, videoRx }); }).catch(() => {}), 1000);
      } else if (s === 'disconnected' && c.phase === 'connected') {
        this.set({ phase: 'reconnecting', note: 'Connection lost. Trying to reconnect…' });
        this.after(RECOVER_MS, () => { if (this.pc === pc && pc.connectionState !== 'connected') this.finish('The connection was lost.', 'network lost', 'call.end', 'failed'); });
      } else if (s === 'failed') this.finish(c.connectedAt ? 'The connection was lost.' : 'Could not connect the call on this network.', 'failed', 'call.end', 'failed');
    });
  }
  private async openPeer(id: string) {
    const mic = await this.d.microphone();
    if (this.now()?.id !== id || !this.active) { mic.getTracks().forEach(t => t.stop()); throw new Error('Call cancelled.'); }
    this.mic = mic;
    const pc = this.d.createPeer(); this.pc = pc; this.wire(pc);
    for (const t of mic.getTracks()) pc.addTrack(t, mic);
    if(this.cur?.dir==='out'){this.reserveVideo(pc,mic);if(this.cur.video)await this.setCamera(true);}
    return pc;
  }
  private reserveVideo(pc:PeerLike,mic:Stream){const offered=pc.getTransceivers?.().find(t=>t.receiver.track.kind==='video');if(offered){offered.direction='sendrecv';this.videoSender=offered.sender;}else this.videoSender=pc.addTransceiver?.('video',{direction:'sendrecv',streams:[mic]}).sender ?? null;}
  /** A reserved video transceiver lets callers upgrade without replacing the authenticated call. */
  async setCamera(on: boolean) {
    const c = this.cur, sender = this.videoSender;
    if (!c || !this.active) return;
    if (!on) { this.cameraEpoch++; this.cameraBusy = null; this.cam?.getTracks().forEach(t => t.stop()); this.cam = null; this.d.onLocal?.(null); await sender?.replaceTrack(null); if (this.cur?.id === c.id) this.set({ cameraOn: false }); return; }
    if (this.cameraBusy===c.id) return;
    const epoch = ++this.cameraEpoch;
    if (!sender || !this.d.camera) throw new Error('Video capture is not supported by this device.');
    this.cameraBusy = c.id;
    let stream: Stream | null = null;
    try {
      stream = await this.d.camera();
      if (this.cur?.id !== c.id || !this.active || this.videoSender !== sender || epoch !== this.cameraEpoch) { stream.getTracks().forEach(t => t.stop()); return; }
      const track = stream.getTracks().find(t => t.kind === 'video'); if (!track) throw new Error('No camera track was captured.');
      await sender.replaceTrack(track);
      if (this.cur?.id !== c.id || !this.active || epoch !== this.cameraEpoch) { stream.getTracks().forEach(t => t.stop()); return; }
      this.cam?.getTracks().forEach(t => t.stop()); this.cam = stream; this.d.onLocal?.(stream); this.set({ video: true, cameraOn: true });
    } catch (e) { stream?.getTracks().forEach(t => t.stop()); throw e; } finally { if(this.cameraBusy===c.id)this.cameraBusy = null; }
  }

  /** Place a call (only to friends or people in an active chat — the signal is refused otherwise). */
  async start(peerKey: string, peerName: string, video = false) {
    if (this.active) return;
    const id = this.d.uuid();
    this.cur = null; this.set({ id, peerKey, peerName, dir: 'out', phase: 'calling', note: 'Starting the microphone…', muted: false, video, cameraOn: false, videoRx: 0, connectedAt: null, rx: 0 });
    let invited = false;
    try {
      acquireMedia(this.d.captureScope ?? this);const pc = await this.openPeer(id);
      await pc.setLocalDescription(await pc.createOffer({ offerToReceiveAudio: true }));
      await this.gathered(pc);
      if (this.now()?.id !== id || !this.active) return;
      this.d.log({ id, peerKey, direction: 'out' });
      const sent=await this.d.signal(peerKey, { kind: 'call.invite', callId: id, sdp: pc.localDescription!.sdp, ...(video ? {video:true} : {}) });if(this.now()?.id!==id || !this.active)return;
      if(!sent){await this.d.attempt?.(peerKey,id);if(this.now()?.id===id && this.active)this.finish(`${peerName} is not reachable. A call attempt will arrive when they reconnect.`, 'unreachable');return;}
      if(this.now()?.id!==id || !this.active)return;
      invited = true;
      this.set({ note: 'Ringing…' });
      this.after(RING_MS, () => { if (this.cur?.id === id && this.cur.phase === 'calling') this.finish('No answer.', 'no answer', 'call.end', 'timeout'); });
    } catch (e) { if (this.now()?.id !== id || !this.active) return; this.finish((e as Error).message, 'failed', invited ? 'call.end' : undefined, 'failed'); }
  }
  async accept() {
    const c = this.cur; if (!c || c.phase !== 'ringing' || !this.offer) return;
    this.set({ phase: 'connecting', note: 'Starting the microphone…' });
    try {
      const pc = await this.openPeer(c.id);
      await pc.setRemoteDescription({ type: 'offer', sdp: this.offer });
      if(this.now()?.id!==c.id || !this.active)return;
      this.reserveVideo(pc,this.mic!);if(c.video)await this.setCamera(true);
      await pc.setLocalDescription(await pc.createAnswer());
      await this.gathered(pc);
      if (this.now()?.id !== c.id || !this.active) return;
      const sent=await this.d.signal(c.peerKey,{kind:'call.answer',callId:c.id,sdp:pc.localDescription!.sdp});if(this.now()?.id!==c.id || !this.active)return;if(!sent)return this.finish(`${c.peerName} is no longer reachable.`,'unreachable');
      if(this.now()?.id!==c.id || !this.active)return;
      if(this.now()?.phase!=='connected')this.set({ note: 'Connecting…' });
      this.after(CONNECT_MS, () => { if (this.cur?.id === c.id && this.cur.phase === 'connecting') this.finish('Could not connect the call on this network.', 'failed', 'call.end', 'failed'); });
    } catch (e) { if (this.cur?.id !== c.id || !this.active) return; this.finish((e as Error).message, 'microphone', 'call.reject', 'unavailable'); }
  }
  hangup() {
    const c = this.cur; if (!c) return;
    if (c.phase === 'ringing') this.finish('Call declined.', 'declined', 'call.reject', 'declined');
    else if (c.phase === 'ended') this.set(null);
    else this.finish('Call ended.', c.connectedAt ? 'hangup' : 'cancelled', 'call.end', c.connectedAt ? 'hangup' : 'cancelled');
  }
  mute() { const m = !this.cur?.muted; this.mic?.getAudioTracks().forEach((t) => { t.enabled = !m; }); this.set({ muted: m }); }
  dismiss() { if (this.cur?.phase === 'ended') this.set(null); }

  /** A verified live signal (signed by `from`, fresh, from someone allowed to call). */
  onSignal(from: string, body: Record<string, unknown> & { kind: string; callId: string }) {
    const c = this.cur;
    if (body.kind === 'call.invite') {
      if (this.active || mediaBusy(this.d.captureScope ?? this)) {
        void this.d.signal(from, { kind: 'call.reject', callId: body.callId, reason: 'busy' }).catch(() => {});
        this.d.log({ id: body.callId, peerKey: from, direction: 'in', endedAt: Date.now(), outcome: 'missed (busy)' });
        return;
      }
      this.cleanup();
      acquireMedia(this.d.captureScope ?? this);this.offer = String(body.sdp ?? '');
      this.cur = null; this.set({ id: body.callId, peerKey: from, peerName: 'Someone', dir: 'in', phase: 'ringing', note: '', muted: false, video: body.video === true, cameraOn: false, videoRx: 0, connectedAt: null, rx: 0 });
      void this.d.nameOf(from).then((n) => { if (n && this.cur?.id === body.callId) this.set({ peerName: n }); });
      this.d.log({ id: body.callId, peerKey: from, direction: 'in' });
      this.after(RING_MS, () => { if (this.cur?.id === body.callId && this.cur.phase === 'ringing') this.finish('Missed call.', 'missed'); });
      return;
    }
    if (!c || c.id !== body.callId || c.peerKey !== from) return; // another call, or someone else
    if (body.kind === 'call.answer' && c.dir === 'out' && c.phase === 'calling' && this.pc) {
      this.set({ phase: 'connecting', note: 'Connecting…' });
      void this.pc.setRemoteDescription({ type: 'answer', sdp: String(body.sdp ?? '') }).catch((e: Error) => {if(this.cur?.id===c.id && this.active)this.finish(`The answer could not be used (${e.message}).`, 'failed', 'call.end', 'failed');});
      this.after(CONNECT_MS, () => { if (this.cur?.id === c.id && this.cur.phase === 'connecting') this.finish('Could not connect the call on this network.', 'failed', 'call.end', 'failed'); });
    } else if (body.kind === 'call.ice' && this.pc) {
      void this.pc.addIceCandidate({ candidate: String(body.candidate), sdpMid: (body.mid as string | null) ?? null, sdpMLineIndex: (body.index as number | null) ?? null }).catch(() => {});
    } else if (body.kind === 'call.reject') {
      this.finish(body.reason === 'busy' ? `${c.peerName} is on another call.` : body.reason === 'unavailable' ? `${c.peerName} could not take the call (microphone unavailable).` : `${c.peerName} declined the call.`, String(body.reason));
    } else if (body.kind === 'call.end') {
      this.finish(c.phase === 'ringing' ? 'Missed call.' : body.reason === 'failed' ? 'The connection was lost.' : 'Call ended.', c.phase === 'ringing' ? 'missed' : String(body.reason));
    }
  }
}
