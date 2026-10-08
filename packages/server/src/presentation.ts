// Screen-share presentation control (host authority). Holds and persists control state only; media is the SFU's job.
// Publishing is enforced on the SFU: only the current presenter's media identity ever gets publish permission.
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { capabilitiesFor, type PresentationView } from '@classroom/protocol';
import type { Classroom, Principal } from './classroom.ts';
import { JoinError } from './classroom.ts';
import type { Db } from './db.ts';
import type { MediaService } from './media.ts';

export const PRESENTER_GRACE_MS = 20_000;
export const mediaIdentity = (p: Principal) => (p.role === 'teacher' ? 'host' : p.memberId);

type Live = PresentationView & { identity: string };
export type PresentationEvent =
  | { type: 'PresentationRequested' | 'PresentationApproved' | 'PresentationDeclined'; memberId: string }
  | { type: 'PresentationStarted' | 'PresentationSourceChanged'; presentationId: string; presenter: string; source: 'screen' | 'window'; audio: boolean }
  | { type: 'PresentationStopped'; presentationId: string; presenter: string; reason: string };

export class Presentations extends EventEmitter {
  current: Live | null = null;
  policy: 'open' | 'request';
  readonly requests = new Map<string, number>();
  private approved = new Set<string>();
  private grace: ReturnType<typeof setTimeout> | null = null;
  private db: Db; private classroom: Classroom; private media: MediaService | null; private now: () => number; private hostName: string; private graceMs: number;

  constructor(db: Db, classroom: Classroom, media: MediaService | null, o: { hostName?: string | null; now?: () => number; graceMs?: number } = {}) {
    super();
    this.db = db; this.classroom = classroom; this.media = media; this.now = o.now ?? (() => Date.now()); this.hostName = o.hostName ?? 'Host'; this.graceMs = o.graceMs ?? PRESENTER_GRACE_MS;
    this.policy = capabilitiesFor(classroom.clan.type, 'member').includes('PRESENT') ? 'open' : 'request'; // from the capability table, not the type
  }

  get available() { return !!this.media; }

  private name(p: Principal) { return p.role === 'teacher' ? this.hostName : this.classroom.member(p.memberId)?.fullName ?? 'Someone'; }
  private emitEvent(e: PresentationEvent) { this.emit('event', e); this.emit('state'); }

  /** Server-side decision: may this principal present right now? */
  mayPresent(p: Principal) {
    if (p.role === 'teacher') return this.classroom.can(p, 'PRESENT');
    if (this.classroom.status(p.memberId) !== 'approved') return false;
    if (this.approved.has(p.memberId)) return true;
    return this.policy === 'open' && this.classroom.can(p, 'PRESENT');
  }
  mine(p: Principal): 'none' | 'requested' | 'approved' {
    if (p.role === 'teacher') return 'approved';
    return this.mayPresent(p) ? 'approved' : this.requests.has(p.memberId) ? 'requested' : 'none';
  }
  view(): PresentationView | null { if (!this.current) return null; const { identity: _identity, ...v } = this.current; return v; }

  setPolicy(policy: 'open' | 'request') { if (this.policy !== policy) { this.policy = policy; this.emit('state'); } }

  request(p: Principal) {
    if (p.role !== 'student' || !this.classroom.can(p, 'REQUEST_TO_PRESENT')) throw new JoinError(403, 'forbidden', 'You cannot ask to present here.');
    if (this.mayPresent(p) || this.requests.has(p.memberId)) return;
    this.requests.set(p.memberId, this.now());
    this.classroom.log('present.requested', p.memberId, {});
    this.emitEvent({ type: 'PresentationRequested', memberId: p.memberId });
  }
  approve(memberId: string) {
    if (this.classroom.status(memberId) !== 'approved') throw new JoinError(404, 'no_member', 'No such member.');
    this.requests.delete(memberId); this.approved.add(memberId);
    this.classroom.log('present.approved', memberId, {});
    this.emitEvent({ type: 'PresentationApproved', memberId });
  }
  decline(memberId: string) {
    if (!this.requests.delete(memberId)) return;
    this.classroom.log('present.declined', memberId, {});
    this.emitEvent({ type: 'PresentationDeclined', memberId });
  }

