// JS side of the native pinned transport. Implements the PinnedNativeTransport seam: every request/socket goes through
// a native client that trusts ONLY the per-class CA + leaf SPKI pin from the OPAQUE-authenticated binding.
import { requireNativeModule } from 'expo-modules-core';
import { assertSecureUrl, TransferError, type WebSocketLike } from '@classroom/client';
import type { TlsBinding } from '@classroom/protocol';
import type { PinnedNativeTransport } from '../../src/native';

type Ev = { id: string; bytes?: number; data?: string; code?: number; reason?: string };
type NativeApi = {
  configure(id: string, caDerB64: string, pinB64: string): void;
  release(id: string): void;
  request(id: string, method: string, url: string, headers: Record<string, string>, body: string | null): Promise<{ status: number; headers: Record<string, string>; body: string }>;
  download(id: string, reqId: string, url: string, headers: Record<string, string>, fileUri: string, append: boolean): Promise<{ status: number; bytes: number }>;
  upload(id: string, reqId: string, url: string, headers: Record<string, string>, fileUri: string, offset: number): Promise<{ status: number; body: string }>;
  cancel(reqId: string): void;
  wsOpen(id: string, wsId: string, url: string): void;
  wsSend(wsId: string, text: string): unknown;
  wsClose(wsId: string, code: number, reason: string): void;
  addListener(event: 'progress' | 'wsOpen' | 'wsMessage' | 'wsClose', cb: (e: Ev) => void): { remove(): void };
};

const Native = requireNativeModule<NativeApi>('PinnedTransport');
let seq = 0;
const newId = (p: string) => `${p}-${Date.now().toString(36)}-${(++seq).toString(36)}`;
const headerRecord = (h?: HeadersInit): Record<string, string> => {
  const out: Record<string, string> = {};
  if (!h) return out;
  if (Array.isArray(h)) for (const [k, v] of h) out[k.toLowerCase()] = v;
  else if (typeof (h as Headers).forEach === 'function') (h as Headers).forEach((v, k) => { out[k.toLowerCase()] = v; });
  else for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = v;
  return out;
};

function on(event: 'progress' | 'wsOpen' | 'wsMessage' | 'wsClose', id: string, cb: (e: Ev) => void) {
  const sub = Native.addListener(event, (e) => { if (e.id === id) cb(e); });
  return () => sub.remove();
}

class NativeSocket implements WebSocketLike {
  readyState = 0;
  onopen: WebSocketLike['onopen'] = null;
  onmessage: WebSocketLike['onmessage'] = null;
  onclose: WebSocketLike['onclose'] = null;
  onerror: WebSocketLike['onerror'] = null;
  private id = newId('ws');
  private off: (() => void)[] = [];
  constructor(conn: string, url: string) {
    this.off.push(on('wsOpen', this.id, () => { this.readyState = 1; this.onopen?.({}); }));
    this.off.push(on('wsMessage', this.id, (e) => this.onmessage?.({ data: e.data })));
    this.off.push(on('wsClose', this.id, (e) => { this.readyState = 3; this.off.forEach((f) => f()); this.onclose?.({ code: e.code ?? 1006, reason: e.reason ?? '' }); }));
    Native.wsOpen(conn, this.id, url);
  }
  send(data: string) { if (this.readyState === 1) void Native.wsSend(this.id, data); }
  close(code = 1000, reason = '') { if (this.readyState < 2) { this.readyState = 2; Native.wsClose(this.id, code, reason); } }
}

export function pinnedNativeTransport(b: Pick<TlsBinding, 'certificate' | 'spkiSha256'>): PinnedNativeTransport {
  const conn = newId('conn');
  Native.configure(conn, b.certificate, b.spkiSha256);
  return {
    async fetch(url, init = {}) {
      assertSecureUrl(url);
      if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new TransferError('unsupported', 'Use uploadFromFile for binary bodies.');
      const r = await Native.request(conn, init.method ?? 'GET', url, headerRecord(init.headers), (init.body as string | undefined) ?? null);
      return new Response(r.body, { status: r.status, headers: r.headers });
    },
    openWebSocket(url) {
      assertSecureUrl(url);
      return new NativeSocket(conn, url);
    },
    async downloadToFile(url, headers, fileUri, offset, onProgress, signal) {
      assertSecureUrl(url);
      const reqId = newId('dl');
      const offP = on('progress', reqId, (e) => onProgress(e.bytes ?? 0));
      const abort = () => Native.cancel(reqId);
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const r = await Native.download(conn, reqId, url, headers, fileUri, offset > 0);
        if (r.status !== 200 && r.status !== 206) throw new TransferError('http_' + r.status, `Download failed (${r.status})`, r.status);
        return r.bytes;
      } finally { offP(); signal?.removeEventListener('abort', abort); }
    },
    async uploadFromFile(url, headers, fileUri, offset, onProgress) {
      assertSecureUrl(url);
      const reqId = newId('up');
      const offP = on('progress', reqId, (e) => onProgress(e.bytes ?? 0));
      try { return await Native.upload(conn, reqId, url, headers, fileUri, offset); } finally { offP(); }
    },
  };
}
