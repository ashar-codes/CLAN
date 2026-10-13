// The personal-sync contract a module implements, plus a helper for the common case "a row keyed by id with an owner
// column, and some child rows". The module decides which of ITS tables take part, which columns are device-local, and
// how conflicts are handled; the engine never writes a module table itself. Incoming payloads are validated against the
// table's real columns, ownership is forced to the local account, and rows owned by someone else are refused.
import type { Db } from './db.ts';
import { tx } from './db.ts';

/** preserve: keep both sides of a conflict (valuable writing). lww: newest version wins, the loser is kept for review.
 *  union: the module merges (append-only / set-like content). */
export type SyncPolicy = 'preserve' | 'lww' | 'union';
/** A dependency hasn't arrived yet (e.g. a review before its card): the engine retries the record later. */
export class SyncDefer extends Error {}
/** The module can't apply without losing local data (e.g. a second Diary entry for the same day): preserve both. */
export class SyncConflict extends Error {}
export type ApplyResult = void | { needs: { sha256: string; size: number; mime: string } };
export type SyncProvider = {
  kind: string; policy: SyncPolicy;
  /** Sensitive kinds (Diary) sync only when the student turns them on. */
  sensitive?: boolean;
  all(owner: string): Map<string, unknown>;
  one(owner: string, id: string): unknown | null;
  apply(owner: string, id: string, payload: unknown | null, o: { merge: boolean }): ApplyResult;
  /** Keep both sides of an unresolved conflict (e.g. a copy of the note); the local entity keeps the local version. */
  keepBoth?(owner: string, id: string, remote: unknown): void;
};

type Child = { table: string; fk: string; key?: string; /** rows elsewhere pointing at a child, removed before it */ dependents?: { table: string; fk: string }[]; exclude?: string[]; order?: string; /** insert-only values for excluded NOT NULL columns */ defaults?: Record<string, (row: Record<string, unknown>) => unknown>; /** fk is on a grandchild: SQL selecting parent-scope ids */ via?: { table: string; fk: string } };
export type RowSpec = {
  kind: string; policy: SyncPolicy; sensitive?: boolean; table: string; owner: string;
  /** Extra filter on the parent rows (e.g. only finished sessions). */
  where?: string;
  /** Device-local columns: never exported, kept on update, defaulted on insert. */
  exclude?: string[]; children?: Child[];
  insertDefaults?: Record<string, (row: Record<string, unknown>) => unknown>;
  /** Payload → row fields adjustments (e.g. built-in collection ids are per device). */
  toLocal?(owner: string, row: Record<string, unknown>): Record<string, unknown>;
  toWire?(owner: string, row: Record<string, unknown>): Record<string, unknown>;
  after?(owner: string, id: string, deleted: boolean): void;
  keepBoth?(owner: string, id: string, remote: unknown): void;
};
const MAX_TEXT = 400_000, MAX_CHILDREN = 5000;
const okId = (v: unknown) => typeof v === 'string' && /^[A-Za-z0-9:_.-]{1,80}$/.test(v);

