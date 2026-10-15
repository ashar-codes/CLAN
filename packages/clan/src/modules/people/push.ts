// Optional internet-assisted wake-ups (docs/FINAL_COMMUNICATION_ARCHITECTURE.md). Recipient side: register this
// phone's FCM/APNs token with our relay and give each friend a capability for it. Sender side (every device): when an
// envelope to a friend stays undelivered for a few seconds, or a live call cannot reach them, ask THEIR relay to wake
// them. A wake-up carries no content; the message itself still travels only over the authenticated CLAN link.
import { capHash, pushMac, pushStatement, type PushKind } from '@classroom/protocol';
import type { People } from './index.ts';

export type PushDevice = { platform: 'fcm' | 'apns' | 'apns-voip'; token: string; topic?: string };
type Fetch = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ status: number; ok: boolean }>;

export class PushAgent {
  private readonly p: People;
  private readonly o: { fetch: Fetch; sign(bytes: Uint8Array): string; devices(): PushDevice[]; nonce(): string; now?: () => number };
  private registered = new Map<string, string>(); // relay|platform -> token the relay confirmed
  private running: Promise<void> | null = null;
  status = 'Internet-assisted notifications are off.';
  constructor(p: People, o: PushAgent['o']) { this.p = p; this.o = o; }
  private now() { return this.o.now?.() ?? Date.now(); }

  private async post(relay: string, path: string, body: object) {
    try { const r = await this.o.fetch(new URL(path, relay).toString(), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return r.status; }
    catch { return 0; } // offline / relay unreachable: retried later
  }
  private signed<T extends Record<string, unknown>>(o: T) {
    const body = { ...o, device: this.p.myKey(), ts: this.now(), nonce: this.o.nonce() };
    return { ...body, sig: this.o.sign(pushStatement(body)) };
  }

  /** One pass; safe to call often (network change, app foreground, every minute). Never throws. */
  tick() { return this.running ??= this.pass().finally(() => { this.running = null; }); }
  private async pass() {
    try {
      for (const g of this.p.wakeGrants('revoke')) if ([200, 404].includes(await this.post(g.relay, '/v1/revoke', this.signed({ op: 'revoke', capId: g.capId })))) this.p.wakeRevoked(g.capId);
      const relay = this.p.pushRelay(), devices = this.o.devices();
      if (relay && devices.length) {
        let ok = 0;
        for (const d of devices) {
          const id = `${relay}|${d.platform}`;
          if (this.registered.get(id) === d.token) { ok++; continue; }
          const s = await this.post(relay, '/v1/register', this.signed({ op: 'register', platform: d.platform, token: d.token, ...(d.topic ? { topic: d.topic } : {}) }));
          if (s === 200) { this.registered.set(id, d.token); ok++; }
        }
        if (ok) {
          for (const k of this.p.wakeGrantsWanted()) this.p.newWakeGrant(k);
          for (const g of this.p.wakeGrants('new')) if (await this.post(relay, '/v1/grant', this.signed({ op: 'grant', capId: g.capId, capHash: capHash(g.cap) })) === 200) this.p.wakeGranted(g.capId);
          this.status = `Registered with ${new URL(relay).host}. Friends who are online receive your wake-up permission.`;
        } else this.status = 'The notification relay could not be reached (it needs internet). Local messaging still works.';
      } else this.status = !relay ? 'No notification relay configured: LAN only.' : 'This device has no push token (push is not configured in this build).';
      for (const w of this.p.wakesDue(this.now())) {
        const ev = { k: w.kind as PushKind, id: w.ref, exp: w.expiresAt, c: w.grant.capId };
        const s = await this.post(w.grant.relay, '/v1/notify', { op: 'notify', cap: w.grant.cap, event: { ...ev, m: pushMac(w.grant.mac, ev) } });
        if (s === 200) this.p.wakeSent(w.id); else this.p.wakeFailed(w.id, s >= 400 && s < 500 && s !== 429);
      }
    } catch (e) { this.status = `Notification relay error: ${(e as Error).message}`; }
  }
}
