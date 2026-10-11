// Core services: module migrations, typed/versioned events, idempotent consumers, Resource Store dedupe + references.
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { migrateModules } from '../src/core/db.ts';
import { defineEvent, EventBus, eventsSchema } from '../src/core/events.ts';
import { file, setup, tmp, user } from './helpers.ts';

describe('module migrations', () => {
  it('apply per module, incrementally, once', () => {
    const db = new DatabaseSync(':memory:');
    const v1 = { module: 'demo', prefix: 'demo', migrations: ['CREATE TABLE demo_a (x INTEGER)'] };
    migrateModules(db, [v1]);
    migrateModules(db, [v1]); // no-op
    migrateModules(db, [{ ...v1, migrations: [...v1.migrations, 'ALTER TABLE demo_a ADD COLUMN y INTEGER; CREATE INDEX demo_a_y ON demo_a(y)'] }]);
    expect(db.prepare("SELECT version FROM core_module_versions WHERE module = 'demo'").get()).toEqual({ version: 2 });
    expect(db.prepare('SELECT x, y FROM demo_a').all()).toEqual([]);
  });

  it('refuse to create objects outside the module prefix', () => {
    const db = new DatabaseSync(':memory:');
    expect(() => migrateModules(db, [{ module: 'notes', prefix: 'notes', migrations: ['CREATE TABLE saved_items (x)'] }])).toThrow(/notes_\*/);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'saved_items'").get()).toBeUndefined();
  });

  it('every shipped module schema obeys its prefix', async () => {
    const { SCHEMAS } = await import('../src/index.ts');
    expect(() => migrateModules(new DatabaseSync(':memory:'), SCHEMAS)).not.toThrow();
  });
});