  /** One presenter at a time. A presenter manager may take over (stopping the current presenter). */
  async start(p: Principal, o: { source: 'screen' | 'window'; audio: boolean; takeover?: boolean }) {
    if (!this.media) throw new JoinError(503, 'media_unavailable', 'Screen sharing is not available on this host.');
    if (!this.mayPresent(p)) throw new JoinError(403, 'forbidden', this.classroom.can(p, 'REQUEST_TO_PRESENT') ? 'Ask the host to present first.' : 'You cannot present here.');
    const identity = mediaIdentity(p);
    if (this.current && this.current.identity !== identity) {
      if (!(o.takeover && this.classroom.can(p, 'MANAGE_PRESENTERS'))) throw new JoinError(409, 'busy', `${this.current.presenterName} is currently presenting`);
      await this.stop('switched');
    }
    if (this.current) return this.source(p, o); // already presenting: treat as a source change
    await this.media.ensure();
    const id = randomUUID(), t = this.now();
    this.current = { id, identity, presenter: p.role === 'teacher' ? 'host' : p.memberId, presenterName: this.name(p), source: o.source, audio: o.audio, startedAt: t, state: 'live' };
    this.db.prepare('INSERT INTO presentations (id, session_id, presenter, source, audio, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, this.classroom.id, this.current.presenter, o.source, o.audio ? 1 : 0, t);
    await this.media.setPublish(identity, true);
    this.classroom.log('present.started', p.role === 'student' ? p.memberId : null, { source: o.source });
    this.emitEvent({ type: 'PresentationStarted', presentationId: id, presenter: this.current.presenter, source: o.source, audio: o.audio });
    return this.view();
  }

  source(p: Principal, o: { source: 'screen' | 'window'; audio: boolean }) {
    if (!this.current || this.current.identity !== mediaIdentity(p)) throw new JoinError(409, 'not_presenting', 'You are not presenting.');
    this.current = { ...this.current, source: o.source, audio: o.audio, state: 'live' };
    this.db.prepare('UPDATE presentations SET source = ?, audio = ? WHERE id = ?').run(o.source, o.audio ? 1 : 0, this.current.id);
    this.emitEvent({ type: 'PresentationSourceChanged', presentationId: this.current.id, presenter: this.current.presenter, source: o.source, audio: o.audio });
    return this.view();
  }

  /** The presenter, or anyone allowed to manage presenters. */
  async stopBy(p: Principal, presentationId?: string) {
    if (!this.current || (presentationId && presentationId !== this.current.id)) return;
    const own = this.current.identity === mediaIdentity(p);
    if (!own && !this.classroom.can(p, 'MANAGE_PRESENTERS')) throw new JoinError(403, 'forbidden', 'Only the presenter or the host can stop this.');
    await this.stop(own ? 'stopped' : 'stopped_by_host');
  }

  async stop(reason: string) {
    const c = this.current;
    if (!c) return;
    this.current = null;
    if (this.grace) { clearTimeout(this.grace); this.grace = null; }
    if (c.presenter !== 'host') this.approved.delete(c.presenter); // approval covers one presentation
    this.db.prepare('UPDATE presentations SET stopped_at = ?, stop_reason = ? WHERE id = ?').run(this.now(), reason, c.id);
    await this.media?.setPublish(c.identity, false);
    this.classroom.log('present.stopped', c.presenter === 'host' ? null : c.presenter, { reason });
    this.emitEvent({ type: 'PresentationStopped', presentationId: c.id, presenter: c.presenter, reason });
  }

  /** Presenter's CLAN connection dropped: keep the wall for a grace period, then end cleanly. */
  presence(memberId: string, connected: boolean) {
    if (!this.current || this.current.presenter !== memberId) return;
    if (connected) {
      if (this.grace) { clearTimeout(this.grace); this.grace = null; this.current = { ...this.current, state: 'live' }; this.emit('state'); }
      return;
    }
    if (this.grace) return;
    this.current = { ...this.current, state: 'reconnecting' };
    this.emit('state');
    this.grace = setTimeout(() => { this.grace = null; void this.stop('presenter_disconnected'); }, this.graceMs);
    this.grace.unref?.();
  }

  /** Removed/blocked: stop at once and cut the media connection (expiry is only a backstop). */
  async removed(memberId: string) {
    this.requests.delete(memberId); this.approved.delete(memberId);
    if (this.current?.presenter === memberId) await this.stop('member_removed');
    await this.media?.remove(memberId);
  }

  async end() {
    await this.stop('clan_ended');
    this.requests.clear(); this.approved.clear();
  }
}
