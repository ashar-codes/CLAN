// Platform-neutral student client: Electron renderer, React Native and Node (tests, simulator).
// All classroom traffic after pairing goes through a pinned `Transport` over HTTPS/WSS.
import { WS_CLOSE, type ClientMessage, type JoinResponse, type ServerMessage } from '@classroom/protocol';

export type Quality = 'excellent' | 'good' | 'poor' | 'disconnected';
export type Candidate = { url: string; title?: string; sid?: string };
export type JoinResult = JoinResponse & { url: string };

/** Minimal WebSocket surface used by ClassroomConnection (browser WebSocket, `ws`, React Native). */
export type WebSocketLike = {
  readyState: number; send(data: string | ArrayBuffer | ArrayBufferView): void; close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null; onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null; onerror: ((ev: unknown) => void) | null;
};
/**
 * How a client reaches the classroom after pairing. Implementations MUST only accept the PAKE-authenticated pinned
 * certificate: Node -> `pinnedTransport` (./node); Electron renderer -> platformTransport + main-process verify proc.
 */
export type Transport = { fetch(url: string, init?: RequestInit): Promise<Response>; openWebSocket(url: string): WebSocketLike };

/** Uses the platform's fetch/WebSocket. Only valid where the platform itself enforces the pin (Electron renderer). */
export const platformTransport: Transport = {
  fetch: (u, i) => fetch(u, i),
  openWebSocket: (u) => new WebSocket(u) as unknown as WebSocketLike,
};

/** Classroom APIs are HTTPS/WSS only. A plaintext URL here is a downgrade attempt or a bug — refuse it. */
export function assertSecureUrl(url: string) {
  if (!/^(https|wss):\/\//.test(url)) throw new TransferError('insecure_transport', 'Refusing to use an unencrypted classroom connection.');
}

export function qualityFromRtt(rttMs: number | null): Quality {
  if (rttMs === null) return 'disconnected';
  return rttMs < 60 ? 'excellent' : rttMs < 200 ? 'good' : 'poor';
}

type Handlers = {
  onMessage?: (m: ServerMessage) => void;
  onQuality?: (q: Quality, rttMs: number | null) => void;
  /** Session is permanently over for this client (ended, removed, token rejected). No more reconnects. */
  onClosed?: (reason: string) => void;
};

/** WebSocket connection that re-authenticates and reconnects with backoff across Wi-Fi drops. */
export class ClassroomConnection {
  private ws: WebSocketLike | null = null;
  private stopped = false;
  private attempt = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pings = new Map<number, number>();
  private n = 0;
  rtt: number | null = null;

  private url: string; private token: string; private h: Handlers; private pingMs: number;

  private transport: Transport;

  constructor(url: string, token: string, h: Handlers = {}, pingMs = 5000, transport: Transport = platformTransport) {
    assertSecureUrl(url);
    this.url = url; this.token = token; this.h = h; this.pingMs = pingMs; this.transport = transport;
    this.open();
  }

  send(m: ClientMessage) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
  }

  close() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.stopPing();
    this.ws?.close();
  }

  private open() {
    const ws = this.transport.openWebSocket(this.url.replace(/^https/, 'wss') + '/ws');
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'auth', token: this.token } satisfies ClientMessage));
      this.attempt = 0;
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), this.pingMs);
    };
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data)) as ServerMessage;
      if (m.t === 'pong') {
        const sent = this.pings.get(m.n);
        this.pings.delete(m.n);
        if (sent !== undefined) this.setRtt(Date.now() - sent);
      }
      this.h.onMessage?.(m);
    };
    ws.onclose = (ev) => {
      this.stopPing();
      this.setRtt(null);
      if (this.stopped) return;
      const fatal = ev.code === WS_CLOSE.authFailed || ev.code === WS_CLOSE.removed || ev.code === WS_CLOSE.ended;
      if (fatal) {
        this.stopped = true;
        return this.h.onClosed?.(ev.reason || 'closed');
      }
      const delay = Math.min(10_000, 500 * 2 ** this.attempt++) * (0.5 + Math.random() / 2);
      this.retryTimer = setTimeout(() => this.open(), delay);
    };
    ws.onerror = () => {}; // onclose follows and handles retry
  }

  private ping() {
    const n = ++this.n;
    this.pings.set(n, Date.now());
    // A ping unanswered for 3 intervals means the link is effectively down.
    // A dead Wi-Fi link may never deliver a TCP close, so abandon the socket and dial again.
    for (const t of this.pings.values()) if (Date.now() - t > this.pingMs * 3) return this.redial();
    this.send({ t: 'ping', n });
  }

  private redial() {
    const ws = this.ws;
    if (ws) { ws.onclose = null; ws.onmessage = null; ws.close(); }
    this.stopPing();
    this.setRtt(null);
    this.retryTimer = setTimeout(() => this.open(), 500);
  }

  private setRtt(rtt: number | null) {
    this.rtt = rtt;
    this.h.onQuality?.(qualityFromRtt(rtt), rtt);
  }

  private stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.pings.clear();
  }
}

// ---- Files & submissions (platform-neutral HTTP pieces; byte I/O lives in ./node or the mobile app) ----
import type { UploadInit, UploadStatus } from '@classroom/protocol';
export * from './pairing.ts';
export * from './swarm.ts';
export type * from './transports.ts';
export { SCREEN_PROFILES } from './transports.ts';

export class TransferError extends Error {
  code: string; status: number; extra: Record<string, unknown>;
  constructor(code: string, message: string, status = 0, extra: Record<string, unknown> = {}) { super(message); this.code = code; this.status = status; this.extra = extra; }
}

/** All authenticated HTTP goes through here so an encrypted transport can later replace it in one place. */
export async function api<T>(t: Transport, base: string, token: string, path: string, init: RequestInit = {}): Promise<T> {
  assertSecureUrl(base);
  const res = await t.fetch(base + path, { ...init, headers: { authorization: `Bearer ${token}`, ...(init.body && typeof init.body === 'string' ? { 'content-type': 'application/json' } : {}), ...(init.headers as Record<string, string>) } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new TransferError(body.code ?? 'http_' + res.status, body.message ?? `Request failed (${res.status})`, res.status, body);
  return body as T;
}

export const resourceContentPath = (id: string) => `/api/resources/${encodeURIComponent(id)}/content`;
export const initUpload = (t: Transport, base: string, token: string, req: UploadInit) => api<UploadStatus>(t, base, token, '/api/uploads', { method: 'POST', body: JSON.stringify(req) });
export const uploadStatus = (t: Transport, base: string, token: string, uploadId: string) => api<UploadStatus>(t, base, token, `/api/uploads/${encodeURIComponent(uploadId)}`);

/** Bytes as "4.2 MB". */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
}

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(signal.reason); }, { once: true });
});
