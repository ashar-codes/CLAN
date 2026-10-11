// The shared call state machine (desktop + phone): ringing, answer, connected on both sides, busy, decline, denied
// microphone, and signals for another call or from another person being ignored.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CallEngine, type PeerLike } from '../src/call-engine.ts';

type Ev = Record<string, ((e: object) => void)[]>;
class FakePeer implements PeerLike {
  iceGatheringState = 'complete'; connectionState = 'new'; localDescription: { type: string; sdp: string } | null = null; remote = false; ev: Ev = {};
  private cb: (p: FakePeer) => void;
  constructor(cb: (p: FakePeer) => void) { this.cb = cb; }
  addTrack() { return undefined; }
  async createOffer() { return { type: 'offer', sdp: `offer-${randomUUID()}` }; }
  async createAnswer() { return { type: 'answer', sdp: `answer-${randomUUID()}` }; }
  async setLocalDescription(d?: unknown) { this.localDescription = d as never; this.check(); }
  async setRemoteDescription() { this.remote = true; this.check(); }
  async addIceCandidate() {}
  async getStats() { return { forEach: (f: (s: { type: string; kind?: string; bytesReceived?: number }) => void) => f({ type: 'inbound-rtp', kind: 'audio', bytesReceived: 4000 }) }; }
  addEventListener(t: string, cb: (e: object) => void) { (this.ev[t] ??= []).push(cb); }
  close() { this.connectionState = 'closed'; }
  set(state: string) { this.connectionState = state; for (const f of this.ev.connectionstatechange ?? []) f({}); }
  private check() { if (this.remote && this.localDescription) this.cb(this); }
}
const stream = () => { const t = { enabled: true, stop() {} }; return { getTracks: () => [t], getAudioTracks: () => [t] }; };
const tick = () => new Promise((r) => setTimeout(r, 5));

function pair(o: { micB?: 'denied' } = {}) {
  const peers: FakePeer[] = [];
  const connectAll = () => { const live = peers.filter((p) => p.connectionState !== 'closed'); if (live.length === 2 && live.every((p) => p.remote && p.localDescription)) live.forEach((p) => p.set('connected')); };
  const mk = (me: string, other: () => CallEngine, mic?: 'denied') => new CallEngine({
    createPeer: () => { const p = new FakePeer(connectAll); peers.push(p); return p; },
    microphone: async () => { if (mic === 'denied') throw new Error('Microphone access was denied.'); return stream(); },
    signal: async (_k, body) => { queueMicrotask(() => other().onSignal(me, body as never)); return true; },
    log: () => {}, nameOf: async (k) => k.toUpperCase(), uuid: () => randomUUID(),
  });
  const a: CallEngine = mk('a', () => b), b: CallEngine = mk('b', () => a, o.micB);
  return { a, b };
}

describe('call engine', () => {
  it('rings, answers, connects both sides with audio stats, and hangs up for both', async () => {
    const { a, b } = pair();
    await a.start('b', 'Bilal'); await tick();
    expect(b.call).toMatchObject({ phase: 'ringing', dir: 'in', peerName: 'A' });
    await b.accept(); await tick(); await tick();
    expect(a.call?.phase).toBe('connected'); expect(b.call?.phase).toBe('connected');
    await new Promise((r) => setTimeout(r, 1100)); expect(a.call?.rx).toBeGreaterThan(0);
    a.hangup(); await tick();
    expect(a.call?.phase).toBe('ended'); expect(b.call).toMatchObject({ phase: 'ended', note: 'Call ended.' });
  });
  it('busy, decline and a denied microphone are reported to the caller', async () => {
    const p = pair(); await p.a.start('b', 'Bilal'); await tick();
    p.b.onSignal('c', { kind: 'call.invite', callId: randomUUID(), sdp: 'x' }); // someone else calls while ringing
    expect(p.b.call?.peerKey).toBe('a');
    p.b.hangup(); await tick();
    expect(p.a.call).toMatchObject({ phase: 'ended', note: 'Bilal declined the call.' });
    const q = pair({ micB: 'denied' }); await q.a.start('b', 'Bilal'); await tick();
    await q.b.accept(); await tick();
    expect(q.b.call?.note).toMatch(/denied/); expect(q.a.call?.note).toMatch(/microphone unavailable/);
  });
  it('ignores signals for another call or from another person', async () => {
    const p = pair(); await p.a.start('b', 'Bilal'); await tick();
    const id = p.a.call!.id;
    p.a.onSignal('mallory', { kind: 'call.end', callId: id, reason: 'hangup' });
    p.a.onSignal('b', { kind: 'call.end', callId: randomUUID(), reason: 'hangup' });
    expect(p.a.call?.phase).toBe('calling');
  });
});
