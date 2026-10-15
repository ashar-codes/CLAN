// Minimum notification relay for internet-assisted wake-ups (docs/FINAL_COMMUNICATION_ARCHITECTURE.md). NOT deployed by
// CLAN: an operator runs it (push-relay-cli.ts) with their own Firebase/Apple credentials. It stores only
// device key -> push token and sha256(capability) -> device; never names, friend keys, messages or files.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createSign, createHash } from 'node:crypto';
import { connect as h2connect } from 'node:http2';
import { DatabaseSync } from 'node:sqlite';
import { capHash, PushGrant, PushNotify, PushRegister, PushRevoke, pushStatement, verifyStatement, PUSH_SKEW_MS, type PushEvent } from '@classroom/protocol';

export type PushTarget = { platform: 'fcm' | 'apns' | 'apns-voip'; token: string; topic: string | null };
export type PushSender = (t: PushTarget, e: PushEvent) => Promise<{ ok: boolean; gone?: boolean; error?: string }>;
export type RelayOptions = { dbPath?: string; senders: { fcm?: PushSender; apns?: PushSender }; topics?: string[]; now?: () => number };

const LIMIT = { capPerMin: 30, callPerMin: 6, ipPerMin: 300, capsPerDevice: 500 };

export function pushRelay(o: RelayOptions) {
  const now = o.now ?? Date.now, db = new DatabaseSync(o.dbPath ?? ':memory:');
  db.exec(`CREATE TABLE IF NOT EXISTS devices (device TEXT NOT NULL, platform TEXT NOT NULL, token TEXT NOT NULL, topic TEXT, at INTEGER NOT NULL, PRIMARY KEY (device, platform));
    CREATE TABLE IF NOT EXISTS caps (hash TEXT PRIMARY KEY, cap_id TEXT NOT NULL, device TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS caps_device ON caps(device);`);
  const nonces = new Map<string, number>(), hits = new Map<string, number[]>();
  const rate = (k: string, max: number) => {
    const t = now(), a = (hits.get(k) ?? []).filter((x) => x > t - 60_000);
    if (a.length >= max) return false;
    a.push(t); hits.set(k, a); if (hits.size > 50_000) hits.clear(); return true;
  };
  /** Only the device itself may change its registration: signature, fresh timestamp, unseen nonce. */
  const authentic = (b: { device: string; ts: number; nonce: string; sig: string }) => {
    const t = now();
    for (const [n, at] of nonces) if (at < t - 2 * PUSH_SKEW_MS) nonces.delete(n);
    if (Math.abs(t - b.ts) > PUSH_SKEW_MS || nonces.has(b.nonce) || !verifyStatement(b.device, pushStatement(b), b.sig)) return false;
    nonces.set(b.nonce, t); return true;
  };

  async function handle(path: string, raw: unknown, ip: string): Promise<[number, object]> {
    if (!rate(`ip:${ip}`, LIMIT.ipPerMin)) return [429, { error: 'rate_limited' }];
    if (path === '/v1/register') {
      const b = PushRegister.safeParse(raw); if (!b.success || !authentic(b.data)) return [403, { error: 'refused' }];
      if (b.data.platform !== 'fcm' && o.topics && !o.topics.includes(b.data.topic ?? '')) return [403, { error: 'topic' }];
      db.prepare('INSERT OR REPLACE INTO devices (device, platform, token, topic, at) VALUES (?, ?, ?, ?, ?)').run(b.data.device, b.data.platform, b.data.token, b.data.topic ?? null, now());
      return [200, { ok: true }];
    }
    if (path === '/v1/grant') {
      const b = PushGrant.safeParse(raw); if (!b.success || !authentic(b.data)) return [403, { error: 'refused' }];
      if (!db.prepare('SELECT 1 FROM devices WHERE device = ?').get(b.data.device)) return [409, { error: 'register first' }];
      if ((db.prepare('SELECT count(*) n FROM caps WHERE device = ?').get(b.data.device) as { n: number }).n >= LIMIT.capsPerDevice) return [429, { error: 'too many' }];
      db.prepare('INSERT OR REPLACE INTO caps (hash, cap_id, device, at) VALUES (?, ?, ?, ?)').run(b.data.capHash, b.data.capId, b.data.device, now());
      return [200, { ok: true }];
    }
    if (path === '/v1/revoke') {
      const b = PushRevoke.safeParse(raw); if (!b.success || !authentic(b.data)) return [403, { error: 'refused' }];
      if (b.data.capId) db.prepare('DELETE FROM caps WHERE device = ? AND cap_id = ?').run(b.data.device, b.data.capId);
      else { db.prepare('DELETE FROM caps WHERE device = ?').run(b.data.device); db.prepare('DELETE FROM devices WHERE device = ?').run(b.data.device); }
      return [200, { ok: true }];
    }
    if (path === '/v1/notify') {
      const b = PushNotify.safeParse(raw); if (!b.success) return [400, { error: 'invalid' }];
      const e = b.data.event, h = capHash(b.data.cap), t = now();
      if (e.exp <= t) return [410, { error: 'expired' }];
      const cap = db.prepare('SELECT device, cap_id FROM caps WHERE hash = ?').get(h) as { device: string; cap_id: string } | undefined;
      if (!cap || cap.cap_id !== e.c) return [404, { error: 'unknown' }];
      const call = e.k === 'call' || e.k === 'call.cancel';
      if (!rate(`cap:${h}`, LIMIT.capPerMin) || (call && !rate(`call:${h}`, LIMIT.callPerMin))) return [429, { error: 'rate_limited' }];
      const regs = db.prepare('SELECT platform, token, topic FROM devices WHERE device = ?').all(cap.device) as PushTarget[];
      // a VoIP push (iOS CallKit) only for calls; an ordinary alert otherwise
      const pick = regs.filter((r) => r.platform === 'fcm' || (call && r.platform === 'apns-voip') || (r.platform === 'apns' && !(call && regs.some((x) => x.platform === 'apns-voip'))));
      let sent = 0;
      for (const r of pick) {
        const s = r.platform === 'fcm' ? o.senders.fcm : o.senders.apns;
        if (!s) continue;
        const res = await s(r, e).catch((err: Error) => ({ ok: false, error: err.message, gone: false }));
        if (res.ok) sent++;
        else if (res.gone) db.prepare('DELETE FROM devices WHERE device = ? AND platform = ?').run(cap.device, r.platform);
      }
      return sent ? [200, { ok: true }] : [503, { error: 'not delivered to the push service' }];
    }
    return [404, { error: 'not found' }];
  }
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    const reply = (s: number, b: object) => { res.writeHead(s, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(b)); };
    if (req.method !== 'POST') return reply(405, { error: 'method' });
    let size = 0; const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size > 8192) { reply(413, { error: 'too large' }); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (res.headersSent) return;
      let body: unknown; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reply(400, { error: 'json' }); }
      void handle(req.url ?? '', body, req.socket.remoteAddress ?? '?').then(([s, b]) => reply(s, b), () => reply(500, { error: 'internal' }));
    });
  };
  return { handle, listener, server: () => createServer(listener), close: () => db.close() };
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const jwt = (header: object, claims: object, sign: (data: string) => Buffer) => { const d = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`; return `${d}.${b64u(sign(d))}`; };
const TEXT: Record<string, string> = { msg: 'New message', file: 'New file', call: 'Incoming call', 'call.cancel': 'Missed call', missed: 'Missed call', meeting: 'Meeting invitation' };

/** Firebase Cloud Messaging HTTP v1 with a service account (data message; the app shows the notification itself). */
export function fcmSender(sa: { project_id: string; client_email: string; private_key: string }, fetchImpl: typeof fetch = fetch): PushSender {
  let token: { v: string; until: number } | null = null;
  const access = async () => {
    if (token && token.until > Date.now() + 60_000) return token.v;
    const t = Math.floor(Date.now() / 1000);
    const assertion = jwt({ alg: 'RS256', typ: 'JWT' }, { iss: sa.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: t, exp: t + 3600 },
      (d) => createSign('RSA-SHA256').update(d).sign(sa.private_key));
    const r = await fetchImpl('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
    if (!r.ok) throw new Error(`FCM auth ${r.status}`);
    const j = await r.json() as { access_token: string; expires_in: number };
    token = { v: j.access_token, until: Date.now() + j.expires_in * 1000 };
    return token.v;
  };
  return async (t, e) => {
    const ttl = Math.max(1, Math.round((e.exp - Date.now()) / 1000));
    const r = await fetchImpl(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, { method: 'POST', headers: { authorization: `Bearer ${await access()}`, 'content-type': 'application/json' },
      // High priority only because every wake-up becomes a user-visible notification on the phone (message, call, missed call).
      body: JSON.stringify({ message: { token: t.token, data: { clan: JSON.stringify(e) }, android: { priority: 'high', ttl: `${ttl}s`, ...(e.k === 'msg' || e.k === 'file' ? { collapse_key: e.c } : {}) } } }) });
    if (r.ok) return { ok: true };
    const body = await r.text();
    return { ok: false, gone: r.status === 404 || body.includes('UNREGISTERED'), error: `FCM ${r.status}` };
  };
}

/** Apple Push Notification service over HTTP/2 with a token-based (.p8) provider key. */
export function apnsSender(k: { teamId: string; keyId: string; privateKey: string; production: boolean }): PushSender {
  let token: { v: string; at: number } | null = null;
  const bearer = () => {
    if (token && Date.now() - token.at < 50 * 60_000) return token.v;
    token = { v: jwt({ alg: 'ES256', kid: k.keyId }, { iss: k.teamId, iat: Math.floor(Date.now() / 1000) }, (d) => createSign('SHA256').update(d).sign({ key: k.privateKey, dsaEncoding: 'ieee-p1363' })), at: Date.now() };
    return token.v;
  };
  return (t, e) => new Promise((resolve) => {
    const voip = t.platform === 'apns-voip', topic = `${t.topic}${voip ? '.voip' : ''}`;
    const payload = voip ? { clan: e } : { aps: { alert: { title: 'CLAN', body: TEXT[e.k] ?? 'CLAN' }, sound: 'default', 'thread-id': createHash('sha256').update(e.c).digest('hex').slice(0, 16) }, clan: e };
    const s = h2connect(k.production ? 'https://api.push.apple.com' : 'https://api.sandbox.push.apple.com');
    s.on('error', (err) => resolve({ ok: false, error: err.message }));
    const req = s.request({ ':method': 'POST', ':path': `/3/device/${t.token}`, authorization: `bearer ${bearer()}`, 'apns-topic': topic, 'apns-push-type': voip ? 'voip' : 'alert', 'apns-priority': '10',
      'apns-expiration': String(Math.floor(e.exp / 1000)), ...(e.k === 'msg' ? { 'apns-collapse-id': e.c } : {}) });
    let status = 0;
    req.on('response', (h) => { status = Number(h[':status']); });
    req.on('data', () => {});
    req.on('end', () => { s.close(); resolve(status === 200 ? { ok: true } : { ok: false, gone: status === 410, error: `APNs ${status}` }); });
    req.end(JSON.stringify(payload));
  });
}
