// The `DatabaseSync` subset @clan/core uses (`exec`, `prepare().get/all/run`), on expo-sqlite's synchronous API, so
// the phone runs the same modules, migrations and PersonalSync engine as the desktop. Statements are cached per SQL
// text (core prepares inline) and finalized when evicted.
import { openDatabaseSync, type SQLiteDatabase, type SQLiteStatement } from 'expo-sqlite';

type Param = string | number | null | Uint8Array;
const MAX_CACHED = 400;

export class UnreadableDatabase extends Error {}

/** Opens the SQLCipher database; a key that doesn't unlock it (e.g. data restored onto a new phone) → UnreadableDatabase. */
function openKeyed(name: string, key: string): SQLiteDatabase {
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('Bad database key.');
  const db = openDatabaseSync(name);
  db.execSync(`PRAGMA key = '${key}'`); // SQLCipher: must be first; the key comes from secure storage only
  try { db.execSync('SELECT count(*) FROM sqlite_master'); } catch { db.closeSync(); throw new UnreadableDatabase('This phone’s CLAN data can’t be unlocked.'); }
  return db;
}

export function openPhoneDb(name: string, key: string) {
  const db: SQLiteDatabase = openKeyed(name, key);
  db.execSync('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const cache = new Map<string, SQLiteStatement>();
  const stmt = (sql: string) => {
    let s = cache.get(sql);
    if (s) { cache.delete(sql); cache.set(sql, s); return s; } // LRU order
    s = db.prepareSync(sql); cache.set(sql, s);
    if (cache.size > MAX_CACHED) { const [k, old] = cache.entries().next().value!; cache.delete(k); old.finalizeSync(); }
    return s;
  };
  const exec = (s: SQLiteStatement, p: Param[]) => s.executeSync<Record<string, unknown>>(...(p as never[]));
  return {
    exec(sql: string) { db.execSync(sql); },
    prepare(sql: string) {
      return {
        get: (...p: Param[]) => exec(stmt(sql), p).getFirstSync() ?? undefined,
        all: (...p: Param[]) => exec(stmt(sql), p).getAllSync(),
        run: (...p: Param[]) => { const r = exec(stmt(sql), p); return { changes: r.changes, lastInsertRowid: r.lastInsertRowId }; },
      };
    },
    close() { for (const s of cache.values()) s.finalizeSync(); cache.clear(); db.closeSync(); },
  };
}
