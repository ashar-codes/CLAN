// Personal device sync: linking, change records, conflicts, offline/failure cases — two (or three) real device
// databases connected by an in-memory transport that goes through the same request authentication as the LAN server.
import { describe, expect, it } from 'vitest';
import { createReadStream, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, randomBytes, sign as edSign } from 'node:crypto';
import { linkTranscript, normalizeLinkCode, type SyncRecord, type SyncTransport } from '@classroom/protocol';
import { linkProof } from '../src/index.ts';
import { setup, tmp, user } from './helpers.ts';
import { clock, device, link, now, type Dev } from './sync-helpers.ts';

/** `from` talks to `to`: every call is signed by `from` and verified by `to` (as the LAN server does). */
function wire(from: Dev, to: Dev, o: { failObjectAfter?: number; corrupt?: boolean } = {}): SyncTransport {
  const auth = (method: string, path: string, body: string) => { const h = from.app.sync.authHeaders(method, path, body); return to.app.sync.verifyRequest({ auth: h['x-clan-sync'], sig: h['x-clan-sync-sig'] }, method, path, to.app.sync.bodySha(body)); };
  return {
    peer: to.fp,
    pull: async (since, limit) => { auth('GET', `/sync/changes?since=${since}&limit=${limit}`, ''); return JSON.parse(JSON.stringify(to.app.sync.changes(since, limit))); },
    push: async (records: SyncRecord[]) => { const body = JSON.stringify({ records }); return to.app.sync.applyBatch(auth('POST', '/sync/changes', body), JSON.parse(body).records); },
    object: async (sha, offset) => {
      auth('GET', `/sync/objects/${sha}`, '');
      const loc = to.app.files.personalObject(to.app.me, sha); if (!loc) throw new Error('not found');
      return (async function* () {
        let sent = 0;
        for await (const c of createReadStream(loc, { start: offset, highWaterMark: 1024 })) {
          if (o.failObjectAfter !== undefined && sent >= o.failObjectAfter) throw new Error('connection lost');
          sent += (c as Buffer).length; yield o.corrupt ? Buffer.alloc((c as Buffer).length, 7) : (c as Buffer);
        }
      })();
    },
  };
}
const sync = (a: Dev, b: Dev) => { clock.t += 1000; return a.app.sync.syncWith(wire(a, b)); };
const pair = () => { const a = device('MacBook'), b = device('iPhone'); link(a, b); return { a, b }; };

describe('linking', () => {
  it('retains the authenticated contact address when advertised interfaces differ, still using the linked identity', async () => {
    const a = device('MacBook'), b = device('iPhone');
    try {
      link(a, b, { verifiedEndpoint: '10.0.2.2:47300' });
      expect(b.app.sync.devices().find((d) => d.fp === a.fp)?.endpoints[0]).toBe('10.0.2.2:47300');
      a.app.notes.create(a.me, { title: 'After interface change', body: 'Still authenticated' });
      await sync(b, a);
      expect(b.app.notes.mine(b.me).some((n) => n.title === 'After interface change')).toBe(true);
    } finally { a.db.close(); b.db.close(); }
  });
  it('needs the right short-lived code bound to the TLS key the joiner saw, then explicit approval', () => {
    const a = device('MacBook'), b = device('iPhone');
    expect(() => link(a, b, { code: 'CLAN-2222-2222-2222' })).toThrow(/not right/);
    expect(() => link(a, b, { seenSpki: 'attacker-spki' })).toThrow(/not right/); // a relay with its own TLS key can't reuse the proof
    link(a, b);
    expect(a.app.sync.devices().map((d) => d.name).sort()).toEqual(['MacBook', 'iPhone']);
    expect(b.app.sync.devices().find((d) => d.current)?.name).toBe('iPhone');
    expect(b.app.sync.account()!.accountId).toBe(a.app.sync.account()!.accountId);
    expect(b.app.me).not.toBe(a.app.me); // each device keeps its own local identity; no CLAN membership comes with linking
  });
  it('a code expires after 2 minutes, is single use and closes after 3 wrong tries', () => {
    const a = device('MacBook'), b = device('iPhone');
    a.app.sync.startLink(); clock.t += 121_000;
    expect(() => a.app.sync.linkStart()).toThrow(/No device link/);
    const s = a.app.sync.startLink();
    for (let i = 0; i < 3; i++) expect(() => a.app.sync.linkHello({ sessionId: a.app.sync.linkStart().sessionId, nonceB: 'n', proof: 'x', sig: 'y', device: { fp: b.fp, publicKey: b.key.pub, name: 'x', platform: 'p', tlsCa: 'c', tlsSpki: 's', endpoints: [] } }, 'spki-MacBook')).toThrow(/not right/);
    expect(() => a.app.sync.linkStart()).toThrow(/No device link/);
    expect(s.code).toMatch(/^CLAN-[2-9A-Z]{4}-[2-9A-Z]{4}-[2-9A-Z]{4}$/);
  });
  it('a joiner must hold the device key it claims', () => {
    const a = device('MacBook'), b = device('iPhone'), c = device('Other');
    const { code } = a.app.sync.startLink(); const { sessionId, nonceA } = a.app.sync.linkStart();
    const tr = linkTranscript('joiner', { sessionId, serverSpki: 'spki-MacBook', joinerKey: b.key.pub, nonceA, nonceB: 'nb' });
    expect(() => a.app.sync.linkHello({ sessionId, nonceB: 'nb', proof: linkProof(normalizeLinkCode(code)!, tr), sig: edSign(null, new TextEncoder().encode(tr), c.key.privateKey).toString('base64url'),
      device: { fp: b.fp, publicKey: b.key.pub, name: 'iPhone', platform: 'p', tlsCa: 'c', tlsSpki: 's', endpoints: [] } }, 'spki-MacBook')).toThrow(/not right/);
  });
});