export function rowProvider(db: Db, s: RowSpec): SyncProvider {
  const cols = (t: string) => (db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((c) => c.name);
  const pc = cols(s.table), ex = new Set([...(s.exclude ?? []), s.owner]);
  const childCols = new Map((s.children ?? []).map((c) => [c.table, cols(c.table)]));
  const where = s.where ? ` AND (${s.where})` : '';
  const strip = (row: Record<string, unknown>, drop: Set<string>) => Object.fromEntries(Object.entries(row).filter(([k]) => !drop.has(k)).sort(([a], [b]) => a.localeCompare(b)));
  const childRows = (c: Child, ids: string[]) => {
    if (!ids.length) return [];
    const sel = c.via ? `SELECT g.*, p.${c.via.fk} AS __p FROM ${c.table} g JOIN ${c.via.table} p ON p.id = g.${c.fk} WHERE p.${c.via.fk} IN (SELECT value FROM json_each(?))`
      : `SELECT *, ${c.fk} AS __p FROM ${c.table} WHERE ${c.fk} IN (SELECT value FROM json_each(?))`;
    return db.prepare(`${sel} ORDER BY ${c.order ?? (c.key ? c.key : 'rowid')}`).all(JSON.stringify(ids)) as Record<string, unknown>[];
  };
  const build = (owner: string, rows: Record<string, unknown>[]) => {
    const out = new Map<string, unknown>(); const ids = rows.map((r) => r.id as string);
    const kids = new Map((s.children ?? []).map((c) => [c.table, childRows(c, ids)]));
    for (const r of rows) {
      const p: Record<string, unknown> = strip(s.toWire ? s.toWire(owner, r) : r, ex);
      for (const c of s.children ?? []) p[`~${c.table}`] = kids.get(c.table)!.filter((k) => k.__p === r.id).map((k) => strip(k, new Set(['__p', ...(c.exclude ?? [])])));
      out.set(r.id as string, p);
    }
    return out;
  };
  const prov: SyncProvider = {
    kind: s.kind, policy: s.policy, sensitive: s.sensitive,
    all: (owner) => build(owner, db.prepare(`SELECT * FROM ${s.table} WHERE ${s.owner} = ?${where}`).all(owner) as Record<string, unknown>[]),
    one: (owner, id) => { const r = db.prepare(`SELECT * FROM ${s.table} WHERE id = ? AND ${s.owner} = ?${where}`).get(id, owner) as Record<string, unknown> | undefined; return r ? build(owner, [r]).get(id)! : null; },
    apply: (owner, id, payload) => tx(db, () => {
      if (!okId(id)) throw new Error('Bad id.');
      const cur = db.prepare(`SELECT ${s.owner} o FROM ${s.table} WHERE id = ?`).get(id) as { o: string } | undefined;
      if (cur && cur.o !== owner) throw new Error('That record belongs to someone else.'); // cross-user isolation
      const delChildren = () => { for (const c of [...(s.children ?? [])].reverse()) {
        if (c.via) db.prepare(`DELETE FROM ${c.table} WHERE ${c.fk} IN (SELECT id FROM ${c.via.table} WHERE ${c.via.fk} = ?)`).run(id);
        else db.prepare(`DELETE FROM ${c.table} WHERE ${c.fk} = ?`).run(id);
      } };
      if (payload === null) { if (cur) { for (const c of s.children ?? []) if (c.key) for (const d of c.dependents ?? []) db.prepare(`DELETE FROM ${d.table} WHERE ${d.fk} IN (SELECT ${c.key} FROM ${c.table} WHERE ${c.fk} = ?)`).run(id); delChildren(); db.prepare(`DELETE FROM ${s.table} WHERE id = ?`).run(id); } s.after?.(owner, id, true); return; }
      if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Bad payload.');
      const raw = payload as Record<string, unknown>;
      const row = s.toLocal ? s.toLocal(owner, { ...raw }) : { ...raw };
      const fields = clean(row, pc, ex); fields.id = id; fields[s.owner] = owner;
      if (!cur) for (const [k, f] of Object.entries(s.insertDefaults ?? {})) if (fields[k] === undefined) fields[k] = f(fields);
      const keys = Object.keys(fields);
      db.prepare(`INSERT INTO ${s.table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')}) ON CONFLICT (id) DO UPDATE SET ${keys.filter((k) => k !== 'id').map((k) => `${k} = excluded.${k}`).join(', ')}`).run(...keys.map((k) => fields[k] as never));
      for (const c of s.children ?? []) {
        const list = raw[`~${c.table}`]; if (!Array.isArray(list) || list.length > MAX_CHILDREN) throw new Error('Bad child rows.');
        const cc = childCols.get(c.table)!, cex = new Set(c.exclude ?? []);
        const rows = list.map((x) => { const f = clean(x as Record<string, unknown>, cc, cex); if (!c.via) f[c.fk] = id; return f; });
        if (c.via) { const parents = new Set((db.prepare(`SELECT id FROM ${c.via.table} WHERE ${c.via.fk} = ?`).all(id) as { id: string }[]).map((r) => r.id)); if (rows.some((r) => !parents.has(r[c.fk] as string))) throw new Error('Child of another record.'); }
        if (c.key) {
          const ids = rows.map(r => r[c.key!]);
          if (ids.some(k => typeof k !== 'string' || !okId(k)) || new Set(ids).size !== ids.length) throw new Error('Invalid or duplicate child identity.');
          for (const row of rows) {
            const prior = db.prepare(`SELECT ${c.fk} parent FROM ${c.table} WHERE ${c.key} = ?`).get(row[c.key] as string) as {parent:string}|undefined;
            if (prior && prior.parent !== row[c.fk]) throw new Error('That child belongs to another record.');
          }
          const keep = new Set(rows.map((r) => r[c.key!] as string));
          const existing = (c.via ? db.prepare(`SELECT ${c.key} k FROM ${c.table} WHERE ${c.fk} IN (SELECT id FROM ${c.via.table} WHERE ${c.via.fk} = ?)`) : db.prepare(`SELECT ${c.key} k FROM ${c.table} WHERE ${c.fk} = ?`)).all(id) as { k: string }[];
          for (const e of existing) if (!keep.has(e.k)) { for (const d of c.dependents ?? []) db.prepare(`DELETE FROM ${d.table} WHERE ${d.fk} = ?`).run(e.k); db.prepare(`DELETE FROM ${c.table} WHERE ${c.key} = ?`).run(e.k); }
          for (const r of rows) {
            const upd = Object.keys(r), ins = { ...r };
            for (const [k, f] of Object.entries(c.defaults ?? {})) if (ins[k] === undefined) ins[k] = f(r);
            const k = Object.keys(ins);
            db.prepare(`INSERT INTO ${c.table} (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')}) ON CONFLICT (${c.key}) DO UPDATE SET ${upd.filter((x) => x !== c.key).map((x) => `${x} = excluded.${x}`).join(', ') || `${c.key} = excluded.${c.key}`}`).run(...k.map((x) => ins[x] as never));
          }
        } else {
          if (c.via) db.prepare(`DELETE FROM ${c.table} WHERE ${c.fk} IN (SELECT id FROM ${c.via.table} WHERE ${c.via.fk} = ?)`).run(id); else db.prepare(`DELETE FROM ${c.table} WHERE ${c.fk} = ?`).run(id);
          for (const r of rows) { const k = Object.keys(r); db.prepare(`INSERT OR IGNORE INTO ${c.table} (${k.join(', ')}) VALUES (${k.map(() => '?').join(', ')})`).run(...k.map((x) => r[x] as never)); }
        }
      }
      s.after?.(owner, id, false);
    }),
    keepBoth: s.keepBoth,
  };
  return prov;
}

/** Only real columns, only primitive values, bounded text. */
function clean(row: Record<string, unknown>, allowed: string[], drop: Set<string>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (!allowed.includes(k) || drop.has(k)) continue;
    if (v !== null && typeof v !== 'string' && typeof v !== 'number') throw new Error(`Bad value for ${k}.`);
    if (typeof v === 'string' && v.length > MAX_TEXT) throw new Error(`${k} is too long.`);
    out[k] = v;
  }
  return out;
}
