// CLAN types, Personal Space, private data, Diary, AI context, cross-CLAN isolation, search permissions.
import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '../src/index.ts';
import { setup, user } from './helpers.ts';

function world() {
  let t = 1_000_000;
  const { app, db } = setup({ now: () => t });
  const me = user(app.me);
  const bob = user(app.identity.createUser('Bob'));
  const eve = user(app.identity.createUser('Eve'));
  const algo = app.clans.create({ type: 'STUDY_GROUP', name: 'Algo', createdBy: app.me });
  const other = app.clans.create({ type: 'FRIENDS', name: 'Weekend', createdBy: eve.userId });
  app.clans.addMember(algo.id, bob.userId);
  return { app, db, me, bob, eve, algo, other, tick: (ms: number) => { t += ms; } };
}

describe('CLANs and types', () => {
  it('all five types exist; behaviour comes from capabilities', () => {
    const { app, me, tick } = world();
    expect(Object.keys(CAPABILITIES).sort()).toEqual(['CLASSROOM', 'FRIENDS', 'PROJECT_TEAM', 'STUDY_GROUP', 'TEMPORARY']);
    const friends = app.clans.create({ type: 'FRIENDS', name: 'Pals', createdBy: me.userId });
    expect(app.clans.has(friends.id, 'files')).toBe(true);
    expect(app.clans.has(friends.id, 'notes')).toBe(false);
    expect(() => app.notes.share(me, app.notes.create(me, { title: 'x' }).id, friends.id)).toThrow(/use notes/);
    expect(() => app.clans.create({ type: 'TEMPORARY', name: 'Exam night', createdBy: me.userId })).toThrow();
    const temp = app.clans.create({ type: 'TEMPORARY', name: 'Exam night', createdBy: me.userId, expiresAt: 1_000_000 + 3600_000 });
    expect(app.clans.isActiveMember(temp.id, me.userId)).toBe(true);
    tick(3600_001);
    expect(app.clans.isActiveMember(temp.id, me.userId)).toBe(false); // expired: access ends
    expect(() => app.clans.create({ type: 'GUILD' as never, name: 'x', createdBy: me.userId })).toThrow();
  });
});

describe('Personal Space and private data', () => {
  it('notes and saved items are private by default; sharing creates a live reference that can be withdrawn', () => {
    const { app, me, bob, algo } = world();
    const n = app.notes.create(me, { title: 'Heaps', body: 'sift down is O(log n)' });
    const s = app.saved.add(me, { url: 'https://example.com/heaps', note: 'good one' });
    expect(app.notes.get(bob, n.id)).toBeNull();
    expect(app.saved.get(bob, s.id)).toBeNull();
    expect(app.notes.mine(bob)).toEqual([]);

    app.notes.share(me, n.id, algo.id);
    expect(app.notes.get(bob, n.id)!.body).toBe('sift down is O(log n)');
    app.notes.update(me, n.id, { body: 'edited' });
    expect(app.notes.inClan(bob, algo.id)[0]!.body).toBe('edited'); // reference, not a copy
    expect((app.db.prepare('SELECT count(*) c FROM notes_notes').get() as { c: number }).c).toBe(1);
    expect(() => app.notes.update(bob, n.id, { body: 'hijack' })).toThrow(); // members read, owners write
    app.notes.share(me, n.id, algo.id, false);
    expect(app.notes.get(bob, n.id)).toBeNull();
  });

  it('only http(s) links are saved, and only as metadata', () => {
    const { app, me } = world();
    expect(() => app.saved.add(me, { url: 'javascript:alert(1)' })).toThrow();
    expect(() => app.saved.add(me, { url: 'file:///etc/passwd' })).toThrow();
    expect(app.saved.add(me, { url: 'https://www.youtube.com/watch?v=x' })).toMatchObject({ source: 'youtube.com', title: 'youtube.com' });
  });

  it('reminders are personal and refer to things by reference', () => {
    const { app, me, bob } = world();
    const n = app.notes.create(me, { title: 'PS4' });
    app.reminders.create(me, { text: 'Finish PS4', dueAt: 1_100_000, target: { module: 'notes', id: n.id } });
    expect(app.reminders.upcoming(me)[0]!.target).toEqual({ module: 'notes', id: n.id });
    expect(app.reminders.upcoming(bob)).toEqual([]);
  });
});

