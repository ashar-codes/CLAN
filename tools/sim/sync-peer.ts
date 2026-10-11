// A headless "laptop" for cross-device sync tests: the real @clan/core + PersonalSync + LAN sync server (pinned HTTPS,
// signed requests), plus a localhost-only control API so a test can drive it next to a phone or emulator.
// Usage: node tools/sim/sync-peer.ts [--port 47300] [--control 47399]
//   GET  /state                 devices, notes, tasks, conflicts, link request
//   POST /link                  opens a link code → { code, addresses }
//   POST /approve               approves the pending link request
//   POST /note {title, body}    creates a note;  POST /note/:id {body} edits it
//   POST /revoke/:fp            unlinks a device;  POST /resolve/:id/:choice
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openClan } from '../../packages/clan/src/index.ts';
import { candidateInterfaces, createClassroomTls, openDb, startSyncServer } from '@classroom/server';
import { newEd25519, nodeSigner } from '@classroom/client/node';

const { values } = parseArgs({ options: { port: { type: 'string', default: '47300' }, control: { type: 'string', default: '47399' } } });
const dir = mkdtempSync(join(tmpdir(), 'sync-peer-'));
const db = openDb(join(dir, 'db.sqlite'));
const app = openClan(db, { storageDir: dir, localName: 'Sara Ahmed' });
const me = { kind: 'user' as const, userId: app.me };
const tls = await createClassroomTls('sync-peer', Date.now(), 86_400_000);
const signer = nodeSigner(newEd25519().privatePkcs8);
app.sync.setup({ publicKey: signer.publicKey, name: 'Sara-MacBook', platform: 'darwin', tlsCa: tls.certificate, tlsSpki: tls.spkiSha256 }, signer);
const srv = await startSyncServer({ host: app.sync, tls, port: Number(values.port), objectPath: (sha) => app.files.personalObject(app.me, sha) });
const addresses = [...candidateInterfaces().filter((i) => i.private).map((i) => `${i.address}:${srv.port}`), `10.0.2.2:${srv.port} (Android emulator)`];

const json = (res: import('node:http').ServerResponse, v: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(v)); };
createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    try {
      const b = body ? JSON.parse(body) : {}, u = req.url ?? '', m = req.method;
      if (m === 'GET' && u === '/state') return json(res, { devices: app.sync.devices().map((d) => ({ fp: d.fp, name: d.name, platform: d.platform, revoked: d.revoked, current: d.current, lastSeen: d.lastSeen })),
        notes: app.notes.mine(me, 500).map((n) => ({ id: n.id, title: n.title, body: n.body })), tasks: app.tasks.list(me).map((t) => ({ id: t.id, title: t.title, status: t.status })),
        courses: app.courses.list(me).map((c) => ({ id: c.id, name: c.name, topics: app.courses.topics(me, c.id).map((t) => [t.title, t.state]) })),
        files: app.files.list(me, { kind: 'personal', ownerId: app.me }).map((f) => ({ name: f.name, size: f.size, sha256: f.sha256 })),
        conflicts: app.sync.conflicts().map((c) => ({ id: c.id, kind: c.kind, note: c.note, local: c.local, remote: c.remote })), linkRequest: app.sync.linkRequest(), stats: app.sync.stats() });
      if (m === 'POST' && u === '/link') { const l = app.sync.startLink(); return json(res, { code: l.code, addresses }); }
      if (m === 'POST' && u === '/approve') { const r = app.sync.linkRequest(); if (!r) return json(res, { error: 'no request' }, 409); app.sync.approveLink(r.sessionId, addresses.slice(0, 1)); return json(res, { approved: r }); }
      if (m === 'POST' && u === '/note') return json(res, app.notes.create(me, { title: b.title, body: b.body }));
      if (m === 'POST' && u.startsWith('/note/')) { app.notes.update(me, u.slice(6), { body: b.body }); app.sync.refresh(); return json(res, { ok: true }); }
      if (m === 'POST' && u.startsWith('/revoke/')) { app.sync.revoke(decodeURIComponent(u.slice(8))); return json(res, { ok: true, devices: app.sync.devices().map((d) => ({ fp: d.fp, revoked: d.revoked })) }); }
      if (m === 'POST' && u.startsWith('/resolve/')) { const [, , id, choice] = u.split('/'); app.sync.resolve(id!, choice as 'mine'); return json(res, { ok: true }); }
      json(res, { error: 'not found' }, 404);
    } catch (e) { json(res, { error: (e as Error).message }, 500); }
  });
}).listen(Number(values.control), '127.0.0.1', () => console.log(`sync peer: sync on :${srv.port}, control on 127.0.0.1:${values.control}`));

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { void srv.close().then(() => { db.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); }, () => process.exit(1)); });
