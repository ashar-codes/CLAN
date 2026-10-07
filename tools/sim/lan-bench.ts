// Real-network benchmark. Run on the TEACHER machine:
//   node tools/sim/lan-bench.ts [--host 192.168.1.20] [--sizes 1,10,100] [--runs 3]
// Then on each student device (phone, laptop — any browser, no dev tools) open the printed http://… address on the
// same Wi-Fi and press Run. Each device joins the classroom with the code (open policy), downloads the test files
// through the real classroom endpoint with its real auth, and posts its measurements back here.
// Results are appended to docs/lan-bench/<date>.jsonl and summarized in the terminal. Nothing is fabricated:
// if no device runs it, nothing is recorded.
import { createServer } from 'node:http';
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { hostname, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { candidateInterfaces, startClassroomServer } from '@classroom/server';

const { values } = parseArgs({ options: { host: { type: 'string' }, sizes: { type: 'string', default: '1,10,100' }, runs: { type: 'string', default: '3' } } });
const host = values.host ?? candidateInterfaces()[0]?.address;
if (!host) throw new Error('No LAN interface found. Connect to the classroom network first.');
const MB = 1024 * 1024;

const dir = mkdtempSync(join(tmpdir(), 'lan-bench-'));
const s = await startClassroomServer({ title: 'LAN benchmark', host, storageDir: join(dir, 'storage'), advertise: true, limits: { downloadRequestsPerMinute: 10_000 } });
s.classroom.setPolicy('open');
const resources = [];
for (const mbs of values.sizes!.split(',').map(Number)) {
  const p = join(dir, `test-${mbs}MB.bin`);
  writeFileSync(p, '');
  for (let i = 0; i < mbs; i++) appendFileSync(p, randomBytes(MB));
  resources.push(await s.resources.importFile(p));
}

const outDir = new URL('../../docs/lan-bench/', import.meta.url);
if (!process.env.LAN_BENCH_OUT) mkdirSync(outDir, { recursive: true });
// LAN_BENCH_OUT redirects output (used for the same-machine smoke test so it is never recorded as a real result).
const outFile = process.env.LAN_BENCH_OUT ? new URL(`file://${process.env.LAN_BENCH_OUT}`) : new URL(`${new Date().toISOString().slice(0, 10)}.jsonl`, outDir);
const teacherInfo = { teacherHost: hostname(), teacherOs: platform(), serverAddress: host };

const page = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Classroom LAN benchmark</title>
<style>body{font:16px system-ui;margin:0;padding:16px;max-width:640px}button{font:inherit;padding:12px 20px}input{font:inherit;padding:8px;width:100%;box-sizing:border-box}pre{white-space:pre-wrap}</style>
<h2>Classroom LAN — network benchmark</h2>
<p>Stay on the classroom Wi-Fi. This downloads ${resources.map((r) => Math.round(r.size / MB) + ' MB').join(', ')} × ${values.runs} from the teacher computer.</p>
<label>Device label (e.g. "Ashar iPhone 13, 5 GHz, back row")<input id="label"></label><p><button id="go">Run</button></p><pre id="log"></pre>
<script>
const CLASS = ${JSON.stringify({ url: s.url, code: s.classroom.code, resources: resources.map((r) => ({ id: r.id, size: r.size })), runs: Number(values.runs) })};
const log = (t) => { document.getElementById('log').textContent += t + '\\n'; };
// crypto.randomUUID needs a secure context; this page is plain http on the LAN.
const uuid = () => { const b = crypto.getRandomValues(new Uint8Array(16)); b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128; const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join(''); return h.slice(0,8)+'-'+h.slice(8,12)+'-'+h.slice(12,16)+'-'+h.slice(16,20)+'-'+h.slice(20); };
document.getElementById('go').onclick = async () => {
  const label = (document.getElementById('label').value || 'unnamed device').slice(0, 60);
  document.getElementById('go').disabled = true;
  try {
    let t = performance.now();
    const j = await (await fetch(CLASS.url + '/api/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: CLASS.code, protocol: 1, profile: { fullName: label, rollNo: 'BENCH', deviceName: label, deviceId: uuid() } }) })).json();
    if (!j.token) throw new Error(j.message || 'join failed');
    const joinMs = performance.now() - t;
    const rtts = [];
    for (let i = 0; i < 20; i++) { t = performance.now(); await (await fetch(CLASS.url + '/api/info')).text(); rtts.push(performance.now() - t); }
    rtts.sort((a, b) => a - b);
    log('join ' + joinMs.toFixed(0) + ' ms, HTTP round trip median ' + rtts[10].toFixed(1) + ' ms');
    const downloads = [];
    for (const r of CLASS.resources) for (let k = 0; k < CLASS.runs; k++) {
      t = performance.now();
      const res = await fetch(CLASS.url + '/api/resources/' + r.id + '/content', { headers: { authorization: 'Bearer ' + j.token } });
      const reader = res.body.getReader(); let n = 0;
      for (;;) { const { done, value } = await reader.read(); if (done) break; n += value.length; }
      const ms = performance.now() - t;
      downloads.push({ bytes: r.size, receivedBytes: n, ms, ok: n === r.size && res.ok });
      log((r.size / 1048576) + ' MB in ' + ms.toFixed(0) + ' ms = ' + (n * 8 / ms / 1000).toFixed(1) + ' Mbit/s' + (n === r.size ? '' : ' INCOMPLETE'));
    }
    await fetch(location.origin + '/results', { method: 'POST', body: JSON.stringify({ label, userAgent: navigator.userAgent, joinMs, rttMedianMs: rtts[10], downloads }) });
    log('Results sent to the teacher computer. Thank you!');
  } catch (e) { log('Error: ' + e.message); document.getElementById('go').disabled = false; }
};
</script>`;

const results: unknown[] = [];
const web = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(page);
  if (req.method === 'POST' && req.url === '/results') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100_000) req.destroy(); });
    req.on('end', () => {
      try {
        const r = { at: new Date().toISOString(), ...teacherInfo, client: req.socket.remoteAddress, ...JSON.parse(body) };
        appendFileSync(outFile, JSON.stringify(r) + '\n');
        results.push(r);
        summarize(r);
        res.writeHead(204).end();
      } catch { res.writeHead(400).end(); }
    });
    return;
  }
  res.writeHead(404).end();
});
web.listen(0, host, () => {
  const port = (web.address() as { port: number }).port;
  console.log(`\nClassroom server ${s.url}  (code ${s.classroom.code})`);
  console.log(`On each student device on this Wi-Fi, open:  http://${host}:${port}/`);
  console.log(`Results -> ${outFile.pathname}\nCtrl+C to stop.\n`);
});

function summarize(r: { label: string; client: string; joinMs: number; rttMedianMs: number; downloads: { bytes: number; ms: number; ok: boolean }[] }) {
  console.log(`${r.label} (${r.client}): join ${r.joinMs.toFixed(0)} ms, RTT ${r.rttMedianMs.toFixed(1)} ms`);
  const bySize = new Map<number, number[]>();
  for (const d of r.downloads) if (d.ok) bySize.set(d.bytes, [...(bySize.get(d.bytes) ?? []), d.ms]);
  for (const [b, ms] of bySize) {
    const med = ms.sort((x, y) => x - y)[Math.floor(ms.length / 2)]!;
    console.log(`  ${b / MB} MB: median ${med.toFixed(0)} ms (${((b * 8) / med / 1000).toFixed(1)} Mbit/s), ${ms.length} ok`);
  }
}

process.on('SIGINT', async () => { await s.close(); web.close(); console.log(`\n${results.length} device result(s) recorded.`); process.exit(0); });