describe('cross-CLAN isolation', () => {
  it('membership of one CLAN gives nothing in another', async () => {
    const { app, me, bob, eve, algo, other } = world();
    const n = app.notes.create(eve, { title: 'Weekend plan', body: 'hike' });
    expect(() => app.notes.share(eve, n.id, algo.id)).toThrow(); // Eve is not in Algo
    expect(app.notes.inClan(bob, other.id)).toEqual([]);
    expect(app.files.list(me, { kind: 'clan', clanId: other.id })).toEqual([]);
    expect(app.saved.inClan(me, other.id)).toEqual([]);
    app.clans.setStatus(algo.id, bob.userId, 'removed');
    const mine = app.notes.create(me, { title: 'Graphs' });
    app.notes.share(me, mine.id, algo.id);
    expect(app.notes.get(bob, mine.id)).toBeNull(); // removed members lose access
  });
});

describe('Diary privacy', () => {
  it('owner only, never indexed, no events carrying it, agents refused', () => {
    const { app, db, me, bob } = world();
    app.diary.write(me, { day: '2026-10-07', body: 'secret feelings', mood: 'anxious' });
    expect(app.diary.day(me, '2026-10-07')!.body).toBe('secret feelings');
    expect(app.diary.day(bob, '2026-10-07')).toBeNull();
    expect(() => app.diary.recent({ kind: 'agent', agentId: 'a', onBehalfOf: me.userId, scopes: ['diary:read'] })).toThrow(/private/);
    expect(app.search.query(me, 'secret')).toEqual([]);
    expect(() => app.search.register({ module: 'diary', events: [], one: () => null, all: () => [] })).toThrow(/never indexed/);
    expect(JSON.stringify(db.prepare('SELECT payload FROM core_events').all())).not.toContain('secret');
    expect(db.prepare("SELECT count(*) c FROM search_docs WHERE body LIKE '%secret%'").get()).toEqual({ c: 0 });
  });
});

describe('AI Context API', () => {
  const agent = (onBehalfOf: string, scopes: string[]) => ({ kind: 'agent' as const, agentId: 'guide', onBehalfOf, scopes });

  it('Diary is DENIED unless explicitly granted; grants expire and can be revoked', () => {
    const { app, me, tick } = world();
    app.diary.write(me, { day: '2026-10-07', body: 'tired but ok' });
    const ask = () => app.context.request(agent(me.userId, ['diary:read']), { module: 'diary' });
    expect(ask()).toMatchObject({ status: 'DENIED' });
    expect(app.context.request(me, { module: 'diary' })).toMatchObject({ status: 'DENIED' }); // even the user's own UI asks through the grant
    app.permissions.grant(me.userId, 'ai', 'diary', 1_000_000 + 60_000);
    expect(ask()).toMatchObject({ status: 'OK', items: [{ excerpt: 'tired but ok' }] });
    tick(60_001);
    expect(ask()).toMatchObject({ status: 'DENIED' });
    app.permissions.grant(me.userId, 'ai', 'diary');
    app.permissions.revoke(me.userId, 'ai', 'diary');
    expect(ask()).toMatchObject({ status: 'DENIED' });
  });

  it('agents only get modules in their scopes, only for the user they act for', () => {
    const { app, me, bob, algo } = world();
    app.notes.create(me, { title: 'Dijkstra', body: 'greedy' });
    const shared = app.notes.create(bob, { title: 'Bob private', body: 'mine' });
    expect(app.context.request(agent(me.userId, ['saved:read']), { module: 'notes' })).toMatchObject({ status: 'DENIED' });
    const r = app.context.request(agent(me.userId, ['notes:read']), { module: 'notes', query: 'greedy' });
    expect(r).toMatchObject({ status: 'OK', items: [{ title: 'Dijkstra', module: 'notes' }] });
    expect(app.context.request(agent(me.userId, ['notes:read']), { module: 'notes', ids: [shared.id] })).toEqual({ status: 'OK', items: [] });
    app.notes.share(bob, shared.id, algo.id);
    expect(app.context.request(agent(me.userId, ['notes:read']), { module: 'notes', ids: [shared.id] })).toMatchObject({ items: [{ title: 'Bob private' }] });
    expect(app.context.request(agent(me.userId, ['x:read']), { module: 'chat' })).toMatchObject({ status: 'DENIED' });
  });
});

