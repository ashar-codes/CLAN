// Local SFU for CLAN screen sharing: a self-hosted LiveKit server owned by the CLAN host.
// Secrets (API key/secret) are generated per process and never leave the host. Clients get short-lived JWTs that can
// presentation subscribers receive subscribe-only credentials; meeting credentials grant scoped microphone/camera
// sources. Publishing and revocation are enforced on the SFU by the host, never trusted to client controls.
// Signalling listens on 127.0.0.1 only and is reached through the CLAN HTTPS server (pinned TLS); media (DTLS-SRTP)
// listens only on the CLAN interface address. No cloud, TURN or external auth.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { AccessToken, TokenVerifier, RoomServiceClient, TrackSource } from 'livekit-server-sdk';

export type MediaState = 'stopped' | 'starting' | 'ready' | 'failed';
export const MEDIA_TOKEN_TTL_S = 10 * 60;
const PUBLISH_SOURCES = [TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO];

const freeTcp = () => new Promise<number>((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => res(p)); }); });
const freeUdp = (host: string) => new Promise<number>((res, rej) => { const s = createSocket('udp4'); s.once('error', rej); s.bind(0, host, () => { const p = s.address().port; s.close(() => res(p)); }); });
/** The OS interface name for an address (LiveKit filters ICE by interface + IP). */
export function interfaceOf(address: string) {
  for (const [name, addrs] of Object.entries(networkInterfaces())) if (addrs?.some((a) => a.address === address)) return name;
  return null;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

export class MediaService extends EventEmitter {
  state: MediaState = 'stopped';
  /** Random, per CLAN session; never the CLAN name. */
  readonly room = `r-${randomBytes(9).toString('base64url')}`;
  private apiKey = `k${randomBytes(8).toString('hex')}`;
  private secret = randomBytes(32).toString('base64url');
  private proc: ChildProcess | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private restarts = 0;
  private closing = false;
  readonly codec = 'vp8'; // broadly supported; recorded in diagnostics
  private o: { binary: string; host: string; workDir: string };

  constructor(o: { binary: string; host: string; workDir: string }) { super(); this.o = o; }

  /** Loopback signalling URL for the HTTPS proxy (never handed to clients). */
  get signalUrl() { return `ws://127.0.0.1:${this.port}`; }
  get pid() { return this.proc?.pid ?? null; }
  private get pidFile() { return join(this.o.workDir, 'livekit.pid'); }

  /** Kill a media process left behind by a crashed CLAN host. */
  static cleanStale(workDir: string) {
    const f = join(workDir, 'livekit.pid');
    if (!existsSync(f)) return false;
    const pid = Number(readFileSync(f, 'utf8'));
    if (pid > 0 && alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    rmSync(f, { force: true });
    return true;
  }

  /** Starts the SFU on first use (lazy). */
  ensure(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('The media service has closed. Start a new authorized CLAN session.'));
    if (this.state === 'ready') return Promise.resolve();
    return (this.starting ??= this.start().finally(() => { this.starting = null; }));
  }

  private async start() {
    if (!existsSync(this.o.binary)) { this.state = 'failed'; throw new Error('The media service is missing from this installation.'); }
    const iface = interfaceOf(this.o.host);
    if (!iface) { this.state = 'failed'; throw new Error('The CLAN network interface is not available for media.'); }
    mkdirSync(this.o.workDir, { recursive: true });
    MediaService.cleanStale(this.o.workDir);
    this.state = 'starting';
    this.port = await freeTcp();
    const udp = await freeUdp(this.o.host);
    const cfg = [
      `port: ${this.port}`, 'bind_addresses: [127.0.0.1]',
      'rtc:', `  udp_port: ${udp}`, '  tcp_port: 0', `  node_ip: ${this.o.host}`, '  use_external_ip: false',
      '  interfaces:', `    includes: [${JSON.stringify(iface)}]`, '  ips:', `    includes: [${this.o.host}/32]`,
      'room:', '  empty_timeout: 300', '  max_participants: 200',
      'keys:', `  ${this.apiKey}: ${this.secret}`, 'logging:', '  level: warn',
    ].join('\n');
    const cfgFile = join(this.o.workDir, 'livekit.yaml');
    writeFileSync(cfgFile, cfg, { mode: 0o600 });
    const p = spawn(this.o.binary, ['--config', cfgFile], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.proc = p;
    writeFileSync(this.pidFile, String(p.pid ?? 0));
    let stderr = '';
    p.stderr?.on('data', (d) => { stderr = (stderr + d).slice(-2000); });
    p.on('exit', (code) => {
      if (this.proc !== p) return;
      this.proc = null;
      if (this.closing) return;
      this.state = 'failed';
      this.emit('failed', `media service exited (${code ?? 'signal'})`);
      if (this.restarts++ < 1) void this.ensure().then(() => this.emit('restarted'), () => {}); // one automatic restart
    });
    // ready when the HTTP port answers
    for (let i = 0; i < 100; i++) {
      if (!this.proc) throw new Error(`Media service failed to start. ${stderr.trim().split('\n').pop() ?? ''}`);
      try { const r = await fetch(`http://127.0.0.1:${this.port}/`); if (r.ok || r.status < 500) { this.state = 'ready'; rmSync(cfgFile, { force: true }); return; } } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 100));
    }
    p.kill('SIGKILL');
    throw new Error('Media service did not become ready.');
  }

  private api() { return new RoomServiceClient(`http://127.0.0.1:${this.port}`, this.apiKey, this.secret); }

  /** Short-lived media credential for one authenticated CLAN member in this session's room only. */
  async token(o: { identity: string; name: string; canPublish: boolean; ttlSec?: number }) {
    await this.ensure();
    const ttl = o.ttlSec ?? MEDIA_TOKEN_TTL_S;
    const at = new AccessToken(this.apiKey, this.secret, { identity: o.identity, name: o.name.slice(0, 80), ttl });
    at.addGrant({ roomJoin: true, room: this.room, canSubscribe: true, canPublish: o.canPublish, canPublishSources: o.canPublish ? PUBLISH_SOURCES : [], canPublishData: false, canUpdateOwnMetadata: false });
    return { token: await at.toJwt(), expiresAt: Date.now() + ttl * 1000 };
  }

  async meetingToken(room: string, identity: string, name: string, lease: string, video: boolean) {
    await this.ensure();
    await this.api().createRoom({name:room,maxParticipants:8,emptyTimeout:60});
    const at = new AccessToken(this.apiKey,this.secret,{identity,name:name.slice(0,80),ttl:120,metadata:lease});
    at.addGrant({roomJoin:true,room,canSubscribe:true,canPublish:true,canPublishSources:[TrackSource.MICROPHONE,...(video ? [TrackSource.CAMERA] : []),TrackSource.SCREEN_SHARE],canPublishData:false,canUpdateOwnMetadata:false});
    return {token:await at.toJwt(),expiresAt:Date.now()+120000};
  }
  verifyToken(token:string) { return new TokenVerifier(this.apiKey,this.secret).verify(token,0); }
  async meetingParticipants(room:string) { return this.state==='ready' ? this.api().listParticipants(room) : []; }
  async meetingRemove(room:string,identity:string) { if(this.state==='ready') await this.api().removeParticipant(room,identity).catch(async e=>{if(String(e?.code)==='not_found')return;await this.close();throw e;}); }
  async meetingMute(room:string,identity:string) { for(const track of (await this.meetingParticipants(room)).find(p=>p.identity===identity)?.tracks ?? []) if(track.source===TrackSource.MICROPHONE) await this.api().mutePublishedTrack(room,identity,track.sid,true); }
  async meetingEnd(room:string) { if(this.state==='ready') await this.api().deleteRoom(room).catch(async e=>{if(String(e?.code)==='not_found')return;await this.close();throw e;}); }

  /** Grant/revoke publishing on the SFU itself (revocation unpublishes immediately). */
  async setPublish(identity: string, allowed: boolean) {
    if (this.state !== 'ready') return;
    await this.api().updateParticipant(this.room, identity, { permission: { canSubscribe: true, canPublish: allowed, canPublishData: false, canPublishSources: allowed ? PUBLISH_SOURCES : [] } }).catch(() => {}); // not connected yet: its next token decides
  }

  /** Drop a participant now (removed/blocked member): token expiry is only the backstop. */
  async remove(identity: string) {
    if (this.state !== 'ready') return;
    await this.api().removeParticipant(this.room, identity).catch(() => {});
  }

  async participants() { return this.state === 'ready' ? (await this.api().listParticipants(this.room).catch(() => [])) : []; }

  private closed: Promise<void> | null = null;
  /** Idempotent: CLAN end and server shutdown may both call it. */
  close() { return (this.closed ??= this.doClose()); }
  private async doClose() {
    this.closing = true;
    if (this.state === 'ready') await this.api().deleteRoom(this.room).catch(() => {});
    const p = this.proc; this.proc = null;
    if (p && p.exitCode === null && p.signalCode === null) {
      const exited = new Promise<void>((r) => p.once('exit', () => r()));
      p.kill('SIGTERM'); // LiveKit drains gracefully; don't wait for it forever
      const t = setTimeout(() => p.kill('SIGKILL'), 3000);
      await exited; clearTimeout(t);
    }
    rmSync(this.pidFile, { force: true });
    this.state = 'stopped';
  }
}
