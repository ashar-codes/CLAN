// Chat, direct sends and Capture over the real host: OPAQUE join, pinned TLS/WSS, the @clan/core Chat store on the
// host's device database. Focused on authority, privacy and idempotency — not on UI.
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID, createHash } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, startClassroomServer, type RunningServer } from '@classroom/server';
import { uploadShare } from '@classroom/client/node';
import type { ChatMessageView, ChatThreadView, ClanType, ResourceView } from '@classroom/protocol';
import { device, get, makeFile, secureJoin, socket, tmp, trFor, trustServer } from '../../server/test/helpers.ts';
import { fetchLinkMeta, openClan, parseIntake } from '../src/index.ts';
import { file, setup, user } from './helpers.ts';

const servers: RunningServer[] = [];
const hostDbs: ReturnType<typeof openDb>[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); for (const db of hostDbs.splice(0)) { try { db.close(); } catch {} } });

/** A host device: one database holding classroom tables + CLAN modules (as on the desktop), hosting `clanId`. */
async function hostOn(db: ReturnType<typeof openDb>, clanId: string, type: ClanType = 'STUDY_GROUP', storageDir = tmp('chat-host-')) {
  hostDbs.push(db);
  const app = openClan(db, { storageDir });
  if (!app.clans.get(clanId)) app.clans.create({ id: clanId, type, name: `${type} chat`, createdBy: app.me, expiresAt: type === 'TEMPORARY' ? Date.now() + 3600_000 : undefined });
  const s = await startClassroomServer({ title: `${type} chat`, host: '127.0.0.1', db, storageDir, chat: app.chat, hostName: 'Hana', clan: { type, id: clanId } });
  servers.push(s); trustServer(s); s.classroom.setPolicy('open');
  return { s, app };
}
type Who = { token: string; memberId: string; d: ReturnType<typeof device>; ws: ReturnType<typeof socket>; handle: string };
async function member(s: RunningServer, n: number, d = device()): Promise<Who> {
  const j = await secureJoin(s, n, d);
  const ws = socket(s.url, j.token); await ws.opened; await ws.next('hello');
  const roster = await ws.next('members', () => true, 500).catch(() => null);
  return { token: j.token, memberId: j.memberId, d, ws, handle: roster?.me ?? s.chat!.handleOf({ role: 'student', memberId: j.memberId }) };
}
const hostWs = async (s: RunningServer) => { const w = socket(s.url, s.classroom.teacherToken); await w.opened; await w.next('hello'); return w; };
const json = async <T>(r: Response) => (await r.json()) as T;
const threads = (s: RunningServer, token: string) => get(`${s.url}/api/chat/threads`, token).then((r) => json<{ me: string; threads: ChatThreadView[] }>(r));
const pageOf = (s: RunningServer, token: string, id: string, q = '') => get(`${s.url}/api/chat/threads/${id}/messages${q}`, token);
const say = (w: Who | ReturnType<typeof socket>, body: string, thread: unknown = { kind: 'group' }, extra: object = {}) => {
  const id = randomUUID(); sock(w).send({ t: 'chat.send', id, thread, body, ...extra }); return id;
};
const sock = (w: Who | ReturnType<typeof socket>) => ('handle' in w ? w.ws : w);
const got = (w: Who | ReturnType<typeof socket>, id: string) => sock(w).next('chat.message', (m) => m.message.id === id).then((m) => m.message);