describe('search permissions', () => {
  it('returns only what the caller can read, and a rebuild gives the same answers', () => {
    const { app, me, bob, eve, algo } = world();
    app.notes.create(me, { title: 'Graph theory', body: 'my private graph notes' });
    const shared = app.notes.create(bob, { title: 'Graph cheatsheet', body: 'BFS DFS' });
    app.notes.share(bob, shared.id, algo.id);
    app.notes.create(eve, { title: 'Graph secrets', body: 'eve only' });
    app.saved.add(me, { url: 'https://example.com/graphs', title: 'Graph video' });

    const titles = (p: typeof me) => app.search.query(p, 'graph').map((h) => h.title).sort();
    expect(titles(me)).toEqual(['Graph cheatsheet', 'Graph theory', 'Graph video']);
    expect(titles(bob)).toEqual(['Graph cheatsheet']);
    expect(titles(eve)).toEqual(['Graph secrets']);
    expect(app.search.query({ kind: 'agent', agentId: 'g', onBehalfOf: me.userId, scopes: ['notes:read'] }, 'graph').map((h) => h.module)).not.toContain('saved');

    const before = [titles(me), titles(bob), titles(eve)];
    app.db.prepare('DELETE FROM search_docs').run();
    app.search.rebuild();
    expect([titles(me), titles(bob), titles(eve)]).toEqual(before);
    expect(app.search.query(me, '%')).toEqual([]); // LIKE wildcards are literal
  });
});

describe('Share-to-CLAN', () => {
  it('routes each kind to its owning module; unbuilt targets say so', async () => {
    const { app, me, bob, algo } = world();
    const url = await app.share.share(me, { kind: 'url', url: 'https://example.com/x' }, { kind: 'clan', clanId: algo.id });
    expect(url).toMatchObject({ status: 'ok', module: 'saved' });
    expect(app.saved.inClan(bob, algo.id)).toHaveLength(1);
    expect(await app.share.share(me, { kind: 'text', text: 'idea' }, { kind: 'inbox' })).toMatchObject({ status: 'ok', module: 'notes' });
    // A course is its CLASSROOM CLAN; a non-course CLAN is refused as a course; "person" happens only inside a live room.
    const os = app.clans.create({ type: 'CLASSROOM', name: 'OS', createdBy: app.me });
    expect(await app.share.share(me, { kind: 'text', text: 'x' }, { kind: 'course', courseId: os.id })).toMatchObject({ status: 'ok', module: 'notes' });
    expect(app.notes.inClan(me, os.id)).toHaveLength(1);
    await expect(app.share.share(me, { kind: 'text', text: 'x' }, { kind: 'course', courseId: algo.id })).rejects.toThrow(/not a course/);
    expect(await app.share.share(me, { kind: 'text', text: 'x' }, { kind: 'person', userId: bob.userId })).toMatchObject({ status: 'unsupported' });
    await expect(app.share.share(bob, { kind: 'url', url: 'https://e.com' }, { kind: 'clan', clanId: 'not-mine' })).rejects.toThrow();
  });
});
