// MediaTransport over a host-local LiveKit SFU (renderer). Lazy-loaded: nothing here ships in the shell chunk.
// Signalling URL is the CLAN host's own pinned HTTPS origin (/media); media is WebRTC DTLS-SRTP to the host only.
import {
  ConnectionQuality, LocalAudioTrack, LocalVideoTrack, Room, RoomEvent, ScreenSharePresets, Track, VideoPreset,
  type RemoteTrack, type RemoteTrackPublication, type RemoteParticipant,
} from 'livekit-client';
import { SCREEN_PROFILES, type MediaDiagnostics, type MediaQuality, type MediaTransport, type ScreenProfile, type ScreenView } from '@classroom/client';

export function createTransport(): MediaTransport {
  // Separate publisher/subscriber connections avoid Chromium rejecting bundled VP8 payloads with different
  // start-bitrate parameters when a member first watches, then presents. Media still uses the same local SFU.
  // Chromium's visibility observer can suspend a live screen inside the transformed
  // room wall. Control subscription explicitly when the view attaches/leaves instead.
  const room = new Room({ adaptiveStream: false, dynacast: true, disconnectOnPageLeave: true, singlePeerConnection: false });
  let video: LocalVideoTrack | null = null, audio: LocalAudioTrack | null = null;
  const screenSubs = new Set<(v: ScreenView | null, who: string | null) => void>();
  const stateSubs = new Set<(s: 'connected' | 'reconnecting' | 'disconnected') => void>();
  let remote: RemoteTrack | null = null;
  let last = { bytes: 0, at: 0 };

  const emitScreen = () => {
    const pubs = [...room.remoteParticipants.values()].flatMap((p) => [...p.trackPublications.values()].map((t) => ({ p, t })));
    const v = pubs.find(({ t }) => t.source === Track.Source.ScreenShare && t.track);
    const a = pubs.find(({ t }) => t.source === Track.Source.ScreenShareAudio && t.track);
    remote = (v?.t.track as RemoteTrack | undefined) ?? null;
    const view: ScreenView | null = v ? {
      hasAudio: !!a,
      attach: (el) => { v.t.setEnabled(true); a?.t.setEnabled(true); v.t.track!.attach(el); a?.t.track?.attach(el); },
      detach: (el) => { v.t.track?.detach(el); a?.t.track?.detach(el); v.t.setEnabled(false); a?.t.setEnabled(false); },
    } : null;
    for (const f of screenSubs) f(view, v?.p.identity ?? null);
  };
  room.on(RoomEvent.TrackSubscribed, emitScreen).on(RoomEvent.TrackUnsubscribed, emitScreen).on(RoomEvent.TrackUnpublished, emitScreen)
    .on(RoomEvent.ParticipantDisconnected, emitScreen)
    .on(RoomEvent.Reconnecting, () => stateSubs.forEach((f) => f('reconnecting')))
    .on(RoomEvent.Reconnected, () => { stateSubs.forEach((f) => f('connected')); emitScreen(); })
    .on(RoomEvent.Disconnected, () => { remote = null; stateSubs.forEach((f) => f('disconnected')); screenSubs.forEach((f) => f(null, null)); });

  const tuneTrack = (t: MediaStreamTrack, profile: ScreenProfile) => {
    const p = SCREEN_PROFILES[profile];
    t.contentHint = p.contentHint;
    void t.applyConstraints({ width: { max: p.maxWidth }, height: { max: p.maxHeight }, frameRate: { max: p.fps } }).catch(() => {});
  };
  let profileNow: ScreenProfile = 'auto';

  return {
    topology: 'host-sfu',
    async connect(o) {
      await room.connect(o.url, o.token, { autoSubscribe: true, rtcConfig: { iceServers: [] } });
      stateSubs.forEach((f) => f('connected'));
      emitScreen();
    },
    async publishScreen(stream, profile) {
      profileNow = profile;
      const p = SCREEN_PROFILES[profile];
      const vt = stream.getVideoTracks()[0];
      if (!vt) throw new Error('Nothing to share.');
      tuneTrack(vt, profile);
      video = new LocalVideoTrack(vt, undefined, true);
      await room.localParticipant.publishTrack(video, {
        source: Track.Source.ScreenShare, videoCodec: 'vp8', simulcast: true,
        screenShareEncoding: { maxBitrate: p.maxBitrate, maxFramerate: p.fps },
        // smaller layers so a phone preview never pulls the full-resolution stream
        screenShareSimulcastLayers: [new VideoPreset(640, 360, 400_000, Math.min(p.fps, 8)), ScreenSharePresets.h720fps5],
        degradationPreference: p.keepResolution ? 'maintain-resolution' : 'balanced',
      });
      const at = stream.getAudioTracks()[0]; // present only if the OS really captured system audio
      if (at) { audio = new LocalAudioTrack(at, undefined, true); await room.localParticipant.publishTrack(audio, { source: Track.Source.ScreenShareAudio }); }
    },
    async replaceScreen(stream) {
      const vt = stream.getVideoTracks()[0];
      if (!vt || !video) throw new Error('Not presenting.');
      tuneTrack(vt, profileNow);
      await video.replaceTrack(vt, true);
      const at = stream.getAudioTracks()[0];
      if (at && audio) await audio.replaceTrack(at, true);
      else if (at) { audio = new LocalAudioTrack(at, undefined, true); await room.localParticipant.publishTrack(audio, { source: Track.Source.ScreenShareAudio }); }
      else if (audio) { await room.localParticipant.unpublishTrack(audio); audio = null; }
    },
    async unpublishScreen() {
      for (const t of [video, audio]) if (t) { await room.localParticipant.unpublishTrack(t).catch(() => {}); t.stop(); }
      video = null; audio = null;
    },
    onScreen(cb) { screenSubs.add(cb); emitScreen(); return () => { screenSubs.delete(cb); }; },
    onState(cb) { stateSubs.add(cb); return () => { stateSubs.delete(cb); }; },
    quality(): MediaQuality {
      const q = room.localParticipant.connectionQuality;
      return q === ConnectionQuality.Excellent || q === ConnectionQuality.Good ? 'good' : q === ConnectionQuality.Poor ? 'fair' : q === ConnectionQuality.Lost ? 'poor' : 'unknown';
    },
    async diagnostics(): Promise<MediaDiagnostics> {
      const track = video ?? (remote as RemoteTrack | null);
      const report = track ? await (track as unknown as { getRTCStatsReport(): Promise<RTCStatsReport | undefined> }).getRTCStatsReport().catch(() => undefined) : undefined;
      const d: MediaDiagnostics = { transport: 'LiveKit SFU on the CLAN host (WebRTC, DTLS-SRTP)', codec: null, width: null, height: null, fps: null, bitrateKbps: null, packetsLost: null, rttMs: null, layer: null };
      report?.forEach((s: Record<string, unknown>) => {
        if ((s.type === 'inbound-rtp' || s.type === 'outbound-rtp') && s.kind === 'video') {
          d.width = (s.frameWidth as number) ?? d.width; d.height = (s.frameHeight as number) ?? d.height; d.fps = (s.framesPerSecond as number) ?? d.fps;
          d.packetsLost = (s.packetsLost as number) ?? d.packetsLost; d.layer = (s.rid as string) ?? d.layer;
          const bytes = (s.bytesReceived as number) ?? (s.bytesSent as number) ?? 0, at = s.timestamp as number;
          if (last.at && at > last.at) d.bitrateKbps = Math.round(((bytes - last.bytes) * 8) / (at - last.at));
          last = { bytes, at };
          const codec = report.get(s.codecId as string) as { mimeType?: string } | undefined;
          d.codec = codec?.mimeType?.split('/')[1] ?? d.codec;
        }
        if (s.type === 'candidate-pair' && s.nominated && typeof s.currentRoundTripTime === 'number') d.rttMs = Math.round((s.currentRoundTripTime as number) * 1000);
      });
      return d;
    },
    async disconnect() { await this.unpublishScreen(); await room.disconnect(); },
  };
}
export type { RemoteParticipant, RemoteTrackPublication };