describe('group conversation', () => {
  it('reaches every member and the host in one host-assigned order; history pages with indexed cursors', async () => {
    const { s } = await hostOn(openDb(':memory:'), randomUUID());
    const h = await hostWs(s), a = await member(s, 1), b = await member(s, 2);
    const first = say(a, 'hello everyone');
    const m = await got(b, first);
    expect(m).toMatchObject({ body: 'hello everyone', authorName: 'Student 1', author: a.handle, seq: 1, replyTo: null });
    expect((await got(h, first)).id).toBe(first);
    expect((await sock(a).next('chat.ack', (x) => x.id === first)).seq).toBe(1);
    // Concurrent senders: unique, gap-free order that every reader sees identically.
    const ids = [...Array.from({ length: 6 }, (_, i) => say(i % 2 ? a : b, `m${i}`))];
    for (const id of ids) await got(h, id);
    const page = await json<{ messages: ChatMessageView[] }>(await pageOf(s, a.token, m.threadId));
    expect(page.messages.map((x) => x.seq)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    const pb = await json<{ messages: ChatMessageView[] }>(await pageOf(s, b.token, m.threadId));
    expect(pb.messages.map((x) => x.id)).toEqual(page.messages.map((x) => x.id));
    const older = await json<{ messages: ChatMessageView[] }>(await pageOf(s, b.token, m.threadId, '?before=5&limit=2'));
    expect(older.messages.map((x) => x.seq)).toEqual([3, 4]);
    // Delivery truth: cursors come only from receivers' own reports.
    sock(b).send({ t: 'chat.cursor', threadId: m.threadId, delivered: 7, read: 2 });
    const c = await sock(a).next('chat.cursors', (x) => !!x.cursors[b.handle]);
    expect(c.cursors[b.handle]).toEqual({ delivered: 7, read: 2 });
  });

  it('replies reference ids (never copied text); reactions are idempotent; edits/removals stay visible as such', async () => {
    const { s } = await hostOn(openDb(':memory:'), randomUUID());
    const h = await hostWs(s), a = await member(s, 1), b = await member(s, 2);
    const q = say(a, 'question?'); const qm = await got(b, q);
    const r = say(b, 'answer', { id: qm.threadId }, { replyTo: q }); const rm = await got(a, r);
    expect(rm).toMatchObject({ replyTo: q, body: 'answer' });
    // Replying into another conversation is refused.
    sock(b).send({ t: 'chat.send', id: randomUUID(), thread: { kind: 'direct', to: a.handle }, body: 'x', replyTo: q });
    expect((await sock(b).next('chat.nack')).code).toBe('bad_reply');
    for (let i = 0; i < 3; i++) sock(b).send({ t: 'chat.react', id: q, reaction: '👍', on: true });
    // Separate sockets have no send-order guarantee. Observe the first applied
    // reaction before sending the second; retain the exact order/idempotence assertion.
    await sock(b).next('chat.message', (m) => m.message.id === q && m.message.reactions.some((x) => x.by.includes(b.handle)));
    sock(a).send({ t: 'chat.react', id: q, reaction: '👍', on: true });
    await sock(a).next('chat.message', (m) => m.message.id === q && m.message.reactions.some((x) => x.by.includes(a.handle) && x.by.includes(b.handle)));
    const after = (await json<{ messages: ChatMessageView[] }>(await pageOf(s, a.token, qm.threadId))).messages[0]!;
    expect(after.reactions).toEqual([{ reaction: '👍', by: [b.handle, a.handle] }]);
    sock(b).send({ t: 'chat.react', id: q, reaction: '👍', on: false });
    sock(b).send({ t: 'chat.edit', id: q, body: 'not mine' }); // someone else's message
    expect((await sock(b).next('error')).code).toBe('forbidden');
    sock(a).send({ t: 'chat.edit', id: q, body: 'question (edited)?' });
    expect((await sock(b).next('chat.message', (m) => m.message.id === q && !!m.message.editedAt)).message.body).toBe('question (edited)?');
    // The host moderates group messages; the original stays in place as "removed" and the reply still points at it.
    h.send({ t: 'chat.remove', id: q });
    const gone = (await sock(b).next('chat.message', (m) => m.message.id === q && !!m.message.removed)).message;
    expect(gone).toMatchObject({ body: '', attachment: null, removed: { by: 'host' }, reactions: [] });
    expect((await json<{ messages: ChatMessageView[] }>(await pageOf(s, b.token, qm.threadId))).messages.find((m) => m.id === r)!.replyTo).toBe(q);
  });
});

describe('direct conversations and privacy', () => {
  it('only the two participants receive or can fetch it; the host device never notifies about it', async () => {
    const db = openDb(':memory:');
    const { s, app } = await hostOn(db, randomUUID());
    const h = await hostWs(s), a = await member(s, 1), b = await member(s, 2), c = await member(s, 3);
    const notices: string[] = [];
    app.notifications.onNotice = (n) => notices.push(n.threadId);
    app.chat.setMe(s.chat!.clanKey, s.chat!.hostHandle); // the desktop records its own handle when it hosts
    const dm = say(b, 'just between us', { kind: 'direct', to: a.handle });
    const m = await got(a, dm);
    expect((await got(b, dm)).id).toBe(dm); // the sender's other view
    await expect(sock(c).next('chat.message', (x) => x.message.id === dm, 400)).rejects.toThrow();
    await expect(h.next('chat.message', (x) => x.message.id === dm, 400)).rejects.toThrow();
    expect((await pageOf(s, c.token, m.threadId)).status).toBe(404);
    expect((await threads(s, c.token)).threads.map((t) => t.kind)).toEqual(['group']);
    expect((await threads(s, a.token)).threads.find((t) => t.kind === 'direct')).toMatchObject({ with: { handle: b.handle, name: 'Student 2', here: true }, unread: 1 });
    // Stored on the host (it relays), but not readable as the host's own, not searchable there, and no notice.
    expect(app.chat.localThreads(user(app.me), s.chat!.clanKey).map((t) => t.kind)).toEqual(['group']);
    expect(app.search.query(user(app.me), 'between')).toEqual([]);
    expect(notices).toEqual([]);
    // Messages to the host do notify it — without the text unless previews are on.
    const toHost = say(a, 'hi host', { kind: 'direct', to: s.chat!.hostHandle });
    await got(h, toHost);
    expect(notices).toHaveLength(1);
    expect(app.notifications.list(user(app.me))[0]).toMatchObject({ title: 'Student 1 · STUDY_GROUP chat', body: 'Sent you a message' });
    // A Classroom student without VIEW_MEMBERS can message the host only.
    const cls = await hostOn(openDb(':memory:'), randomUUID(), 'CLASSROOM');
    const s1 = await member(cls.s, 1), s2 = await member(cls.s, 2);
    const s2h = cls.s.chat!.handleOf({ role: 'student', memberId: s2.memberId });
    sock(s1).send({ t: 'chat.send', id: randomUUID(), thread: { kind: 'direct', to: s2h }, body: 'psst' });
    expect((await sock(s1).next('chat.nack')).code).toBe('forbidden');
    expect((await got(s1, say(s1, 'teacher?', { kind: 'direct', to: cls.s.chat!.hostHandle }))).body).toBe('teacher?');
  });

  it('cross-CLAN: another CLAN hosted by the same device (same database) is invisible; forged authors are impossible', async () => {
    const db = openDb(':memory:');
    const x = await hostOn(db, randomUUID()), y = await hostOn(db, randomUUID());
    const ax = await member(x.s, 1), ay = await member(y.s, 2);
    const id = say(ax, 'clan X only'); const m = await got(ax, id);
    expect((await pageOf(y.s, ay.token, m.threadId)).status).toBe(404);
    expect((await pageOf(y.s, ax.token, m.threadId)).status).toBe(401); // X's token means nothing to Y
    sock(ay).send({ t: 'chat.send', id: randomUUID(), thread: { id: m.threadId }, body: 'sneak' });
    expect((await sock(ay).next('chat.nack')).code).toBe('not_found');
    // Handles are CLAN-scoped: the same device has unrelated handles in two CLANs.
    const d = device();
    const p = await member(x.s, 3, d), q = await member(y.s, 3, d);
    expect(p.handle).not.toBe(q.handle);
    // The author is the authenticated sender — a claimed author is ignored, and reusing someone's message id is refused.
    const mine = say(p, 'me', { kind: 'group' }, { author: ax.handle, authorName: 'Host' });
    expect((await got(p, mine))).toMatchObject({ author: p.handle, authorName: 'Student 3' });
    sock(p).send({ t: 'chat.send', id, thread: { kind: 'group' }, body: 'hijack' });
    expect((await sock(p).next('chat.nack')).code).toBe('conflict');
  });

  it('a removed member can no longer send, fetch or receive', async () => {
    const { s } = await hostOn(openDb(':memory:'), randomUUID());
    const h = await hostWs(s), a = await member(s, 1), b = await member(s, 2);
    const m = await got(b, say(a, 'before'));
    h.send({ t: 'member.remove', memberId: b.memberId });
    await sock(b).closed();
    expect((await pageOf(s, b.token, m.threadId)).status).toBe(401);
    expect((await get(`${s.url}/api/chat/threads`, b.token)).status).toBe(401);
    const after = say(a, 'after');
    await got(h, after);
    expect(sock(b).msgs.some((x) => x.t === 'chat.message' && x.message.id === after)).toBe(false);
  });

  it('reconnect replays the outbox idempotently: one stored message, one delivery, same order', async () => {
    const dir = tmp('chat-outbox-');
    const { s } = await hostOn(openDb(':memory:'), randomUUID());
    const a = await member(s, 1), b = await member(s, 2);
    // Sender device: the outbox survives an app restart (same database file).
    const dev = setup({ db: openDb(join(dir, 'member.db')) });
    const id = randomUUID(), payload = { id, t: 'chat.send', thread: { kind: 'group' }, body: 'sent while flaky' };
    dev.app.chat.queue('clan-x', payload);
    dev.db.close();
    const again = setup({ db: openDb(join(dir, 'member.db')) });
    expect(again.app.chat.outbox('clan-x')).toEqual([payload]);
    // First attempt reaches the host but the connection dies before the ack; the retry gets the same seq.
    sock(a).send(payload); sock(a).close();
    await got(b, id);
    const ws = socket(s.url, a.token); await ws.opened; await ws.next('hello');
    ws.send(payload); ws.send(payload);
    const acks = [await ws.next('chat.ack', (x) => x.id === id), await ws.next('chat.ack', (x) => x.id === id)];
    expect(new Set(acks.map((x) => x.seq))).toEqual(new Set([1]));
    again.app.chat.sent(id);
    expect(again.app.chat.outbox('clan-x')).toEqual([]);
    await new Promise((r) => setTimeout(r, 150));
    expect(sock(b).msgs.filter((x) => x.t === 'chat.message' && x.message.id === id)).toHaveLength(0); // delivered exactly once (consumed above)
    expect((await threads(s, b.token)).threads[0]!.lastSeq).toBe(1);
  });

  it('history survives the host restarting and re-hosting the CLAN; member devices cache it idempotently', async () => {
    const dir = tmp('chat-rehost-'), clanId = randomUUID(), d = device();
    let db = openDb(join(dir, 'host.db'));
    let { s } = await hostOn(db, clanId, 'STUDY_GROUP', join(dir, 'storage'));
    const a = await member(s, 1, d), b = await member(s, 2);
    const g = await got(b, say(a, 'first session'));
    const dm = await got(a, say(b, 'dm in session 1', { kind: 'direct', to: a.handle }));
    // A member device caches what it received (twice — no duplicates).
    const cache = setup();
    const ts = (await threads(s, a.token)).threads;
    for (let i = 0; i < 2; i++) for (const t of ts) cache.app.chat.ingest(t, a.handle, (await json<{ messages: ChatMessageView[] }>(await pageOf(s, a.token, t.id))).messages);
    expect(cache.app.chat.page(g.threadId).map((m) => m.body)).toEqual(['first session']);
    await s.close(); servers.splice(servers.indexOf(s), 1); db.close();
    db = openDb(join(dir, 'host.db'));
    ({ s } = await hostOn(db, clanId, 'STUDY_GROUP', join(dir, 'storage')));
    const a2 = await member(s, 1, d);
    expect(a2.handle).toBe(a.handle); // same device, same CLAN → same person in chat
    const t2 = (await threads(s, a2.token)).threads;
    expect(t2.map((t) => t.id).sort()).toEqual(ts.map((t) => t.id).sort());
    expect((await json<{ messages: ChatMessageView[] }>(await pageOf(s, a2.token, dm.threadId))).messages.map((m) => m.body)).toEqual(['dm in session 1']);
    const next = await got(a2, say(a2, 'second session'));
    expect(next.seq).toBe(2);
    expect(cache.app.chat.ingest(t2.find((t) => t.kind === 'group')!, a.handle, [g, next])).toEqual([next.id]);
  });
});

describe('sending files to one CLANmate vs the table', () => {
  it('a person share is visible and downloadable only by its recipients; the table reaches everyone; bytes stored once', async () => {
    const { s } = await hostOn(openDb(':memory:'), randomUUID());
    const h = await hostWs(s), a = await member(s, 1), b = await member(s, 2);
    const f = makeFile(300_000, 'notes.pdf');
    const toA = await s.shareFile(f.path, a.handle);
    const table = await s.shareFile(f.path, 'clan', 'notes-for-all.pdf');
    const list = async (w: Who) => (await json<{ resources: ResourceView[] }>(await get(`${s.url}/api/resources`, w.token))).resources;
    expect((await list(a)).map((r) => [r.id, !!r.direct])).toEqual(expect.arrayContaining([[toA.id, true], [table.id, false]]));
    expect((await list(b)).map((r) => r.id)).toEqual([table.id]);
    expect(s.resources.listForTeacher().map((r) => r.id)).toEqual([table.id]); // the CLAN's files: the table only
    const content = (w: Who, id: string) => get(`${s.url}/api/resources/${id}/content`, w.token);
    expect((await content(b, toA.id)).status).toBe(404);
    expect((await get(`${s.url}/api/resources/${toA.id}/manifest`, b.token)).status).toBe(404);
    const bytes = Buffer.from(await (await content(a, toA.id)).arrayBuffer());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(f.sha256);
    expect(() => s.resources.push(toA.id)).toThrow(/one person/);
    // Same bytes twice → one copy on disk (hard link), two resources with their own scopes.
    const [p1, p2] = [join(s.storage.root, 'resources', toA.id), join(s.storage.root, 'resources', table.id)];
    expect(statSync(p1).ino).toBe(statSync(p2).ino);
    // Attaching: a person's file can't be posted to the whole CLAN; a table file can go anywhere.
    h.send({ t: 'chat.send', id: randomUUID(), thread: { kind: 'group' }, body: '', attachment: { kind: 'file', resourceId: toA.id } });
    expect((await h.next('chat.nack')).code).toBe('forbidden');
    const sent = say(h, 'for you', { kind: 'direct', to: a.handle }, { attachment: { kind: 'file', resourceId: toA.id } });
    expect((await got(a, sent)).attachment).toEqual({ kind: 'file', resourceId: toA.id, name: 'notes.pdf', size: 300_000, mime: 'application/pdf', sha256: f.sha256 });
    // A member sends a file to one CLANmate over the same resumable upload protocol.
    const g = makeFile(50_000, 'draft.txt');
    const r = await uploadShare({ transport: trFor(s.url), url: s.url, token: b.token, path: g.path, to: a.handle, idempotencyKey: randomUUID() });
    expect(r.direct).toEqual({ from: 'Student 2' });
    expect((await content(a, r.id)).status).toBe(200);
    const c = await member(s, 3);
    expect((await content(c, r.id)).status).toBe(404);
    // Classroom students cannot send files at all (SEND_FILES is not theirs).
    const cls = await hostOn(openDb(':memory:'), randomUUID(), 'CLASSROOM');
    const st = await member(cls.s, 1);
    await expect(uploadShare({ transport: trFor(cls.s.url), url: cls.s.url, token: st.token, path: g.path, to: 'clan', idempotencyKey: randomUUID() })).rejects.toThrow(/cannot share/);
  });

  it('a saved link shared into a conversation carries the link, not the sender’s Saved shelf', async () => {
    const { s } = await hostOn(openDb(':memory:'), randomUUID());
    const a = await member(s, 1), b = await member(s, 2);
    const dev = setup();
    const it = dev.app.saved.add(user(dev.app.me), { url: 'https://example.org/lecture-7', title: 'Lecture 7', tags: ['os'] });
    const id = say(a, 'watch this', { kind: 'direct', to: b.handle }, { attachment: { kind: 'link', url: it.url, title: it.title, savedItemId: it.id } });
    expect((await got(b, id)).attachment).toEqual({ kind: 'link', url: 'https://example.org/lecture-7', title: 'Lecture 7', source: 'example.org', savedItemId: it.id });
    dev.app.saved.move(user(dev.app.me), it.id, dev.app.saved.createCollection(user(dev.app.me), 'Done'));
    expect(dev.app.saved.items(user(dev.app.me))[0]!.sharedWith).toEqual([]); // personal organisation stays personal
    sock(a).send({ t: 'chat.send', id: randomUUID(), thread: { kind: 'group' }, body: '', attachment: { kind: 'link', url: 'javascript:alert(1)' } });
    expect((await sock(a).next('error')).code).toBe('invalid');
  });
});

describe('Capture Inbox and intake', () => {
  it('captures land privately in the Inbox as canonical items; filing moves or shares them without copies', async () => {
    const { app } = setup();
    const me = user(app.me), bob = user(app.identity.createUser('Bob'));
    const algo = app.clans.create({ type: 'STUDY_GROUP', name: 'Algo', createdBy: app.me });
    app.clans.addMember(algo.id, bob.userId);
    const dir = tmp('capture-');
    const n = await app.capture.capture(me, { kind: 'note', title: 'Idea' });
    const l = await app.capture.capture(me, { kind: 'link', url: 'https://example.com/paper' });
    const t = await app.capture.capture(me, { kind: 'text', text: 'Ask about paging\nand TLBs' });
    const f1 = await app.capture.capture(me, { kind: 'file', path: file(dir, 'a.txt', 'same bytes'), name: 'a.txt' });
    const f2 = await app.capture.capture(me, { kind: 'file', path: file(dir, 'b.txt', 'same bytes'), name: 'a.txt' });
    expect(f2.id).toBe(f1.id); // one canonical file, one Inbox entry
    expect(app.store.orphans()).toEqual([]);
    expect(app.capture.inbox(me).map((x) => x.kind).sort()).toEqual(['file', 'link', 'note', 'text']);
    expect(app.capture.inbox(bob)).toEqual([]);
    expect(app.notes.inClan(bob, algo.id)).toEqual([]); // nothing shared until filed
    app.capture.file(me, t.id, { kind: 'clan', clanId: algo.id });
    app.capture.file(me, f1.id, { kind: 'clan', clanId: algo.id });
    app.saved.move(me, l.entityId, app.saved.createCollection(me, 'Papers')); // filing from Saved counts too
    expect(app.notes.inClan(bob, algo.id).map((x) => x.title)).toEqual(['Ask about paging']);
    expect(app.files.list(bob, { kind: 'clan', clanId: algo.id }).map((x) => x.objectId)).toEqual([app.files.list(me, { kind: 'personal', ownerId: app.me })[0]!.objectId]);
    expect(app.capture.inbox(me).map((x) => x.id)).toEqual([n.id]);
    expect(() => app.capture.file(me, n.id, { kind: 'collection', collectionId: app.saved.inbox(me) })).toThrow(/Collections hold links/);
    expect(() => app.capture.file(bob, n.id, { kind: 'done' })).toThrow(/Not found/);
  });

  it('a link saved offline is kept at once and enriched later; only HTML is read, never media', async () => {
    const { app } = setup();
    const me = user(app.me);
    const it = app.saved.add(me, { url: 'https://videos.example/watch?v=1' });
    expect(it.title).toBe('videos.example');
    expect(app.saved.pendingMeta()).toEqual([{ id: it.id, url: it.url }]);
    app.saved.applyMeta(it.id, await fetchLinkMeta(it.url, async () => { throw new Error('offline'); }));
    expect(app.saved.get(me, it.id)!.title).toBe('videos.example'); // failed enrichment never loses the link
    const it2 = app.saved.add(me, { url: 'https://example.com/a' });
    const html = '<html><head><meta property="og:title" content="Paging &amp; TLBs"><meta property="og:image" content="https://example.com/i.png"></head><body>…';
    app.saved.applyMeta(it2.id, await fetchLinkMeta(it2.url, async () => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } })));
    expect(app.saved.get(me, it2.id)).toMatchObject({ title: 'Paging & TLBs', previewUrl: 'https://example.com/i.png' });
    let read = false;
    const video = new Response(new ReadableStream({ pull(c) { read = true; c.enqueue(new Uint8Array(1024)); } }, { highWaterMark: 0 }), { headers: { 'content-type': 'video/mp4' } });
    expect(await fetchLinkMeta('https://videos.example/v.mp4', async () => video)).toBeNull();
    expect(read).toBe(false);
  });

  it('external intake accepts only a link or text; paths, scripts and smuggled characters are refused', () => {
    expect(parseIntake('clan://capture?url=https%3A%2F%2Fexample.com%2Fx&title=Read')).toEqual({ kind: 'url', url: 'https://example.com/x', title: 'Read' });
    expect(parseIntake('clan://capture?text=remember%20this')).toEqual({ kind: 'text', text: 'remember this' });
    for (const bad of [
      'clan://capture?url=javascript%3Aalert(1)', 'clan://capture?url=file%3A%2F%2F%2Fetc%2Fpasswd', 'clan://capture?url=data%3Atext%2Fhtml,x',
      'clan://capture?path=%2Fetc%2Fpasswd', 'clan://capture?file=x', 'clan://capture?url=https%3A%2F%2Fa.com&text=x', 'clan://capture?text=a&text=b',
      'clan://capture?text=evil%E2%80%AEtxt.exe', 'clan://capture?text=%00', 'clan://open?url=https%3A%2F%2Fa.com', 'https://capture?url=https%3A%2F%2Fa.com',
      'clan://capture?url=https%3A%2F%2Fuser%3Apass%40a.com', 'clan://capture', `clan://capture?text=${'a'.repeat(10_001)}`, 'not a url',
    ]) expect(parseIntake(bad), bad).toBeNull();
  });

  it('notifications respect focus, the open conversation and preferences, and coalesce busy groups', () => {
    const { app } = setup();
    const me = user(app.me);
    const clan = app.clans.create({ type: 'STUDY_GROUP', name: 'Algo', createdBy: app.me });
    const seen: { alert: boolean; body: string }[] = [];
    app.notifications.onNotice = (n) => seen.push({ alert: n.alert, body: n.body });
    app.chat.setMe(clan.id, 'me-handle-0000000000000');
    const dm = app.chat.directThread(clan.id, 'me-handle-0000000000000', 'sara-handle-00000000000'), g = app.chat.groupThread(clan.id);
    const post = (t: string, body: string, author = 'sara-handle-00000000000') => app.chat.post({ id: randomUUID(), threadId: t, author, authorName: 'Sara', body });
    post(dm.id, 'secret plan');
    expect(seen.pop()).toEqual({ alert: true, body: 'Sent you a message' });
    app.notifications.setPrefs(me, { previews: true });
    post(dm.id, 'see you at 5');
    expect(seen.pop()!.body).toBe('see you at 5');
    app.notifications.context = { foreground: true, viewing: dm.id, focus: false };
    post(dm.id, 'are you there');
    expect(seen).toEqual([]); // looking at it: no notice
    app.notifications.context = { foreground: false, viewing: null, focus: true };
    post(dm.id, 'during focus');
    expect(seen.pop()!.alert).toBe(false); // listed, not pinged
    app.notifications.context = { foreground: false, viewing: null, focus: false };
    post(g.id, 'one'); post(g.id, 'two'); post(g.id, 'mine', 'me-handle-0000000000000');
    expect(seen.map((x) => x.alert)).toEqual([true, false]); // second group message only counts; own messages never notify
    app.notifications.setPrefs(me, { groups: false });
    post(g.id, 'three');
    expect(seen).toHaveLength(2);
  });
});

