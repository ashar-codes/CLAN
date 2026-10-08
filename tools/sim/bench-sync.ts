// Personal-sync benchmark: two real device databases, the real LAN transport (HTTPS, pinned, signed). A laptop with
// 1,000 notes, 5,000 saved items, 10,000 flashcard reviews and 1 GB of files is linked to a fresh device; we time the
// first full sync, a no-change round, and a one-edit round. Usage: node tools/sim/bench-sync.ts [--gb 1]
import { randomBytes } from 'node:crypto';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openClan } from '../../packages/clan/src/index.ts';
import { createClassroomTls, openDb, startSyncServer } from '@classroom/server';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { joinWithCode, lanSyncTransport } from '@classroom/client/sync';
import { normalizeLinkCode } from '@classroom/protocol';

const { values } = parseArgs({ options: { gb: { type: 'string', default: '1' } } });
const MB = 1024 * 1024, GB = 1024 * MB;
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'bench-sync-')); dirs.push(d); return d; };
const ms = (t: number) => `${(performance.now() - t).toFixed(0)} ms`;

async function device(name: string) {
  const app = openClan(openDb(join(tmp(), 'db.sqlite')), { storageDir: tmp() });
  const tls = await createClassroomTls(`sync-${name}`, Date.now(), 86_400_000);
  const signer = nodeSigner(newEd25519().privatePkcs8);
  app.sync.setup({ publicKey: signer.publicKey, name, platform: 'bench', tlsCa: tls.certificate, tlsSpki: tls.spkiSha256 }, signer);
  const srv = await startSyncServer({ host: app.sync, tls, bind: '127.0.0.1', objectPath: (sha) => app.files.personalObject(app.me, sha) });
  return { app, signer, srv, base: `https://127.0.0.1:${srv.port}`, me: { kind: 'user' as const, userId: app.me } };
}
const a = await device('Laptop'), b = await device('New device');

let t = performance.now();
for (let i = 0; i < 1000; i++) a.app.notes.create(a.me, { title: `Note ${i}`, body: 'lorem ipsum '.repeat(150) });
for (let i = 0; i < 5000; i++) a.app.saved.add(a.me, { url: `https://example.com/${i}`, title: `Link ${i}` });
const deck = a.app.flashcards.createDeck(a.me, { name: 'Deck' });
const cards = Array.from({ length: 5000 }, (_, i) => a.app.flashcards.addCard(a.me, deck.id, { front: `Q${i}`, back: `A${i}` }));
for (let i = 0; i < 10_000; i++) a.app.flashcards.review(a.me, cards[i % 5000]!.id, i < 5000 ? 'good' : 'hard');
const gb = Number(values.gb), fileDir = tmp();
for (let i = 0; i < 4; i++) { const p = join(fileDir, `rec${i}.bin`); writeFileSync(p, ''); for (let o = 0; o < (gb * GB) / 4; o += 16 * MB) appendFileSync(p, randomBytes(16 * MB)); await a.app.files.add(a.me, p, `rec${i}.webm`, { kind: 'personal', ownerId: a.app.me }); }
console.log(`seed: ${ms(t)}`);
a.app.sync.setSettings({ files: 'all' }); b.app.sync.setSettings({ files: 'all' });

t = performance.now(); console.log(`first change scan (16.5k entities): ${a.app.sync.refresh()} records, ${ms(t)}`);
const s = a.app.sync.startLink(), self = b.app.sync.self();
const joining = joinWithCode({ base: a.base, code: normalizeLinkCode(s.code)!, pollMs: 20, sign: (x) => b.signer.sign(x), device: { ...self, endpoints: [] } });
while (!a.app.sync.linkRequest()) await new Promise((r) => setTimeout(r, 10));
a.app.sync.approveLink(a.app.sync.linkRequest()!.sessionId, []);
b.app.sync.adopt((await joining).grant);
const d = b.app.sync.devices().find((x) => !x.current)!;
const tr = () => lanSyncTransport({ peer: d.fp, base: a.base, tlsCa: d.tlsCa, tlsSpki: d.tlsSpki, auth: (m, p, body) => b.app.sync.authHeaders(m, p, body), timeoutMs: 600_000 });

t = performance.now(); const r1 = await b.app.sync.syncWith(tr()); const full = performance.now() - t;
console.log(`first full sync: ${r1.pulled} records + ${r1.objects} files (${gb} GB) in ${(full / 1000).toFixed(1)} s`);
console.log(`  check: notes ${b.app.notes.mine(b.me, 2000).length}, saved ${(b.app.db.prepare('SELECT count(*) n FROM saved_items').get() as { n: number }).n}, reviews ${b.app.flashcards.history(b.me, cards[0]!.id).length * 5000}`);
t = performance.now(); const r2 = await b.app.sync.syncWith(tr()); console.log(`no-change round: pulled ${r2.pulled}, pushed ${r2.pushed}, ${ms(t)}`);
a.app.notes.update(a.me, a.app.notes.mine(a.me, 1)[0]!.id, { body: 'edited' });
t = performance.now(); const r3 = await b.app.sync.syncWith(tr()); console.log(`one-edit round: pulled ${r3.pulled}, ${ms(t)}`);
await a.srv.close(); await b.srv.close();
for (const x of dirs) rmSync(x, { recursive: true, force: true });
