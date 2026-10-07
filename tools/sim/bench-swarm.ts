// Peer-assisted vs teacher-only distribution benchmark (Milestone 2.75). Real teacher server process + W worker processes
// of real PeerAgents (each student: OPAQUE join, own HTTPS peer server, teacher-endorsed identity, signed manifests).
// Usage: node tools/sim/bench-swarm.ts [--host IP] [--scenarios 60x1,60x10,60x100,100x1,100x10] [--chunk-kb 1024]
//        [--workers 4] [--chunk-sweep] [--threshold-sweep] [--no-write]
import { execSync, fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  host: { type: 'string', default: '127.0.0.1' }, scenarios: { type: 'string', default: '60x1,60x10,60x100,100x1,100x10' },
  'chunk-kb': { type: 'string', default: '1024' }, workers: { type: 'string', default: '4' },
  'chunk-sweep': { type: 'boolean' }, 'peer-only': { type: 'boolean' }, 'threshold-sweep': { type: 'boolean' }, 'no-write': { type: 'boolean' },
} });
const MB = 1024 * 1024, W = Number(values.workers);
type R = { ok: boolean; ms: number; teacherBytes: number; peerBytes: number; retries: number; corrupt: number; failed: number; sources: number; mode: string; error?: string };
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? 0; };
const once = <T>(c: ChildProcess, t: string) => new Promise<T>((res) => { const h = (m: { t: string }) => { if (m.t === t) { c.off('message', h); res(m as T); } }; c.on('message', h); });

async function run(n: number, sizeMb: number, peerAssist: boolean, chunkKb: number, smallFileBytes?: number) {
  const gen = mkdtempSync(join(tmpdir(), 'bench-gen-'));
  const file = join(gen, 'r.bin');
  writeFileSync(file, '');
  for (let i = 0; i < sizeMb; i++) appendFileSync(file, randomBytes(MB));
  const teacher = fork(new URL('./swarm-teacher.ts', import.meta.url), [values.host!, String(chunkKb * 1024)], { stdio: 'inherit' });
  const cfg = await once<{ url: string }>(teacher, 'ready');
  teacher.send({ t: 'import', path: file });
  const { resource } = await once<{ resource: { size: number } }>(teacher, 'imported');
  teacher.send({ t: 'peerAssist', on: peerAssist }); await once(teacher, 'ok');
  const per = Math.ceil(n / W);
  // Each worker simulates ~10 students in ONE process; give it the file-I/O threads those students' separate apps would
  // have (libuv default is 4 per process; with 4, the shared pool, not the network, dominated: 60x100 MB took ~190 s vs ~20 s).
  const workers = Array.from({ length: Math.ceil(n / per) }, (_, w) => fork(new URL('./swarm-worker.ts', import.meta.url), [String(Math.min(per, n - w * per)), String(w * per), values.host!], { stdio: 'inherit', env: { ...process.env, UV_THREADPOOL_SIZE: String(Math.max(4, per * 3)) } }));
  await Promise.all(workers.map((w) => once(w, 'up')));
  await Promise.all(workers.map((w) => { const p = once(w, 'joined'); w.send({ t: 'join', cfg }); return p; }));
  teacher.send({ t: 'stats' }); const s0 = await once<{ cpu: NodeJS.CpuUsage; servedBytes: number }>(teacher, 'stats');
  const t0 = performance.now();
  const done = await Promise.all(workers.map((w) => { const p = once<{ results: R[]; cpuMs: number; maxRssKb: number; uploaded: number }>(w, 'done'); w.send({ t: 'go', resource, peerAssist, smallFileBytes }); return p; }));
  const wall = performance.now() - t0;
  teacher.send({ t: 'stats' }); const s1 = await once<{ cpu: NodeJS.CpuUsage; servedBytes: number; maxRssKb: number }>(teacher, 'stats');
  for (const w of workers) w.send({ t: 'stop' });
  teacher.send({ t: 'stop' });
  await Promise.all([...workers, teacher].map((c) => new Promise((r) => c.once('exit', r))));
  rmSync(gen, { recursive: true, force: true });
  const rs = done.flatMap((d) => d.results);
  const teacherSent = s1.servedBytes - s0.servedBytes;
  const total = rs.reduce((a, r) => a + r.teacherBytes + r.peerBytes, 0);
  return {
    n, sizeMb, peerAssist, chunkKb, wall, ok: rs.filter((r) => r.ok).length, hashFail: rs.filter((r) => !r.ok && r.mode !== 'error').length, errors: rs.filter((r) => r.mode === 'error').map((r) => r.error),
    p50: pct(rs.map((r) => r.ms), 50), p95: pct(rs.map((r) => r.ms), 95), teacherSent, delivered: n * resource.size, totalLan: total,
    teacherCpuPct: ((s1.cpu.user + s1.cpu.system - s0.cpu.user - s0.cpu.system) / 1000 / wall) * 100, teacherRssMb: s1.maxRssKb / 1024,
    peerCpuPct: (done.reduce((a, d) => a + d.cpuMs, 0) / wall) * 100, peerRssMb: Math.max(...done.map((d) => d.maxRssKb)) / 1024,
    retries: rs.reduce((a, r) => a + r.retries, 0), failed: rs.reduce((a, r) => a + r.failed, 0), corrupt: rs.reduce((a, r) => a + r.corrupt, 0),
    sourcesP50: pct(rs.map((r) => r.sources), 50), sourcesMax: Math.max(...rs.map((r) => r.sources)),
  };
}

