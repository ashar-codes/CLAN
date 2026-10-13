// Disposable real authenticated peer for native background QA; control API binds loopback only.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { openDb, createClassroomTls } from '@classroom/server';
import { openClan } from '../../packages/clan/src/index.ts';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { profileQr } from '@classroom/protocol';
import { startPeopleRuntime } from '../../apps/desktop/src/main/people-runtime.ts';
const dir = mkdtempSync(join(tmpdir(), 'clan-background-peer-'));
const name = (process.env.CLAN_QA_NAME ?? 'BTC-2R QA Mac').slice(0, 40), host = process.env.CLAN_QA_HOST ?? '10.0.2.2';
const controlPort = Number(process.env.CLAN_QA_CONTROL_PORT ?? 47598);
if (!/^[0-9.]{7,15}$/.test(host) || !Number.isInteger(controlPort) || controlPort < 1024 || controlPort > 65535) throw Error('Invalid QA endpoint');
const db = openDb(join(dir, 'qa.db')), app = openClan(db, { storageDir: dir, localName: name });
const p = app.people, signer = nodeSigner(newEd25519().privatePkcs8);
p.setSigner(signer); p.updateProfile({ name });
const tls = await createClassroomTls('btc2r-qa', Date.now(), 86400000);
const rt = await startPeopleRuntime({ people: p, signer, tls, dir, discover: false, endpoints: port => [`${host}:${port}`], tickMs: 200 });
const qr = profileQr({ key: signer.publicKey, endpoints: [], links: [`tcp:${host}:${rt.linkPort}`], name, invite: p.inviteToken(), intent: 'friend' });
const server = createServer((req, res) => {
  let body = ''; req.on('data', c => { body += c; if (body.length > 8192) req.destroy(); });
  req.on('end', async () => { try {
    const data = body ? JSON.parse(body) : {}, friend = p.contacts('friends')[0];
    let result: unknown;
    if (req.method === 'GET' && req.url === '/state') result = { name, qr, requests: p.contacts('requests').length, friends: p.contacts('friends').length, conversations: p.conversations(), messages: p.conversations().flatMap(c => p.page(c.id)), connected: friend ? rt.links.connected(friend.key) : false };
    else if (req.method === 'POST' && req.url === '/approve') { const request = p.contacts('requests').find(c => c.relation === 'incoming'); if (!request) throw Error('No incoming request'); p.acceptFriend(request.key); await rt.tick(); result = { ok: true }; }
    else if (req.method === 'POST' && req.url === '/invite') { if (!friend) throw Error('No authorized friend'); result = { id: p.inviteChat(friend.key) }; await rt.tick(); }
    else if (req.method === 'POST' && req.url === '/message') { const conv = p.conversations().find(c => c.state === 'active'); if (!conv || typeof data.text !== 'string') throw Error('No authorized chat'); result = p.sendText(conv.id, data.text); void rt.tick(); } // enqueue immediately, including offline; receipt is a separate assertion
    else if (req.method === 'POST' && req.url === '/call') { if (!friend) throw Error('No authorized friend'); const callId = randomUUID(), envelope = p.callSignal(friend.key, { kind: 'call.invite', callId, sdp: 'v=0' }); result = { callId, envelopeId: envelope.id, sent: await rt.sendLive(envelope) }; }
    else if (req.method === 'POST' && req.url === '/disconnect') { if (friend) rt.links.session(friend.key)?.link.close('QA route interruption'); result = { ok: true }; }
    else { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
  } catch(e) { res.writeHead(409); res.end(JSON.stringify({ error: (e as Error).message })); } });
});
server.listen(controlPort, '127.0.0.1', () => console.log('BTC-2R peer ready'));
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { server.close(); void rt.stop().then(() => { db.close(); rmSync(dir, { recursive: true, force: true }); process.exit(0); }); });
