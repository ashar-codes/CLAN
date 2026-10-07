// Child process: hosts several simulated students (each a real PeerAgent with its own peer server) for bench-swarm.ts.
import * as opaque from '@serenity-kit/opaque';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pairAndJoin } from '@classroom/client';
import { newEd25519, nodeSigner, pinnedTransport } from '@classroom/client/node';
import { PeerAgent } from '@classroom/client/peer';

type Ready = { url: string; bootstrapUrl: string; sessionId: string; code: string; teacherKey: string };
const [count, offset, host, canSeed] = [Number(process.argv[2]), Number(process.argv[3]), process.argv[4] ?? '127.0.0.1', process.argv[5] !== 'noseed'];
const dirs: string[] = [];
const timing: [number, number, number][] = [];
let agents: PeerAgent[] = [];

process.on('message', async (m: { t: string; cfg?: Ready; resource?: { id: string; name: string; size: number; sha256: string }; peerAssist?: boolean; smallFileBytes?: number }) => {
  if (m.t === 'join') {
    await opaque.ready;
    const c = m.cfg!;
    agents = await Promise.all(Array.from({ length: count }, async (_, k) => {
      const i = offset + k;
      const device = nodeSigner(newEd25519().privatePkcs8);
      const j = await pairAndJoin({ candidates: [{ url: c.bootstrapUrl, sid: c.sessionId }], code: c.code, profile: { fullName: `Sim ${i}`, rollNo: `S-${i}`, deviceName: 'sim' }, device, opaque: opaque.client, transportFor: pinnedTransport });
      const d = mkdtempSync(join(tmpdir(), 'bench-swarm-')); dirs.push(d);
      // Debug: time peer fetches (headers vs body) to locate waits.
      const transportFor = process.env.CLASSROOM_SWARM_DEBUG ? (e: Parameters<typeof pinnedTransport>[0] extends infer _ ? any : never) => {
        const t = pinnedTransport({ certificate: e.payload.tlsCa, spkiSha256: e.payload.tlsSpkiSha256 });
        return { ...t, fetch: async (u: string, i?: RequestInit) => { const t0 = performance.now(); const r = await t.fetch(u, i); const th = performance.now() - t0; const body = await r.arrayBuffer(); timing.push([th, performance.now() - t0 - th, r.status]); return new Response(body, { status: r.status }); } };
      } : undefined;
      return new PeerAgent({ transport: j.transport, url: j.url, token: () => j.token, sessionId: c.sessionId, teacherKey: c.teacherKey, device, host, destDir: d, canSeed, limits: { maxConcurrent: 8 }, transportFor });
    }));
    await Promise.all(agents.map((a) => a.start()));
    process.send!({ t: 'joined' });
  }
  if (m.t === 'go') {
    const cpu0 = process.cpuUsage();
    const results = await Promise.all(agents.map(async (a) => {
      const t0 = performance.now();
      try {
        const out = await a.acquire(m.resource!, { peerAssist: !!m.peerAssist, chunkTimeoutMs: 20_000, stallTimeoutMs: 120_000, smallFileBytes: m.smallFileBytes });
        const ok = createHash('sha256').update(readFileSync(out.path)).digest('hex') === m.resource!.sha256;
        rmSync(out.path, { force: true });
        if (process.env.CLASSROOM_SWARM_DEBUG) { const p = out.stats.sources.filter((x) => x.kind === 'peer'); const t = out.stats.sources.find((x) => x.kind === 'teacher'); console.log('[lat]', JSON.stringify({ peerAvgMs: p.reduce((a, x) => a + x.totalMs, 0) / Math.max(1, p.reduce((a, x) => a + x.chunks, 0)), teacherAvgMs: t && t.chunks ? t.totalMs / t.chunks : null, peerChunks: p.reduce((a, x) => a + x.chunks, 0) })); }
        return { ok, ms: performance.now() - t0, teacherBytes: out.stats.teacherBytes, peerBytes: out.stats.peerBytes, retries: out.stats.retries, corrupt: out.stats.corruptChunks, failed: out.stats.failedChunks, sources: out.stats.sources.filter((s) => s.chunks > 0).length, mode: out.stats.mode };
      } catch (e) { return { ok: false, ms: performance.now() - t0, error: (e as Error).message, teacherBytes: 0, peerBytes: 0, retries: 0, corrupt: 0, failed: 0, sources: 0, mode: 'error' }; }
    }));
    const c = process.cpuUsage(cpu0);
    if (process.env.CLASSROOM_SWARM_DEBUG && timing.length) {
      const hs = timing.map((x) => x[0]).sort((a, b) => a - b), bs = timing.map((x) => x[1]).sort((a, b) => a - b);
      const q = (a: number[], p: number) => a[Math.floor(a.length * p)]!.toFixed(0);
      console.log('[fetch]', JSON.stringify({ n: timing.length, headersP50: q(hs, 0.5), headersP95: q(hs, 0.95), headersMax: q(hs, 0.999), bodyP50: q(bs, 0.5), bodyP95: q(bs, 0.95), statuses: [...new Set(timing.map((x) => x[2]))] }));
    }
    process.send!({ t: 'done', results, cpuMs: (c.user + c.system) / 1000, maxRssKb: process.resourceUsage().maxRSS, uploaded: agents.reduce((s, a) => s + a.uploadedBytes(), 0) });
  }
  if (m.t === 'stop') { await Promise.all(agents.map((a) => a.stop())); for (const d of dirs) rmSync(d, { recursive: true, force: true }); process.exit(0); }
});
process.send!({ t: 'up' });
