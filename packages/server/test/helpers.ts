import { randomUUID } from 'node:crypto';
import type { ServerMessage, StudentProfile } from '@classroom/protocol';

export const profile = (n = 1): StudentProfile => ({ fullName: `Student ${n}`, rollNo: `FA23-CS-${100 + n}`, deviceName: `Laptop-${n}`, deviceId: randomUUID() });

export async function post(url: string, body: unknown, raw = false) {
  const res = await fetch(url + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw ? (body as string) : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) };
}

/** Minimal test socket: collects messages, lets tests await a predicate. */
export function socket(url: string, token?: string) {
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
  const msgs: ServerMessage[] = [];
  const waiters: { pred: (m: ServerMessage) => boolean; res: (m: ServerMessage) => void }[] = [];
  let closed: { code: number; reason: string } | null = null;
  const closeWaiters: ((c: { code: number; reason: string }) => void)[] = [];
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data));
    msgs.push(m);
    for (const w of [...waiters]) if (w.pred(m)) { waiters.splice(waiters.indexOf(w), 1); w.res(m); }
  };
  ws.onclose = (e) => { closed = { code: e.code, reason: e.reason }; closeWaiters.forEach((f) => f(closed!)); };
  const opened = new Promise<void>((r) => (ws.onopen = () => { if (token) ws.send(JSON.stringify({ t: 'auth', token })); r(); }));
  return {
    ws, msgs, opened,
    send: (m: unknown) => ws.send(typeof m === 'string' ? m : JSON.stringify(m)),
    next<T extends ServerMessage['t']>(t: T, pred: (m: Extract<ServerMessage, { t: T }>) => boolean = () => true, ms = 3000) {
      const hit = msgs.find((m) => m.t === t && pred(m as never));
      if (hit) { msgs.splice(msgs.indexOf(hit), 1); return Promise.resolve(hit as Extract<ServerMessage, { t: T }>); }
      return new Promise<Extract<ServerMessage, { t: T }>>((res, rej) => {
        const timer = setTimeout(() => rej(new Error(`timeout waiting for ${t}`)), ms);
        waiters.push({ pred: (m) => m.t === t && pred(m as never), res: (m) => { clearTimeout(timer); msgs.splice(msgs.indexOf(m), 1); res(m as never); } });
      });
    },
    closed: () => (closed ? Promise.resolve(closed) : new Promise<{ code: number; reason: string }>((r) => closeWaiters.push(r))),
    close: () => ws.close(),
  };
}