const fmtS = (ms: number) => (ms < 1000 ? `${ms.toFixed(0)} ms` : `${(ms / 1000).toFixed(2)} s`);
const fmtMB = (b: number) => `${(b / MB).toFixed(b < 10 * MB ? 1 : 0)} MB`;
const row = (r: Awaited<ReturnType<typeof run>>) => `| ${r.n} × ${r.sizeMb} MB | ${r.peerAssist ? 'peer-assisted' : 'teacher only'} | ${fmtS(r.wall)} | ${fmtS(r.p50)} | ${fmtS(r.p95)} | ${r.ok}/${r.n} | ${r.hashFail} | **${fmtMB(r.teacherSent)}** (${((r.teacherSent / r.delivered) * 100).toFixed(0)}% of ${fmtMB(r.delivered)}) | ${fmtMB(r.totalLan)} | ${r.teacherCpuPct.toFixed(0)}% / ${r.teacherRssMb.toFixed(0)} MB | ${r.peerCpuPct.toFixed(0)}% / ${r.peerRssMb.toFixed(0)} MB | ${r.retries} / ${r.failed} / ${r.corrupt} | ${r.sourcesP50} (max ${r.sourcesMax}) |`;
const header = ['| Clients × size | Mode | Wall | p50 | p95 | Success | Hash fail | Teacher sent | Total LAN | Teacher CPU / peak RSS | Peers CPU (sum) / max worker RSS | Retries / failed / corrupt chunks | Sources per student p50 |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'];

const lines: string[] = [];
const log = (...ss: string[]) => { for (const s of ss) { console.log(s); lines.push(s); } };
if (values['chunk-sweep']) {
  log('**Chunk-size sweep** (60 × 10 MB, peer-assisted):', ''); log('| Chunk | Wall | p95 | Teacher sent | Retries |'); log('|---:|---:|---:|---:|---:|');
  for (const kb of [256, 512, 1024, 2048, 4096]) { const r = await run(60, 10, true, kb); log(`| ${kb} KiB | ${fmtS(r.wall)} | ${fmtS(r.p95)} | ${fmtMB(r.teacherSent)} | ${r.retries} |`); }
} else if (values['threshold-sweep']) {
  log('**Small-file threshold** (60 clients; teacher-stream vs forced swarm):', ''); log('| Size | Mode | Wall | p95 | Teacher sent |'); log('|---:|---|---:|---:|---:|');
  for (const mb of [1, 2, 4, 8]) for (const swarm of [false, true]) { const r = await run(60, mb, swarm, Number(values['chunk-kb']), swarm ? 0 : undefined); log(`| ${mb} MB | ${swarm ? 'swarm' : 'teacher stream'} | ${fmtS(r.wall)} | ${fmtS(r.p95)} | ${fmtMB(r.teacherSent)} |`); }
} else {
  log(`Generated by \`node tools/sim/bench-swarm.ts\` on ${new Date().toISOString()}. ${platform()} ${release()}, ${cpus()[0]?.model} ×${cpus().length}, ${(totalmem() / 1e9).toFixed(0)} GB, Node ${process.version}. Chunk ${values['chunk-kb']} KiB, ${W} worker processes, host ${values.host}.`, '');
  log(header[0]!); log(header[1]!);
  for (const sc of values.scenarios!.split(',')) {
    const [n, mb] = sc.split('x').map(Number) as [number, number];
    for (const pa of values['peer-only'] ? [true] : [false, true]) {
      // Large runs write GBs: flush and let the disk settle so one phase doesn't slow the next (observed: 23 s -> 160 s).
      execSync('sync'); await new Promise((r) => setTimeout(r, mb >= 100 ? 15_000 : 2_000));
      const r = await run(n, mb, pa, Number(values['chunk-kb'])); log(row(r)); if (r.errors.length) console.log('errors:', r.errors.slice(0, 3)); }
  }
}
if (!values['no-write'] && !values['chunk-sweep'] && !values['threshold-sweep']) {
  const path = new URL('../../docs/BENCHMARKS.md', import.meta.url);
  const doc = readFileSync(path, 'utf8');
  writeFileSync(path, doc.replace(/<!-- bench:swarm:start -->[\s\S]*<!-- bench:swarm:end -->/, `<!-- bench:swarm:start -->\n${lines.join('\n')}\n<!-- bench:swarm:end -->`));
}
process.exit(0);
