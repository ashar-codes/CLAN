// Narrow RPC between the React Native app and an isolated WebView that runs the official @serenity-kit/opaque 1.x
// WASM build (Hermes has no WebAssembly). The WebView exposes exactly three operations; anything else is rejected.
// OPAQUE client login state never leaves the WebView: the app only ever holds an opaque random handle.
import type { OpaqueClient } from './pairing.ts';

type Ids = { client?: string; server?: string };
export type BridgeRequest =
  | { id: number; op: 'startLogin'; password: string }
  | { id: number; op: 'finishLogin'; handle: string; loginResponse: string; password: string; identifiers?: Ids }
  | { id: number; op: 'discard'; handle: string };
export type BridgeResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
type Without<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never; // distributive Omit

/** The real library's synchronous client API (what runs inside the WebView). */
export type SyncOpaqueClient = {
  startLogin(p: { password: string }): { clientLoginState: string; startLoginRequest: string };
  finishLogin(p: { clientLoginState: string; loginResponse: string; password: string; identifiers?: Ids }): { finishLoginRequest: string; sessionKey: string } | undefined;
};

const MAX_MSG = 64 * 1024;
const MAX_STATES = 16;
const b64url = /^[A-Za-z0-9_-]{1,8192}$/;
const isStr = (v: unknown, max = 8192): v is string => typeof v === 'string' && v.length <= max;

/**
 * Runs inside the WebView. Strictly validates every field; keeps at most a few login states, deleted after use.
 * Returns the JSON reply (or null for messages that aren't well-formed requests).
 */
export function createBridgeHandler(lib: SyncOpaqueClient, randomHandle: () => string) {
  const states = new Map<string, string>();
  return (raw: unknown): string | null => {
    if (typeof raw !== 'string' || raw.length > MAX_MSG) return null;
    let req: BridgeRequest;
    try { req = JSON.parse(raw); } catch { return null; }
    if (!req || typeof req !== 'object' || !Number.isInteger(req.id)) return null;
    const reply = (r: Without<BridgeResponse, 'id'>) => JSON.stringify({ id: req.id, ...r });
    try {
      switch (req.op) {
        case 'startLogin': {
          if (!isStr(req.password, 128)) throw new Error('bad request');
          if (states.size >= MAX_STATES) states.delete(states.keys().next().value!);
          const { clientLoginState, startLoginRequest } = lib.startLogin({ password: req.password });
          const handle = randomHandle();
          states.set(handle, clientLoginState);
          return reply({ ok: true, result: { clientLoginState: handle, startLoginRequest } });
        }
        case 'finishLogin': {
          if (!isStr(req.handle, 64) || !isStr(req.password, 128) || !isStr(req.loginResponse) || !b64url.test(req.loginResponse)) throw new Error('bad request');
          const ids = req.identifiers;
          if (ids !== undefined && (typeof ids !== 'object' || (ids.client !== undefined && !isStr(ids.client, 256)) || (ids.server !== undefined && !isStr(ids.server, 256)))) throw new Error('bad request');
          const state = states.get(req.handle);
          states.delete(req.handle); // single use, whatever happens
          if (!state) throw new Error('unknown handle');
          const r = lib.finishLogin({ clientLoginState: state, loginResponse: req.loginResponse, password: req.password, identifiers: ids && { client: ids.client, server: ids.server } });
          return reply({ ok: true, result: r ? { finishLoginRequest: r.finishLoginRequest, sessionKey: r.sessionKey } : null });
        }
        case 'discard':
          if (isStr(req.handle, 64)) states.delete(req.handle);
          return reply({ ok: true, result: null });
        default:
          throw new Error('unsupported operation');
      }
    } catch (e) {
      return reply({ ok: false, error: e instanceof Error && /bad request|unknown handle|unsupported/.test(e.message) ? e.message : 'opaque error' });
    }
  };
}

/**
 * App side: an OpaqueClient over a message channel to the WebView. `send` posts a string into the WebView;
 * call the returned `receive` with every string the WebView posts back.
 */
export function bridgedOpaqueClient(send: (msg: string) => void, timeoutMs = 15_000): { client: OpaqueClient; receive(msg: string): void } {
  let next = 1;
  const waiting = new Map<number, { res(v: unknown): void; rej(e: Error): void; t: ReturnType<typeof setTimeout> }>();
  const call = <T>(req: Without<BridgeRequest, 'id'>): Promise<T> => new Promise((res, rej) => {
    const id = next++;
    const t = setTimeout(() => { waiting.delete(id); rej(new Error('Secure pairing component did not respond.')); }, timeoutMs);
    waiting.set(id, { res: res as (v: unknown) => void, rej, t });
    send(JSON.stringify({ ...req, id }));
  });
  return {
    client: {
      startLogin: (p) => call({ op: 'startLogin', password: p.password }),
      finishLogin: async (p) => (await call<{ finishLoginRequest: string; sessionKey: string } | null>({ op: 'finishLogin', handle: p.clientLoginState, loginResponse: p.loginResponse, password: p.password, identifiers: p.identifiers })) ?? undefined,
    },
    receive(msg: string) {
      let r: BridgeResponse;
      try { r = JSON.parse(msg); } catch { return; }
      const w = waiting.get(r?.id);
      if (!w) return;
      waiting.delete(r.id);
      clearTimeout(w.t);
      if (r.ok) w.res(r.result); else w.rej(new Error(`Secure pairing failed (${r.error}).`));
    },
  };
}
