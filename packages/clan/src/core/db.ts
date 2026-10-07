// Per-module schema ownership. A module's migrations may only create objects named with its own prefix; versions are
// tracked per module so modules evolve independently. Shipped migrations are append-only.
import type { DatabaseSync } from 'node:sqlite';

export type Db = DatabaseSync;
export type ModuleSchema = { module: string; prefix: string; migrations: string[] };

const CREATED = /\bCREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([A-Za-z_]\w*)/gi;
export const createdNames = (sql: string) => [...sql.matchAll(CREATED)].map((m) => m[1]!);

export function migrateModules(db: Db, schemas: ModuleSchema[]) {
  db.exec('CREATE TABLE IF NOT EXISTS core_module_versions (module TEXT PRIMARY KEY, version INTEGER NOT NULL)');
  const get = db.prepare('SELECT version FROM core_module_versions WHERE module = ?');
  const set = db.prepare('INSERT INTO core_module_versions (module, version) VALUES (?, ?) ON CONFLICT (module) DO UPDATE SET version = excluded.version');
  for (const s of schemas) {
    s.migrations.forEach((sql, i) => {
      const bad = createdNames(sql).filter((n) => !n.startsWith(`${s.prefix}_`));
      if (bad.length) throw new Error(`Module ${s.module} may only create ${s.prefix}_* objects (found ${bad.join(', ')}) in migration ${i + 1}`);
    });
    const from = (get.get(s.module) as { version: number } | undefined)?.version ?? 0;
    for (let v = from; v < s.migrations.length; v++) tx(db, () => { db.exec(s.migrations[v]!); set.run(s.module, v + 1); });
  }
}

let depth = 0;
/** Nest-safe transaction (SAVEPOINT). */
export function tx<T>(db: Db, f: () => T): T {
  const name = `sp${depth++}`;
  db.exec(`SAVEPOINT ${name}`);
  try { const r = f(); db.exec(`RELEASE ${name}`); return r; } catch (e) { db.exec(`ROLLBACK TO ${name}`); db.exec(`RELEASE ${name}`); throw e; } finally { depth--; }
}

export const tableExists = (db: Db, name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
