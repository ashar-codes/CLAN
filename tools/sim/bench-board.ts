// Whiteboard benchmark (real @clan/core store + real host relay over pinned WSS): append, load (snapshot + tail),
// catch-up payload, memory, and op → other-member latency for boards of 1k / 5k / 10k operations.
// Usage: node tools/sim/bench-board.ts
import { randomUUID } from 'node:crypto';
import { openDb, startClassroomServer } from '@classroom/server';
import { emptyBoard, replay, type WbOp } from '@classroom/protocol';
import { openClan } from '../../packages/clan/src/index.ts';
import { secureJoin, socket, tmp, trustServer } from '../../packages/server/test/helpers.ts';

const stroke = (i: number): WbOp => ({ t: 'put', id: randomUUID(), obj: randomUUID(), clock: i + 1, data: { kind: 'stroke', page: 0, x: (i % 100) * 30, y: Math.floor(i / 100) * 30, w: 0, h: 0, points: Array.from({ length: 24 }, (_, k) => [k * 2, Math.sin(k) * 6] as [number, number]), color: '#17233b', width: 3, z: i } });
const pct = (xs: number[], p: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]!; };
const out: Record<string, unknown>[] = [];
for (const n of [1000, 5000, 10_000]) {
  const db = openDb(':memory:'), app = openClan(db, { storageDir: tmp('bb-') });
  const clanId = randomUUID(); app.clans.create({ id: clanId, type: 'STUDY_GROUP', name: 'Bench', createdBy: app.me });
  const b = app.whiteboard.boardFor(clanId);
  const ops = Array.from({ length: n }, (_, i) => stroke(i));
  let t = performance.now();
  for (let i = 0; i < n; i += 200) app.whiteboard.append(b.id, 'bench', ops.slice(i, i + 200));
  const appendMs = performance.now() - t;
  global.gc?.(); const h0 = process.memoryUsage().heapUsed;
  t = performance.now(); const st = app.whiteboard.state(b.id); const loadMs = performance.now() - t;
  const snap = app.whiteboard.since(b.id, 0);
  const json = JSON.stringify(snap.ops).length;
  t = performance.now(); replay(snap.ops, emptyBoard()); const clientApplyMs = performance.now() - t;
  const heapMB = (process.memoryUsage().heapUsed - h0) / 1e6;
  // live: one more op from member A → member B, over the real host (WSS)
  const s = await startClassroomServer({ title: 'Bench', host: '127.0.0.1', db, storageDir: tmp('bbh-'), chat: app.chat, whiteboard: app.whiteboard, clan: { type: 'STUDY_GROUP', id: clanId } });
  trustServer(s); s.classroom.setPolicy('open');
  const ja = await secureJoin(s, 1), jb = await secureJoin(s, 2);
  const A = socket(s.url, ja.token), B = socket(s.url, jb.token); await A.opened; await B.opened; await A.next('hello'); await B.next('hello');
  const lat: number[] = [];
  for (let k = 0; k < 40; k++) { const op = stroke(n + k); const t0 = performance.now(); A.send({ t: 'wb.ops', ops: [op] }); await B.next('wb.op', (m) => m.ops[0]?.op.id === op.id); lat.push(performance.now() - t0); }
  B.send({ t: 'wb.sync', since: 0 }); t = performance.now(); const first = await B.next('wb.state'); let got = first.ops.length; while (got < st.objects.size) got += (await B.next('wb.op')).ops.length; const joinSyncMs = performance.now() - t;
  await s.close();
  out.push({ ops: n, objects: st.objects.size, appendMs: Math.round(appendMs), hostLoadMs: Math.round(loadMs), snapshotKB: Math.round(json / 1024), clientApplyMs: Math.round(clientApplyMs), stateHeapMB: +heapMB.toFixed(1), joinSyncMs: Math.round(joinSyncMs), opLatencyP50ms: +pct(lat, 50).toFixed(1), opLatencyP95ms: +pct(lat, 95).toFixed(1) });
}
console.table(out);