describe('request authentication', () => {
  it('rejects unknown devices, replays, stale clocks and tampered bodies', () => {
    const { a, b } = pair(), stranger = device('Stranger');
    const h = b.app.sync.authHeaders('POST', '/sync/changes', '{"records":[]}');
    const v = (hh: typeof h, body = '{"records":[]}') => a.app.sync.verifyRequest({ auth: hh['x-clan-sync'], sig: hh['x-clan-sync-sig'] }, 'POST', '/sync/changes', a.app.sync.bodySha(body));
    expect(v(h)).toBe(b.fp);
    expect(() => v(h)).toThrow(/replayed/);
    expect(() => v(b.app.sync.authHeaders('POST', '/sync/changes', '{"records":[]}'), '{"records":[1]}')).toThrow(/Body/);
    const old = b.app.sync.authHeaders('POST', '/sync/changes', '{"records":[]}'); clock.t += 200_000;
    expect(() => v(old)).toThrow(/too old/);
    expect(() => v(stranger.app.sync.authHeaders('POST', '/sync/changes', '{"records":[]}'))).toThrow(/not linked/);
    return expect(a.app.sync.applyBatch(stranger.fp, [])).rejects.toThrow(/not linked/);
  });
});

describe('sync', () => {
  it('brings the personal data across, applied by each module, and a second round changes nothing', async () => {
    const { a, b } = pair();
    const n = a.app.notes.create(a.me, { title: 'Krebs cycle', body: 'citrate → isocitrate' });
    const c = a.app.courses.create(a.me, { name: 'Biochem' });
    const tp = a.app.courses.addTopic(a.me, c.id, 'Metabolism');
    a.app.courses.addLecture(a.me, c.id, { title: 'L1', topicIds: [tp.id] });
    a.app.courses.link(a.me, c.id, { module: 'notes', entityId: n.id, topicId: tp.id });
    const task = a.app.tasks.create(a.me, { title: 'Problem set', courseId: c.id }); a.app.tasks.addItem(a.me, task.id, 'Q1');
    const item = a.app.saved.add(a.me, { url: 'https://example.com/v', title: 'Video' });
    const deck = a.app.flashcards.createDeck(a.me, { name: 'Enzymes' }); const card = a.app.flashcards.addCard(a.me, deck.id, { front: 'ATP?', back: 'energy' });
    a.app.flashcards.review(a.me, card.id, 'good');
    a.app.identity.rename(a.app.me, 'Ashar');
    a.app.diary.write(a.me, { day: '2026-10-01', body: 'private' });

    await sync(b, a);
    expect(b.app.notes.get(b.me, n.id)?.body).toBe('citrate → isocitrate');
    expect(b.app.courses.topics(b.me, c.id).map((x) => x.title)).toEqual(['Metabolism']);
    expect(b.app.courses.lectures(b.me, c.id)[0]!.topicIds).toEqual([tp.id]);
    expect(b.app.courses.links(b.me, c.id).map((l) => l.entityId)).toEqual([n.id]);
    expect(b.app.tasks.get(b.me, task.id)?.checklist.map((x) => x.text)).toEqual(['Q1']);
    expect(b.app.saved.items(b.me, b.app.saved.inbox(b.me)).map((x) => x.id)).toEqual([item.id]); // built-in Inbox maps to this device's Inbox
    expect(b.app.flashcards.card(b.me, card.id)).toMatchObject({ reps: 1, interval: a.app.flashcards.card(a.me, card.id)!.interval });
    expect(b.app.identity.displayName(b.app.me)).toBe('Ashar');
    expect(b.app.diary.day(b.me, '2026-10-01')).toBeNull(); // Diary is off by default

    const again = await sync(b, a);
    expect(again).toMatchObject({ pulled: 0, pushed: 0 });
    expect((await sync(a, b))).toMatchObject({ pulled: 0, pushed: 0 });
  });

  it('pages stay under ~8 MB however large the notes are, and nothing is skipped', async () => {
    const { a, b } = pair();
    for (let i = 0; i < 60; i++) a.app.notes.create(a.me, { title: `big ${i}`, body: 'x'.repeat(190_000) });
    a.app.sync.refresh();
    let since = 0, pages = 0, seen = 0;
    for (let more = true; more; pages++) { const p = a.app.sync.changes(since, 200); expect(JSON.stringify(p).length).toBeLessThan(9 * 1024 * 1024); seen += p.records.filter((r) => r.kind === 'note').length; since = p.next; more = p.more; }
    expect(seen).toBe(60); expect(pages).toBeGreaterThan(1);
    await sync(b, a);
    expect(b.app.notes.mine(b.me, 100)).toHaveLength(60);
  });

  it('is idempotent and tolerates out-of-order records (a review before its card)', async () => {
    const { a, b } = pair();
    const deck = a.app.flashcards.createDeck(a.me, { name: 'D' }); const card = a.app.flashcards.addCard(a.me, deck.id, { front: 'f', back: 'b' });
    a.app.flashcards.review(a.me, card.id, 'easy');
    a.app.sync.refresh();
    const all = a.app.sync.changes(0, 1000).records;
    const reviews = all.filter((r) => r.kind === 'review'), rest = all.filter((r) => r.kind !== 'review');
    await b.app.sync.applyBatch(a.fp, reviews); // card not here yet → deferred, not lost
    expect(b.app.sync.stats().deferred).toBe(1);
    await b.app.sync.applyBatch(a.fp, rest);
    expect(b.app.sync.stats().deferred).toBe(0);
    expect(b.app.flashcards.history(b.me, card.id)).toHaveLength(1);
    expect((await b.app.sync.applyBatch(a.fp, all)).accepted).toBe(0); // duplicates change nothing
  });

  it('keeps both versions of writing edited on two devices while apart, and "keep both" converges', async () => {
    const { a, b } = pair();
    const n = a.app.notes.create(a.me, { title: 'Essay', body: 'v1' });
    await sync(b, a);
    a.app.notes.update(a.me, n.id, { body: 'laptop draft' }); clock.t += 10;
    b.app.notes.update(b.me, n.id, { body: 'phone draft' });
    await sync(b, a); // B pulls A's edit: concurrent → nothing overwritten
    expect(b.app.notes.get(b.me, n.id)?.body).toBe('phone draft');
    expect(a.app.notes.get(a.me, n.id)?.body).toBe('laptop draft');
    const cb = b.app.sync.conflicts(); const ca = a.app.sync.conflicts();
    expect(cb).toHaveLength(1); expect(ca).toHaveLength(1);
    expect(cb[0]).toMatchObject({ kind: 'note', local: { body: 'phone draft' }, remote: { body: 'laptop draft' }, canKeepBoth: true });
    b.app.sync.resolve(cb[0]!.id, 'both');
    await sync(b, a);
    expect(a.app.notes.get(a.me, n.id)?.body).toBe('phone draft');
    expect(a.app.notes.mine(a.me).map((x) => x.body).sort()).toEqual(['laptop draft', 'phone draft']);
    expect(a.app.sync.conflicts()).toHaveLength(0); // superseded by the resolved version
    expect(await sync(b, a)).toMatchObject({ pulled: 0, pushed: 0 });
  });

  it('an edit made while a round is waiting on the network is never overwritten by the incoming version', async () => {
    const { a, b } = pair();
    const n = a.app.notes.create(a.me, { title: 'Essay', body: 'v1' });
    await sync(b, a);
    a.app.notes.update(a.me, n.id, { body: 'laptop edit' }); a.app.sync.refresh();
    const tr = wire(b, a), pull = tr.pull;
    tr.pull = async (since, limit) => { const r = await pull(since, limit); b.app.notes.update(b.me, n.id, { body: 'typed during the round' }); return r; }; // after b's scan
    clock.t += 1000; await b.app.sync.syncWith(tr);
    expect(b.app.notes.get(b.me, n.id)?.body).toBe('typed during the round');
    expect(b.app.sync.conflicts()[0]).toMatchObject({ kind: 'note', local: { body: 'typed during the round' }, remote: { body: 'laptop edit' } });
  });

  it('tasks: the newer edit wins deterministically, the other is kept and visible', async () => {
    const { a, b } = pair();
    const task = a.app.tasks.create(a.me, { title: 'Read ch.3' });
    await sync(b, a);
    b.app.tasks.update(b.me, task.id, { title: 'Read ch.3 (phone)' }); b.app.sync.refresh(); clock.t += 50;
    a.app.tasks.update(a.me, task.id, { title: 'Read ch.3 + notes' }); a.app.sync.refresh();
    await sync(b, a);
    expect(b.app.tasks.get(b.me, task.id)?.title).toBe('Read ch.3 + notes');
    expect(a.app.tasks.get(a.me, task.id)?.title).toBe('Read ch.3 + notes');
    const h = b.app.sync.conflicts(false).find((c) => c.kind === 'task')!;
    expect(h).toMatchObject({ policy: 'lww', local: { title: 'Read ch.3 (phone)' } });
  });

  it('reviews made on both devices while apart all count; sessions stay distinct', async () => {
    const { a, b } = pair();
    const deck = a.app.flashcards.createDeck(a.me, { name: 'D' }); const card = a.app.flashcards.addCard(a.me, deck.id, { front: 'f', back: 'b' });
    await sync(b, a);
    a.app.flashcards.review(a.me, card.id, 'good'); clock.t += 100;
    b.app.flashcards.review(b.me, card.id, 'again');
    const s1 = a.app.study.start(a.me, { goal: 'laptop' }); a.app.study.end(a.me, s1.id);
    const s2 = b.app.study.start(b.me, { goal: 'phone' }); b.app.study.end(b.me, s2.id);
    await sync(b, a); await sync(b, a);
    expect(a.app.flashcards.history(a.me, card.id)).toHaveLength(2);
    expect(b.app.flashcards.card(b.me, card.id)).toEqual(a.app.flashcards.card(a.me, card.id));
    expect(a.app.study.recent(a.me).map((s) => s.goal).sort()).toEqual(['laptop', 'phone']);
  });

  it('deletions are versioned tombstones: no resurrection, and a newer edit beats an older delete', async () => {
    const { a, b } = pair();
    const r1 = a.app.reminders.create(a.me, { text: 'Lab', dueAt: clock.t + 1e6 }), r2 = a.app.reminders.create(a.me, { text: 'Quiz', dueAt: clock.t + 1e6 });
    await sync(b, a);
    const stale = a.app.sync.changes(0, 1000).records.filter((r) => r.id === r1.id);
    a.app.reminders.remove(a.me, r1.id);
    await sync(b, a);
    expect(b.app.reminders.get(b.me, r1.id)).toBeNull();
    await b.app.sync.applyBatch(a.fp, stale); // an old copy arriving late doesn't bring it back
    expect(b.app.reminders.get(b.me, r1.id)).toBeNull();
    a.app.reminders.remove(a.me, r2.id); a.app.sync.refresh(); clock.t += 100; // the app detects changes on a timer
    b.app.reminders.snooze(b.me, r2.id, clock.t + 5e6); b.app.sync.refresh(); // edited on the phone after the laptop deleted it
    await sync(b, a);
    expect(a.app.reminders.get(a.me, r2.id)?.text).toBe('Quiz');
  });

  it('Diary syncs only when turned on; the same day written on both is kept for comparison', async () => {
    const { a, b } = pair();
    a.app.diary.write(a.me, { day: '2026-10-02', body: 'laptop entry' });
    b.app.diary.write(b.me, { day: '2026-10-02', body: 'phone entry' });
    await sync(b, a);
    expect(b.app.sync.changes(0, 1000).records.some((r) => r.kind === 'diary')).toBe(false);
    a.app.sync.setSettings({ syncDiary: true }); b.app.sync.setSettings({ syncDiary: true });
    await sync(b, a);
    expect(b.app.diary.day(b.me, '2026-10-02')?.body).toBe('phone entry');
    const c = b.app.sync.conflicts().find((x) => x.kind === 'diary')!;
    b.app.sync.resolve(c.id, 'both');
    await sync(b, a);
    expect(a.app.diary.day(a.me, '2026-10-02')?.body).toMatch(/phone entry[\s\S]*laptop entry/);
  });

  it('never applies a record onto someone else\'s row', async () => {
    const { a, b } = pair();
    const other = b.app.notes.create(user('someone-else'), { title: 'theirs', body: 'x' });
    const n = a.app.notes.create(a.me, { title: 'mine', body: 'y' }); a.app.sync.refresh();
    const rec = a.app.sync.changes(0, 1000).records.find((r) => r.id === n.id)!;
    await b.app.sync.applyBatch(a.fp, [{ ...rec, id: other.id }]);
    expect(b.app.notes.get(user('someone-else'), other.id)?.title).toBe('theirs');
    expect(b.app.sync.conflicts()[0]!.note).toMatch(/belongs to someone else/);
  });

  it('survives a restart mid-way (checkpoints persist)', async () => {
    const storageDir = tmp();
    const a = device('MacBook'), b = device('iPhone', { storageDir }); link(a, b);
    for (let i = 0; i < 450; i++) a.app.notes.create(a.me, { title: `n${i}` });
    const ctl = new AbortController(); const tr = wire(b, a); let pages = 0;
    const pull = tr.pull; tr.pull = async (s, l) => { if (++pages === 2) ctl.abort(); return pull(s, l); };
    await b.app.sync.syncWith(tr, { signal: ctl.signal });
    const partial = b.app.notes.mine(b.me, 1000).length;
    expect(partial).toBeGreaterThan(0); expect(partial).toBeLessThan(450);
    const b2 = { ...b, ...setup({ db: b.db, storageDir, now }) }; // reopen the same database
    b2.app.sync.setup({ publicKey: b.key.pub, name: 'iPhone', platform: 'test', tlsCa: 'ca', tlsSpki: 'spki-iPhone' }, { publicKey: b.key.pub, sign: (x) => edSign(null, x, b.key.privateKey).toString('base64url') });
    const r = await b2.app.sync.syncWith(wire(b2 as Dev, a));
    expect(b2.app.notes.mine(b2.me, 1000)).toHaveLength(450);
    expect(r.pulled).toBeLessThan(450 - partial + 5); // resumed from the checkpoint, not from scratch
  });

  it('revocation: an unlinked device is refused, learns it, and stops; it cannot undo its revocation', async () => {
    const a = device('MacBook'), b = device('iPhone'), c = device('Windows'); link(a, b); link(a, c);
    await sync(b, a); await sync(c, a);
    a.app.sync.revoke(c.fp);
    await expect(sync(c, a)).rejects.toThrow(/unlinked/);
    expect(c.app.sync.selfRevoked()).toBe(true);
    expect(c.app.sync.settings().paused).toBe(true);
    await sync(b, a); // the revocation reaches the other devices
    expect(b.app.sync.devices().find((d) => d.fp === c.fp)?.revoked).toBe(true);
    const un = { ...a.app.sync.changes(0, 1000).records.find((r) => r.kind === 'device' && r.id === c.fp)! };
    const entry = { ...(un.payload as object), revokedAt: null, revokedBy: null };
    await b.app.sync.applyBatch(a.fp, [{ ...un, hash: 'x', payload: entry }]);
    expect(b.app.sync.devices().find((d) => d.fp === c.fp)?.revoked).toBe(true);
  });

  it('an unlinked device can start over with a new key and be linked again; its old key stays refused', async () => {
    const { a, b } = pair();
    const oldFp = b.fp;
    a.app.sync.revoke(b.fp);
    await expect(sync(b, a)).rejects.toThrow(/unlinked/);
    b.app.sync.reset();
    const { generateKeyPairSync, sign } = await import('node:crypto');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const pub = Buffer.from(publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)).toString('base64url');
    const fp = b.app.sync.setup({ publicKey: pub, name: 'iPhone', platform: 'test', tlsCa: 'ca', tlsSpki: 'spki-iPhone' }, { publicKey: pub, sign: (x) => sign(null, x, privateKey).toString('base64url') });
    expect(fp).not.toBe(oldFp);
    const b2 = { ...b, fp, key: { privateKey, pub } };
    link(a, b2);
    a.app.notes.create(a.me, { title: 'after relink' });
    await sync(b2, a);
    expect(b.app.notes.mine(b.me).map((n) => n.title)).toContain('after relink');
    expect(a.app.sync.devices().find((d) => d.fp === oldFp)?.revoked).toBe(true);
  });

  it('revocation mid-sync stops at the next request', async () => {
    const { a, b } = pair();
    for (let i = 0; i < 300; i++) a.app.notes.create(a.me, { title: `n${i}` });
    const tr = wire(b, a); const pull = tr.pull; let pages = 0;
    tr.pull = async (s, l) => { if (++pages === 2) a.app.sync.revoke(b.fp); return pull(s, l); };
    await expect(b.app.sync.syncWith(tr)).rejects.toThrow(/unlinked/);
    expect(b.app.sync.selfRevoked()).toBe(true);
  });
});

