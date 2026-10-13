// Data safety on disposable device databases: automatic backups, recovery from a damaged file, update (migrations on an
// older database) and personal export → import into a fresh device.
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, openSync, readdirSync, writeSync, closeSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDb, migrate, MIGRATIONS, openDb as nativeOpenDb, openDbSafely as nativeOpenDbSafely } from '../../server/src/db.ts';
import { openClan } from '../src/index.ts';
import { tmp, user } from './helpers.ts';

const dbs: DatabaseSync[] = [];
const openDb = (...args: Parameters<typeof nativeOpenDb>) => { const db = nativeOpenDb(...args); dbs.push(db); return db; };
const openDbSafely = (...args: Parameters<typeof nativeOpenDbSafely>) => { const result = nativeOpenDbSafely(...args); dbs.push(result.db); return result; };
afterEach(() => { for (const db of dbs.splice(0)) { try { db.close(); } catch {} } });
const notesOf = (path: string) => { const d = new DatabaseSync(path, { readOnly: true }); try { return (d.prepare('SELECT title FROM notes_notes ORDER BY title').all() as { title: string }[]).map((r) => r.title); } finally { d.close(); } };

describe('device database safety', () => {
  it('backups are consistent snapshots, rotated to the newest three', () => {
    const dir = tmp(), path = join(dir, 'teacher.db');
    const db = openDb(path), app = openClan(db, { storageDir: dir }), me = user(app.me);
    app.notes.create(me, { title: 'kept' });
    for (let i = 0; i < 5; i++) backupDb(db, join(dir, 'backups'), { now: Date.UTC(2026, 9, 1 + i) });
    const files = readdirSync(join(dir, 'backups')).sort();
    expect(files).toEqual(['teacher-2026-10-03-00-00-00.db', 'teacher-2026-10-04-00-00-00.db', 'teacher-2026-10-05-00-00-00.db']);
    expect(notesOf(join(dir, 'backups', files[2]!))).toEqual(['kept']);
    expect(backupDb(db, join(dir, 'backups'), { now: Date.UTC(2026, 9, 9), reserve: Number.MAX_SAFE_INTEGER })).toBeNull(); // low disk: skipped
    expect(readdirSync(join(dir, 'backups')).sort()).toEqual(files); // and the existing backups are untouched
  });

  it('a damaged database is kept aside and the newest healthy backup is restored', () => {
    const dir = tmp(), path = join(dir, 'teacher.db'), backups = join(dir, 'backups');
    const db = openDb(path), app = openClan(db, { storageDir: dir }), me = user(app.me);
    app.notes.create(me, { title: 'before backup' });
    backupDb(db, backups, { now: Date.UTC(2026, 9, 1) });
    writeFileSync(join(backups, 'teacher-2026-10-02-00-00-00.db'), 'not a database'); // newer but broken: skipped
    app.notes.create(me, { title: 'after backup' });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();
    const fd = openSync(path, 'r+'); const size = statSync(path).size;
    for (let off = 4096; off < size; off += 4096) writeSync(fd, Buffer.alloc(512, 0xa5), 0, 512, off); // smash every page
    closeSync(fd);
    const r = openDbSafely(path, backups);
    expect(r.recovered).toMatchObject({ from: 'teacher-2026-10-01-00-00-00.db' });
    expect(existsSync(r.recovered!.keptAt)).toBe(true);
    r.db.close();
    expect(notesOf(path)).toEqual(['before backup']);
  });

  it('a file that is not SQLite at all, with no backup: kept aside, fresh database, nothing deleted', () => {
    const dir = tmp(), path = join(dir, 'teacher.db');
    writeFileSync(path, 'garbage'.repeat(500));
    const r = openDbSafely(path, join(dir, 'backups'));
    expect(r.recovered).toMatchObject({ from: null });
    expect(existsSync(r.recovered!.keptAt)).toBe(true);
    expect(() => openClan(r.db, { storageDir: dir })).not.toThrow();
  });

  it('a healthy database opens untouched', () => {
    const dir = tmp(), path = join(dir, 'teacher.db');
    openDb(path).close();
    expect(openDbSafely(path, join(dir, 'backups')).recovered).toBeNull();
  });

  it('a locked healthy database is not renamed, reset or rolled back to an older backup', () => {
    const dir = tmp(), path = join(dir, 'teacher.db'), backups = join(dir, 'backups');
    const raw = new DatabaseSync(path); dbs.push(raw);
    raw.exec('CREATE TABLE proof(value); INSERT INTO proof VALUES(7)');
    backupDb(raw, backups, { reserve: 0 });
    raw.exec('INSERT INTO proof VALUES(9); BEGIN EXCLUSIVE');
    const files = readdirSync(dir).sort(), saved = readdirSync(backups).sort();
    try {
      expect(() => openDbSafely(path, backups)).toThrow(/locked/);
      expect(readdirSync(dir).sort()).toEqual(files);
      expect(readdirSync(backups).sort()).toEqual(saved);
    } finally { raw.exec('ROLLBACK'); }
    raw.close();
    const result = openDbSafely(path, backups);
    expect(result.recovered).toBeNull();
    expect(result.db.prepare('SELECT value FROM proof ORDER BY value').all().map(r => r.value)).toEqual([7, 9]);
  });

  it('an inaccessible database path fails without renaming its contents', () => {
    const dir = tmp(), path = tmp(), sentinel = join(path, 'keep.txt');
    writeFileSync(sentinel, 'must remain in place');
    const files = readdirSync(path).sort();
    expect(() => openDbSafely(path, join(dir, 'backups'))).toThrow();
    expect(existsSync(sentinel)).toBe(true);
    expect(readdirSync(path).sort()).toEqual(files);
  });

  it('update: an older database is migrated forward and keeps its data (re-opening is idempotent)', () => {
    const dir = tmp(), path = join(dir, 'teacher.db');
    const old = new DatabaseSync(path); migrate(old, MIGRATIONS.length - 1); old.close(); // a build one migration behind
    const db = openDbSafely(path, join(dir, 'backups')).db, app = openClan(db, { storageDir: dir }), me = user(app.me);
    const [pre] = readdirSync(join(dir, 'backups')); // taken before migrating, still on the old schema
    const b = new DatabaseSync(join(dir, 'backups', pre!), { readOnly: true });
    expect((b.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(MIGRATIONS.length - 1); b.close();
    app.notes.create(me, { title: 'survives updates' }); app.diary.write(me, { day: '2026-10-01', body: 'private' });
    db.close();
    const again = openDb(path), app2 = openClan(again, { storageDir: dir });
    expect(app2.notes.mine(user(app2.me)).map((n) => n.title)).toEqual(['survives updates']);
    expect(app2.me).toBe(app.me);
  });
});

describe('personal export / import', () => {
  it('exports personal data as sync records (Diary only when asked) and imports them into a fresh device', () => {
    const a = openClan(openDb(':memory:'), { storageDir: tmp() }), me = user(a.me);
    const c = a.courses.create(me, { name: 'Physics' }); a.courses.addTopic(me, c.id, 'Optics');
    a.notes.create(me, { title: 'Lenses', body: 'f = 1/(1/u + 1/v)' });
    a.tasks.create(me, { title: 'Lab report', courseId: c.id });
    a.diary.write(me, { day: '2026-10-01', body: 'private thought' });
    const plain = a.sync.exportAll(), withDiary = a.sync.exportAll({ diary: true });
    expect(plain.records.some((r) => r.kind === 'diary')).toBe(false);
    expect(withDiary.records.filter((r) => r.kind === 'diary')).toHaveLength(1);
    expect(plain.records.every((r) => !['device', 'chat', 'ai'].includes(r.kind))).toBe(true);
    expect(JSON.stringify(plain)).not.toContain(a.me); // owner ids never leave the device

    const b = openClan(openDb(':memory:'), { storageDir: tmp() }), mb = user(b.me);
    expect(b.sync.importExport(JSON.parse(JSON.stringify(withDiary)))).toBe(withDiary.records.length);
    expect(b.courses.topics(mb, c.id).map((t) => t.title)).toEqual(['Optics']);
    expect(b.notes.mine(mb)[0]?.body).toBe('f = 1/(1/u + 1/v)');
    expect(b.diary.day(mb, '2026-10-01')?.body).toBe('private thought');
    expect(() => b.sync.importExport({ format: 'something-else', records: [] })).toThrow(/not a CLAN export/);
  });
});

describe('diagnostics', () => {
  it('contain counts and sync numbers only: no note, Diary or chat text, ids or names', () => {
    const app = openClan(openDb(':memory:'), { storageDir: tmp(), localName: 'Secret Person' }), me = user(app.me);
    app.notes.create(me, { title: 'TOP-SECRET-TITLE', body: 'TOP-SECRET-BODY' });
    app.diary.write(me, { day: '2026-10-01', body: 'DIARY-SECRET' });
    const out = JSON.stringify(app.sync.diagnostics());
    for (const secret of ['TOP-SECRET', 'DIARY-SECRET', 'Secret Person', app.me]) expect(out).not.toContain(secret);
    expect(app.sync.diagnostics().counts).toMatchObject({ note: 1, diary: 1 });
  });
});

