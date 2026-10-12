import { DirectoryReply, internalEndpoint, directoryConfig, type DirectoryAdvert, type DirectoryConfig } from '@classroom/protocol';
import { peerAuthHeaders, type PeerKeySigner } from './people-auth.ts';
export type DirectoryFetch = (url: string, init: RequestInit) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
/** Transport supplied by platform's existing certificate-pinned implementation; never global unpinned fetch. */
export function lanDirectoryClient(o: { config: DirectoryConfig; signer: PeerKeySigner; fetch: DirectoryFetch; nonce(): string; allowLoopback?: boolean }) {
  const config = directoryConfig(o.config, o.allowLoopback);
  const post = async (path: string, value: unknown) => {
    const body = JSON.stringify(value), result = await o.fetch(config.url + path, { method: 'POST', headers: { ...peerAuthHeaders(o.signer, { method: 'POST', path, body, to: config.spkiSha256, nonce: o.nonce() }), 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(5000), redirect: 'error' });
    if (!result.ok) throw new Error(`LAN directory unavailable or enrollment refused (${result.status}). Direct connections still work.`);
    const text = await result.text(); if (text.length > 128 * 1024) throw Error('Oversized directory response.'); return JSON.parse(text) as unknown;
  };
  return {
    register: (adverts: DirectoryAdvert[]) => post('/lan/register', { adverts }),
    lookup: async () => { const r = DirectoryReply.parse(await post('/lan/lookup', {})); if (r.adverts.some((a) => a.endpoints.some((e) => !internalEndpoint(e, o.allowLoopback)))) throw Error('Unsafe directory endpoint.'); return r; },
  };
}
/** Single in-flight round and generation fencing. Native availability pulses may call this; no JS timer assumption. */
export class LanDirectoryAgent {
  private generation = 0; private next = 0; private failures = 0; private pending: Promise<void> | null = null;
  private client: ReturnType<typeof lanDirectoryClient> | null = null;
  private readonly own: () => DirectoryAdvert[]; private readonly receive: (items: DirectoryAdvert[], expires: number) => void; private readonly status: (message: string) => void;
  constructor(own: () => DirectoryAdvert[], receive: (items: DirectoryAdvert[], expires: number) => void, status: (message: string) => void = () => {}) { this.own = own; this.receive = receive; this.status = status; }
  configure(client: ReturnType<typeof lanDirectoryClient> | null) { this.generation++; this.client = client; this.next = 0; this.failures = 0; this.receive([], 0); }
  async refresh(force = false): Promise<void> {
    if (!this.client || !force && Date.now() < this.next) return;
    if (this.pending) return this.pending;
    const client = this.client, gen = this.generation;
    this.next = Date.now() + 30_000;
    return this.pending = (async () => { await null; try {
      await client.register(this.own()); const r = await client.lookup();
      if (gen !== this.generation) return;
      this.failures = 0; this.receive(r.adverts, Date.now() + r.ttlMs); this.status('Internal Network directory available. Peer authentication is still required.');
    } catch { if (gen !== this.generation) return; this.next = Date.now() + Math.min(120_000, 5000 * 2 ** Math.min(++this.failures, 5)); this.receive([], 0); this.status('LAN directory unavailable or not enrolled. Use local discovery or a trusted QR/address; check internal routing with your administrator.'); }
    finally { this.pending = null; } })();
  }
}
