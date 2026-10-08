// SIMULATED / LOCALHOST screen-share benchmark: one synthetic presenter + N headless viewers (@livekit/rtc-node) against
// the real local SFU (MediaService). Engineering numbers only — NOT Wi-Fi capacity. Viewers run in worker processes.
// Usage: node tools/sim/bench-media.ts [--viewers 1,5,10,20,40] [--seconds 20] [--fps 15]
import { execFileSync, fork } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const arg = (k: string, d: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1]! : d; };
const W = 1280, H = 720, BLOCK = 64, BITS = 12; // row 0: send time (ms mod 4096), row 1: frame sequence number

if (process.argv[2] === '--viewer') {
  // worker: connect `n` viewers, report frames + latency
  const { Room, RoomEvent, VideoStream, VideoBufferType, dispose } = await import('@livekit/rtc-node');
  const [url, ...tokens] = JSON.parse(process.argv[3]!) as string[];
  const stats = { joined: 0, failed: 0, frames: 0, lat: [] as number[] };
  const rooms: InstanceType<typeof Room>[] = [];
  await Promise.all(tokens.map(async (t) => {
    const r = new Room(); rooms.push(r);
    const seen = new Set<number>();
    r.on(RoomEvent.TrackSubscribed, async (track) => {
      for await (const ev of new VideoStream(track)) {
        const f = ev.frame.convert(VideoBufferType.RGBA), w = f.width, sx = w / W;
        const read = (row: number) => { let v = 0; for (let b = 0; b < BITS; b++) { const x = Math.floor((b * BLOCK + BLOCK / 2) * sx), y = Math.floor((row * BLOCK + BLOCK / 2) * sx); v |= (f.data[(y * w + x) * 4]! > 127 ? 1 : 0) << b; } return v; };
        const seq = read(1);
        if (seen.has(seq)) continue; // repeated/duplicate decode of a frame already counted
        seen.add(seq); stats.frames++;
        const lat = (Date.now() % 4096) - read(0); stats.lat.push(lat < 0 ? lat + 4096 : lat);
      }
    });
    try { await r.connect(url!, t, { autoSubscribe: true, dynacast: true }); stats.joined++; } catch { stats.failed++; }
  }));
  process.on('message', async () => { process.send!(stats); await Promise.all(rooms.map((r) => r.disconnect().catch(() => {}))); await dispose(); process.exit(0); });
} else {
  const { Room, VideoSource, LocalVideoTrack, TrackPublishOptions, TrackSource, VideoFrame, VideoBufferType, dispose } = await import('@livekit/rtc-node');
  const { MediaService } = await import('../../packages/server/src/media.ts');
  const { candidateInterfaces } = await import('../../packages/server/src/netinfo.ts');
  const host = candidateInterfaces().find((i) => i.private)!.address;
  const binary = join(import.meta.dirname, '../../native/livekit/bin', `${process.platform}-${process.arch}`, 'livekit-server');
  const counts = arg('viewers', '1,5,10,20,40').split(',').map(Number), seconds = Number(arg('seconds', '20')), fps = Number(arg('fps', '15'));
  const rows: string[] = [];
  const ps = (pid: number) => { try { const [cpu, rss] = execFileSync('ps', ['-o', '%cpu=,rss=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/); return { cpu: Number(cpu), rssMB: Math.round(Number(rss) / 1024) }; } catch { return { cpu: 0, rssMB: 0 }; } };
  const net = (pid: number) => { try { const o = execFileSync('nettop', ['-P', '-L', '1', '-x', '-J', 'bytes_in,bytes_out', '-p', String(pid)], { encoding: 'utf8' }).trim().split('\n'); const [, i, out] = (o[1] ?? '').split(','); return { in: Number(i), out: Number(out) }; } catch { return null; } };
  for (const n of counts) {
    const m = new MediaService({ binary, host, workDir: mkdtempSync(join(tmpdir(), 'bench-lk-')) });
    await m.ensure();
    const presenter = new Room();
    await presenter.connect(m.signalUrl, (await m.token({ identity: 'presenter', name: 'P', canPublish: true })).token);
    const src = new VideoSource(W, H);
    const opts = new TrackPublishOptions(); opts.source = TrackSource.SOURCE_SCREENSHARE;
    await presenter.localParticipant!.publishTrack(LocalVideoTrack.createVideoTrack('screen', src), opts);
    const tokens = await Promise.all(Array.from({ length: n }, (_, i) => m.token({ identity: `v${i}`, name: `V${i}`, canPublish: false }).then((t) => t.token)));
    const perWorker = 10, workers = [];
    for (let i = 0; i < tokens.length; i += perWorker) workers.push(fork(import.meta.filename, ['--viewer', JSON.stringify([m.signalUrl, ...tokens.slice(i, i + perWorker)])], { stdio: 'ignore' }));
    let sent = 0;
    const base = new Uint8Array(W * H * 4).fill(30); for (let k = 3; k < base.length; k += 4) base[k] = 255;
    const bits = (d: Uint8Array, row: number, v: number) => { for (let b = 0; b < BITS; b++) { const on = (v >> b) & 1 ? 255 : 0; for (let y = row * BLOCK; y < (row + 1) * BLOCK; y++) d.fill(on, (y * W + b * BLOCK) * 4, (y * W + (b + 1) * BLOCK) * 4); } for (let y = row * BLOCK; y < (row + 1) * BLOCK; y++) for (let x = 0; x < BITS * BLOCK; x++) d[(y * W + x) * 4 + 3] = 255; };
    const frame = (t: number) => { const d = base.slice(); const x0 = 200 + ((sent * 9) % 900); for (let y = 300; y < 600; y++) for (let x = x0; x < x0 + 120; x++) { const k = (y * W + x) * 4; d[k] = 240; d[k + 1] = 176; d[k + 2] = 47; } bits(d, 0, t % 4096); bits(d, 1, sent % 4096); return new VideoFrame(d, W, H, VideoBufferType.RGBA); };
    await new Promise((r) => setTimeout(r, 3000)); // let viewers join
    const net0 = net(m.pid!), cpu: number[] = [], mem: number[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < seconds * 1000) {
      src.captureFrame(frame(Date.now())); sent++;
      if (sent % fps === 0) { const s = ps(m.pid!); cpu.push(s.cpu); mem.push(s.rssMB); }
      await new Promise((r) => setTimeout(r, 1000 / fps));
    }
    const net1 = net(m.pid!);
    const results = await Promise.all(workers.map((w) => new Promise<{ joined: number; failed: number; frames: number; lat: number[] }>((res) => { w.once('message', (x) => res(x as never)); w.send('done'); })));
    const joined = results.reduce((a, r) => a + r.joined, 0), frames = results.reduce((a, r) => a + r.frames, 0);
    const lat = results.flatMap((r) => r.lat).sort((a, b) => a - b), pct = (p: number) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : null;
    const expected = sent * Math.max(joined, 1);
    const mbps = (b: number) => ((b * 8) / seconds / 1e6).toFixed(1);
    const row = `| ${n} | ${joined}/${n} | ${(100 * frames / expected).toFixed(0)}% | ${pct(0.5)} / ${pct(0.95)} | ${Math.round(cpu.reduce((a, b) => a + b, 0) / Math.max(cpu.length, 1))}% | ${Math.max(...mem)} | ${net0 && net1 ? `${mbps(net1.in - net0.in)} / ${mbps(net1.out - net0.out)}` : 'n/a'} |`;
    rows.push(row); console.log(row);
    await presenter.disconnect(); await m.close();
  }
  await dispose();
  const out = ['SIMULATED / LOCALHOST (one Mac; presenter, SFU and viewers on the same machine — NOT Wi-Fi capacity).', `1280×720 synthetic screen at ${fps} fps, VP8 simulcast, ${seconds} s per run.`, '',
    '| viewers | joined | frames delivered | latency p50 / p95 (ms) | SFU CPU | SFU RSS MB | SFU in / out Mb/s |', '|---|---|---|---|---|---|---|', ...rows].join('\n');
  console.log('\n' + out);
}
