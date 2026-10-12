// Disposable Linux network-namespace fixture. Uses production directory and People runtimes.
// Files coordinate test phases only; messages, files and call signals must cross actual TCP routes.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { createClassroomTls, openDb, startLanDirectory } from '@classroom/server';
import { openClan } from '../../packages/clan/src/index.ts';
import { startPeopleRuntime } from '../../apps/desktop/src/main/people-runtime.ts';
import type { DirectoryConfig, PeerEnvelope } from '@classroom/protocol';

const [role, root] = process.argv.slice(2);
const bridged = process.env.CLAN_TOPOLOGY === 'bridged';
if (!root || !['directory', 'a', 'b'].includes(role ?? '')) throw Error('Use: lan-topology.ts directory|a|b DISPOSABLE_DIR');
await mkdir(root, { recursive: true, mode: 0o700 });
const path = (name: string) => join(root, name);
const exists = (name: string) => readFile(path(name), 'utf8').catch(() => '');
const put = (name: string, text = 'ready') => writeFile(path(name), text, { mode: 0o600 });
async function wait(f: () => boolean | Promise<boolean>, label: string, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await f()) return; await new Promise(r => setTimeout(r, 100)); }
  throw Error(`Timeout: ${label}`);
}
if (role === 'directory') {
  await wait(async () => !!await exists('a.key') && !!await exists('b.key'), 'public enrollment');
  const tls = await createClassroomTls('DISPOSABLE topology directory', Date.now(), 86400000);
  const directory = await startLanDirectory({ tls, host: '10.71.0.1', port: 7443, allowedKeys: new Set([await exists('a.key'), await exists('b.key')]) });
  await put('directory.json', JSON.stringify({ url: 'https://10.71.0.1:7443', certificate: tls.certificate, spkiSha256: tls.spkiSha256 }));
  process.on('SIGTERM', () => void directory.close());
} else {
  const signer = nodeSigner(newEd25519().privatePkcs8), storageDir = path(role!);
  await mkdir(storageDir, { recursive: true });
  const db = openDb(':memory:'), app = openClan(db, { storageDir }), p = app.people;
  const live: PeerEnvelope[] = [];
  let address = role === 'a' ? '10.71.0.2' : bridged ? '10.71.0.3' : '10.72.0.2';
  const rt = await startPeopleRuntime({ people: p, signer, tls: await createClassroomTls(`DISPOSABLE ${role}`, Date.now(), 86400000), dir: storageDir, bind: '0.0.0.0', discover: bridged, endpoints: port => [`${address}:${port}`], tickMs: 150, onLive: e => live.push(e) });
  p.updateProfile({ name: `Topology ${role}` }); p.setVisibility('everyone');
  await put(`${role}.key`, signer.publicKey);
  await wait(async () => !!await exists('directory.json'), 'directory startup');
  if (bridged) await rt.refreshDiscovery();
  else rt.configureDirectory(JSON.parse(await exists('directory.json')) as DirectoryConfig);
  const other = await exists(role === 'a' ? 'b.key' : 'a.key');
  await wait(() => rt.nearby().some(n => n.key === other), 'cross-subnet authenticated discovery');
  // Directory discovery proves visibility, not a persistent authenticated connection.
  if (rt.nearby().find(n => n.key === other)?.connection === 'connected') throw Error('Hint incorrectly marked connected');
  await put(`${role}.discovered`);
  await wait(async () => !!await exists(role === 'a' ? 'b.discovered' : 'a.discovered'), 'both discovery checks before connecting');
  try {
    if (role === 'b') {
      await wait(() => p.contacts('requests').length > 0, 'friend request');
      p.acceptFriend(other); await rt.tick();
      await wait(() => p.isFriend(other), 'friendship');
      await put('b.friend');
      await wait(async () => {
        for (const c of p.conversations()) for (const m of p.page(c.id)) if (m.transfer?.id && p.transfer(m.transfer?.id)?.state === 'offered') p.acceptFile(m.transfer?.id);
        await rt.tick();
        return !!await exists('disconnect.request');
      }, 'initial payloads');
      await wait(async () => !!await exists('disconnected.ready'), 'isolated route');
      rt.links.session(other)?.link.close('fixture network-change event');
      await put('b.offline');
      await wait(async () => !!await exists('reconnected.ready'), 'route restored');
      address = bridged ? '10.71.0.4' : '10.72.0.3'; rt.networkChanged();
      await wait(async () => {
        for (const c of p.conversations()) for (const m of p.page(c.id)) if (m.transfer?.id && p.transfer(m.transfer?.id)?.state === 'offered') p.acceptFile(m.transfer?.id);
        await rt.tick(); return !!await exists('a.done');
      }, 'reconnected delivery');
      const conv = p.conversations()[0]!.id, messages = p.page(conv);
      if (messages.filter(m => m.text === 'queued while isolated').length !== 1) throw Error('Missing/duplicate queued message');
      if (live.length !== 1) throw Error('Call signal missing/duplicated');
      for (const m of messages.filter(m => m.transfer?.id)) {
        const file = p.filePath(m.transfer?.id!); if (!file || await readFile(file, 'utf8') !== 'verified attachment bytes') throw Error('Attachment integrity failed');
      }
      await put('b.done');
    } else {
      p.sendFriendRequest(other); await rt.tick();
      await wait(() => p.isFriend(other), 'friend acceptance');
      await wait(async () => !!await exists('b.friend'), 'peer ready');
      const conv = p.conversations()[0]!.id;
      const first = p.sendText(conv, 'routed hello'); await rt.tick();
      await wait(() => p.message(first.id)?.state === 'delivered', 'recipient receipt');
      if (!await rt.sendLive(p.callSignal(other, { kind: 'call.invite', callId: randomUUID(), sdp: 'v=0' }))) throw Error('Call signaling failed');
      await put('disconnect.request');
      await wait(async () => !!await exists('disconnected.ready') && !!await exists('b.offline'), 'isolated topology');
      rt.links.session(other)?.link.close('fixture network-change event');
      const queued = p.sendText(conv, 'queued while isolated');
      const source = path('attachment.bin'); await writeFile(source, 'verified attachment bytes');
      const file = await p.offerFile(conv, source, { name: 'attachment.bin', mime: 'application/octet-stream' });
      const voice = await p.offerFile(conv, source, { name: 'voice.m4a', mime: 'audio/mp4', voiceMs: 1000 });
      await rt.tick();
      await new Promise(r => setTimeout(r, 1200));
      if (p.message(queued.id)?.state === 'delivered' || rt.links.connected(other)) throw Error('Isolation failed safely');
      await put('queued.done');
      await wait(async () => !!await exists('reconnected.ready'), 'route/IP change');
      rt.networkChanged();
      await wait(() => p.message(queued.id)?.state === 'delivered' && p.transfer(file.id)?.state === 'complete' && p.transfer(voice.id)?.state === 'complete', 'automatic queued text/file/voice delivery');
      await put('a.done'); await wait(async () => !!await exists('b.done'), 'receiver integrity and no duplicates');
      console.log(`PASS: ${bridged ? 'A same subnet, B virtual Ethernet bridge and multicast discovery without directory' : 'C routed TCP, D pinned authenticated directory'}; E isolated queue, F IP change/reconnect; text receipts, consent/SHA files, voice bytes, live call signaling, no duplicates. Virtual Linux networks; no physical router/AP or microphone test.`);
    }
  } finally { await rt.stop(); db.close(); }
}