describe('events', () => {
  const V1 = defineEvent('Thing', 1, z.object({ name: z.string() }));
  const V2 = defineEvent('Thing', 2, z.object({ title: z.string(), size: z.number() }), { from: 1, up: (o) => ({ title: (o as { name: string }).name, size: 0 }) });
  const bus = () => { const db = new DatabaseSync(':memory:'); migrateModules(db, [eventsSchema]); return { db, bus: new EventBus(db, () => 42) }; };

  it('carry id, type, schema version, producer and timestamp; invalid payloads are rejected', () => {
    const { bus: b } = bus();
    const e = b.publish(V1, 'tests', { name: 'x' });
    expect(e).toMatchObject({ type: 'Thing', version: 1, producer: 'tests', ts: 42, payload: { name: 'x' } });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(() => b.publish(V1, 'tests', { name: 3 } as never)).toThrow();
  });

  it('older stored versions are upcast for newer consumers; unknown versions fail loudly', () => {
    const { db, bus: b } = bus();
    b.publish(V1, 'tests', { name: 'old' });
    expect(b.history(V2)[0]!.payload).toEqual({ title: 'old', size: 0 });
    db.prepare("INSERT INTO core_events (id, type, version, producer, ts, payload) VALUES ('z', 'Thing', 9, 'x', 1, '{}')").run();
    expect(() => b.history(V2)).toThrow(/v9/);
  });

  it('persistent consumers apply each event exactly once, also after a failure and restart', () => {
    const { db, bus: b } = bus();
    db.exec('CREATE TABLE seen (n TEXT)');
    let fail = true;
    b.onError = () => {};
    b.subscribe('counter', V1, (e) => { db.prepare('INSERT INTO seen VALUES (?)').run(e.payload.name); if (fail && e.payload.name === 'b') throw new Error('crash'); }, { persistent: true });
    b.publish(V1, 'tests', { name: 'a' });
    b.publish(V1, 'tests', { name: 'b' }); // fails: its effect is rolled back, the event stays pending
    expect(db.prepare('SELECT n FROM seen').all()).toEqual([{ n: 'a' }]);
    fail = false;
    b.deliverPending();
    b.deliverPending();
    const restarted = new EventBus(db);
    restarted.subscribe('counter', V1, (e) => { db.prepare('INSERT INTO seen VALUES (?)').run(e.payload.name); }, { persistent: true });
    restarted.deliverPending();
    expect(db.prepare('SELECT n FROM seen ORDER BY n').all()).toEqual([{ n: 'a' }, { n: 'b' }]);
  });

  it('producers never import consumers (search subscribes to notes, not the reverse)', () => {
    const notes = readFileSync(join(import.meta.dirname, '../src/modules/notes/index.ts'), 'utf8');
    expect(notes).not.toMatch(/SearchIndex|import \{[^}]*\} from '..\/..\/core\/search/); // type-only provider contract is fine
    expect(notes).not.toMatch(/\.reindex\(/);
  });
});

describe('Resource Store', () => {
  it('scoped collection retains referenced and in-flight content, deletes only managed orphan bytes, and retries after a crash', async () => {
    const { app, db, storageDir } = setup();
    try {
      const source = file(storageDir, 'original.txt', 'Keep the user original');
      const stored = await app.store.put(source);
      expect(() => app.store.collectOwned(stored.object.id)).toThrow('still in progress');
      const again = await app.store.put(source);
      stored.release(); stored.release(); // idempotent; a second writer still holds its own reservation
      expect(() => app.store.collectOwned(stored.object.id)).toThrow('still in progress');
      const ref = app.store.ref(stored.object.id, { module: 'files', entity: 'file', entityId: 'test', scope: { kind: 'personal', ownerId: app.me }, createdBy: app.me });
      again.release();
      expect(app.store.collectOwned(stored.object.id)).toBe('retained');
      expect(await app.store.verify(stored.object.id)).toBe(true);
      app.store.unref(ref.id);
      expect(app.store.collectOwned(stored.object.id)).toBe('removed');
      expect(app.store.collectOwned(stored.object.id)).toBe('absent');
      expect(existsSync(source)).toBe(true);
      expect(existsSync(stored.object.location)).toBe(false);
      const next = await app.store.put(source); next.release();
      unlinkSync(next.object.location); // crash after unlink, before the orphan metadata was committed
      expect(app.store.collectOwned(next.object.id)).toBe('removed');
      const external = app.store.adopt({ sha256: 'a'.repeat(64), size: 1, mime: 'text/plain', location: source });
      expect(app.store.collectOwned(external.id)).toBe('adopted');
      expect(existsSync(source)).toBe(true);
      db.prepare("UPDATE resources_objects SET origin = 'store' WHERE id = ?").run(external.id);
      expect(() => app.store.collectOwned(external.id)).toThrow('outside the managed');
      expect(existsSync(source)).toBe(true);
    } finally { db.close(); }
  });
  it('stores identical content once; each use is a reference; SHA-256 is verified', async () => {
    const { app, storageDir } = setup();
    const dir = tmp();
    const a = file(dir, 'a.pdf', 'same bytes'), b = file(dir, 'copy of a.pdf', 'same bytes');
    const me = user(app.me);
    const f1 = await app.files.add(me, a, 'a.pdf', { kind: 'personal', ownerId: app.me });
    const clan = app.clans.create({ type: 'STUDY_GROUP', name: 'Algo', createdBy: app.me });
    const f2 = await app.files.add(me, b, 'copy of a.pdf', { kind: 'clan', clanId: clan.id });
    expect(f2.objectId).toBe(f1.objectId);
    expect(app.store.refsOf(f1.objectId)).toHaveLength(2);
    const objects = readdirSync(join(storageDir, 'objects'), { recursive: true }).filter((f) => String(f).length > 60);
    expect(objects).toHaveLength(1);
    expect(await app.store.verify(f1.objectId)).toBe(true);
    // removing one reference keeps the content for the other; no refs → GC candidate
    app.files.remove(me, f1.refId);
    expect(app.store.orphans()).toEqual([]);
    app.files.remove(me, f2.refId);
    expect(app.store.orphans().map((o) => o.id)).toEqual([f1.objectId]);
    // the original user files were never moved
    expect(readFileSync(a, 'utf8')).toBe('same bytes');
  });

  it('sharing a file into a CLAN adds a reference, not a copy', async () => {
    const { app } = setup();
    const me = user(app.me);
    const f = await app.files.add(me, file(tmp(), 'n.txt', 'notes'), 'n.txt', { kind: 'personal', ownerId: app.me });
    const clan = app.clans.create({ type: 'PROJECT_TEAM', name: 'Capstone', createdBy: app.me });
    const s = app.files.share(me, f.refId, { kind: 'clan', clanId: clan.id });
    expect(s.objectId).toBe(f.objectId);
    expect(s.refId).not.toBe(f.refId);
  });
});
