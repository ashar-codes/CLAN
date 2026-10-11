// A headless CLAN host for cross-device tests with a phone or emulator: the real classroom server (OPAQUE pairing,
// pinned TLS/WSS) with @clan/core's chat and whiteboard stores — the same wiring the desktop host uses — plus a
// localhost-only control API to act as the host. Members are approved automatically.
// Usage: node tools/sim/class-peer.ts [--host 192.168.1.20] [--control 47499] [--type STUDY_GROUP]
//   GET  /state                       info, members, group chat messages, board object count
//   POST /chat {body}                 host posts to the group conversation
//   POST /wall {mode}                 'WHITEBOARD' | 'NONE'
//   POST /draw                        host draws a sticky on the CLAN board
//   POST /file {path, to}             host shares a file to 'clan' or one member handle
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { openClan } from '../../packages/clan/src/index.ts';
import { candidateInterfaces, openDb, startClassroomServer } from '@classroom/server';
import { pinnedTransport } from '@classroom/client/node';

const { values } = parseArgs({ options: { host: { type: 'string' }, control: { type: 'string', default: '47499' }, type: { type: 'string', default: 'STUDY_GROUP' } } });
const dir = mkdtempSync(join(tmpdir(), 'class-peer-'));
const db = openDb(join(dir, 'host.db'));
const clan = openClan(db, { storageDir: join(dir, 'storage'), localName: 'Host Hira' });
const clanId = clan.clans.create({ type: values.type as 'STUDY_GROUP', name: 'Phone test group', createdBy: clan.me }).id;
const host = values.host ?? candidateInterfaces().find((i) => i.private)?.address ?? '127.0.0.1';
const s = await startClassroomServer({ title: 'Phone test group', host, db, storageDir: join(dir, 'storage'), advertise: true, clan: { type: values.type as 'STUDY_GROUP', id: clanId }, hostName: 'Host Hira', chat: clan.chat, whiteboard: clan.whiteboard,
  media: { binary: join(import.meta.dirname, '../../native/livekit/bin', `${process.platform}-${process.arch}`, 'livekit-server'), workDir: join(dir, 'media') } });
// Match the desktop host's own local-reader mapping so /state observes persisted messages, not an empty projection.
clan.chat.setMe(s.chat!.clanKey, s.chat!.hostHandle);
setInterval(() => { for (const m of s.classroom.roster()) if (m.status === 'pending') s.classroom.setStatus(m.id, 'approved'); }, 300).unref();

// the host's own live connection (as the desktop host app has)
const t = pinnedTransport(s.tls);
const ws = t.openWebSocket(`${s.url.replace(/^https/, 'wss')}/ws`);
ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: s.classroom.teacherToken }));
const send = (m: unknown) => ws.send(JSON.stringify(m));
let wbClock = 1000;

const json = (res: import('node:http').ServerResponse, v: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', async () => {
    try {
      const b = body ? JSON.parse(body) : {}, u = req.url ?? '';
      const p = { kind: 'user' as const, userId: clan.me };
      if (u === '/state') {
        const threads = clan.chat.localThreads(p, clanId) as { id: string; kind: string }[];
        const g = threads.find((x) => x.kind === 'group');
        return json(res, { code: s.classroom.code, bootstrap: s.bootstrapUrl.replace(/^http:\/\//, ''), members: s.classroom.roster().map((m) => ({ id: m.id, name: m.fullName, status: m.status, connected: m.connected })),
          messages: g ? clan.chat.localPage(p, g.id, {}).map((m) => ({ who: m.authorName, body: m.body, attachment: m.attachment })) : [],
          board: (() => { const bd = clan.whiteboard.boardFor(clanId); const st = clan.whiteboard.state(bd.id); return [...st.objects.values()].filter((o) => !o.deleted).map((o) => ({ kind: o.kind, text: o.text ?? null, op: createHash('sha256').update(o.v.op).digest('hex').slice(0, 12) })); })(),
          hands: s.classroom.handView({ role: 'teacher' }).hands, filePolicy: s.classroom.info().fileSharingPolicy, pendingShares: s.shares.pending({ role: 'teacher' }),
          files: s.resources.listForTeacher().map((r) => ({ name: r.name, size: r.size, sha256: r.sha256 })) });
      }
      if (u === '/hand/dismiss') { s.classroom.dismissHand({ role: 'teacher' }, b.memberId); return json(res, { ok: true }); }
      if (u === '/file-policy') { s.classroom.setFilePolicy(b.policy); return json(res, { ok: true }); }
      if (u === '/share/review') { await s.shares.decide({ role: 'teacher' }, b.uploadId, b.accept); return json(res, { ok: true }); }
      if (u === '/chat') { send({ t: 'chat.send', id: randomUUID(), thread: { kind: 'group' }, body: b.body }); return json(res, { ok: true }); }
      if (u === '/wall') { send({ t: 'wb.wall', mode: b.mode ?? 'WHITEBOARD', takeover: true }); send({ t: 'wb.memberEdit', on: true }); return json(res, { ok: true }); }
      if (u === '/draw') { send({ t: 'wb.ops', ops: [{ t: 'put', id: randomUUID(), obj: randomUUID(), clock: ++wbClock, data: { kind: 'sticky', page: 0, x: 40, y: 40, w: 170, h: 120, color: '#17233b', fill: '#fde68a', width: 1, z: 1, text: b.text ?? 'From the host' } }] }); return json(res, { ok: true }); }
      // Test-only loopback controller: same validated operations as an ordinary host drawing.
      if (u === '/strokes') {
        const count = Math.max(0, Math.min(10000, Math.floor(Number(b.count) || 0)));
        for (let i = 0; i < count; i += 20) {
          send({ t: 'wb.ops', ops: Array.from({ length: Math.min(20, count - i) }, (_, k) => ({ t: 'put', id: randomUUID(), obj: randomUUID(), clock: ++wbClock, data: { kind: 'stroke', page: 0, x: ((i + k) % 40) * 12, y: Math.floor((i + k) / 40) % 60 * 10, w: 0, h: 0, points: Array.from({ length: 24 }, (_, j) => [j * .4, Math.sin(j * .5) * 3]), color: '#17233b', width: 1, z: i + k } })) });
          if (i % 20 === 0) await new Promise((r) => setTimeout(r, 50));
        }
        return json(res, { sent: count });
      }
      if (u === '/file') return json(res, await s.shareFile(b.path, b.to ?? 'clan'));
      json(res, { error: 'not found' }, 404);
    } catch (e) { json(res, { error: (e as Error).message }, 500); }
  });
}).listen(Number(values.control), '127.0.0.1', () => console.log(JSON.stringify({ code: s.classroom.code, bootstrap: s.bootstrapUrl, url: s.url, control: `127.0.0.1:${values.control}` })));
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void s.close().then(() => { db.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); }, () => process.exit(1)); }); // stops the SFU child too