describe('files', () => {
  const bigFile = (dir: string, size: number) => { const p = join(dir, `f${size}.bin`); writeFileSync(p, randomBytes(size)); return p; };
  it('travel by hash, resume after an interruption, verify SHA-256, and are never duplicated', async () => {
    const { a, b } = pair();
    const f = await a.app.files.add(a.me, bigFile(tmp(), 300_000), 'lecture.pdf', { kind: 'personal', ownerId: a.app.me }, 'application/pdf');
    clock.t += 1000; await expect(b.app.sync.syncWith(wire(b, a, { failObjectAfter: 100_000 }))).resolves.toMatchObject({ objects: 0 });
    expect(b.app.sync.transfers()[0]).toMatchObject({ state: 'partial' });
    expect(b.app.sync.transfers()[0]!.received).toBeGreaterThan(0);
    clock.t += 1000; expect((await b.app.sync.syncWith(wire(b, a))).objects).toBe(1);
    expect(b.app.files.get(b.me, f.refId)).toMatchObject({ sha256: f.sha256, size: 300_000, name: 'lecture.pdf' });
    expect(await b.app.store.verify(b.app.files.get(b.me, f.refId)!.objectId)).toBe(true);
    const objects = (b.db.prepare('SELECT count(*) n FROM resources_objects').get() as { n: number }).n;
    await b.app.files.add(b.me, b.app.store.bySha(f.sha256)!.location, 'copy.pdf', { kind: 'personal', ownerId: b.app.me });
    expect((b.db.prepare('SELECT count(*) n FROM resources_objects').get() as { n: number }).n).toBe(objects);
  });
  it('a corrupted transfer is discarded and retried; low storage waits; large files are opt-in; CLAN files never sync', async () => {
    const { a, b } = pair();
    await a.app.files.add(a.me, bigFile(tmp(), 4096), 'a.bin', { kind: 'personal', ownerId: a.app.me });
    clock.t += 1000; await b.app.sync.syncWith(wire(b, a, { corrupt: true }));
    expect(b.app.sync.transfers()[0]).toMatchObject({ state: 'failed', error: expect.stringMatching(/Checksum/) });
    clock.t += 1000; expect((await b.app.sync.syncWith(wire(b, a))).objects).toBe(1);

    const big = await a.app.files.add(a.me, bigFile(tmp(), 51 * 1024 * 1024), 'recording.webm', { kind: 'personal', ownerId: a.app.me });
    await sync(b, a);
    expect(b.app.sync.transfers().find((x) => x.sha256 === big.sha256)?.state).toBe('skipped');
    b.app.sync.setSettings({ files: 'all' });
    expect(statSync(b.app.store.bySha(big.sha256)?.location ?? join(tmp(), 'none'), { throwIfNoEntry: false })).toBeUndefined();
    await sync(b, a);
    expect(b.app.files.get(b.me, big.refId)?.size).toBe(51 * 1024 * 1024);

    a.app.sync.refresh();
    expect(a.app.sync.changes(0, 5000).records.every((r) => !['chat', 'clan', 'ai', 'ai-settings'].includes(r.kind))).toBe(true);
  }, 30_000);
  it('waits for space instead of filling the disk', async () => {
    const a = device('MacBook');
    const b = { ...device('iPhone') };
    link(a, b);
    await a.app.files.add(a.me, bigFile(tmp(), 8192), 'x.bin', { kind: 'personal', ownerId: a.app.me });
    (b.app.sync as unknown as { freeBytes: () => Promise<number> }).freeBytes = async () => 1024;
    await sync(b, a);
    expect(b.app.sync.transfers()[0]).toMatchObject({ state: 'waiting_space' });
  });
});
