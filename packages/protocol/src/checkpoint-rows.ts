// CLAN checkpoint sections: the contract each owning package implements, plus a declarative helper for "these rows of
// my tables belong to this CLAN". The helper validates received rows strictly (only the table's real columns, only
// primitive values, every scope column equal to the CLAN or referencing a row of the same section), never touches a
// column the spec excludes (secrets, tokens, device-local state) and imports parent-first inside the caller's
// transaction. Structural database type so the server (node:sqlite) and the CLAN core share it.
export type CheckpointFile = { sha256: string; size: number };
export type SectionExport = { rows: unknown[]; files: (CheckpointFile & { path: string })[] };
/** Something a hand-over would not carry intact. Blocking issues stop it; others need the user's explicit acknowledgment. */
export type PreflightIssue = { section: string; code: string; count: number; blocking: boolean; message: string };
export interface CheckpointProvider {
  readonly section: string;
  /** A source without this storage at all (a phone has no host-server tables) omits the section; the destination then
   *  imports nothing for it and keeps its own rows. Every other section must be present. */
  readonly optional?: boolean;
  /** Before export: every reason this section cannot carry the CLAN completely. Nothing is ever dropped silently. */
  preflight?(clanId: string): Omit<PreflightIssue, 'section'>[];
  /** Synchronous, consistent read of one CLAN's rows on the frozen host. */
  export(clanId: string): SectionExport;
  /** Strict parse of received rows; returns every file they require. Throws on anything malformed or out of scope. */
  validate(clanId: string, rows: unknown[]): CheckpointFile[];
  /** Places verified bytes (`blob(sha)` is a verified staged path) before the database import. Idempotent. */
  materialize?(clanId: string, rows: unknown[], blob: (sha256: string) => string): Promise<void>;
  /** Runs inside the activation transaction. */
  import(clanId: string, rows: unknown[], ctx: { me: string }): void;
}

type Stmt = { all(...a: unknown[]): unknown[]; run(...a: unknown[]): unknown };
export type SqlDb = { prepare(sql: string): Stmt };
export type TableSpec = {
  table: string;
  /** SQL condition selecting this CLAN's rows; every `?` is bound to the CLAN id. Also the scope replaced on import. */
  where: string;
  /** Column → its required value: the CLAN id, a key present in another table of this section, or a predicate. */
  scope: Record<string, 'clan' | { table: string; column: string } | ((value: unknown, clanId: string, section: Map<string, Record<string, unknown>[]>) => boolean)>;
  /** Never exported, never overwritten (secrets, tokens, device-local state). NOT NULL ones need `fill`. */
  exclude?: string[];
  /** Insert-only values for excluded columns. */
  fill?: Record<string, () => unknown>;
  /** Primary key columns: upsert (keeps excluded columns of existing rows) instead of delete + insert. */
  upsertKey?: string[];
  /** Only rows matching this predicate are exported (e.g. ready files). */
  keep?: (row: Record<string, unknown>) => boolean;
};
type Tagged = { t: string; r: Record<string, unknown> };
const IDENT = /^[a-z_][a-z0-9_]*$/;
const MAX_ROWS = 2_000_000;

export function tableSection(db: SqlDb, specs: TableSpec[]) {
  for (const s of specs) if (!IDENT.test(s.table)) throw new Error('bad table');
  const colsCache = new Map<string, string[]>();
  const columns = (table: string) => {
    let c = colsCache.get(table);
    if (!c) colsCache.set(table, c = (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as { name: string }[]).map((x) => x.name));
    return c;
  };
  const bind = (where: string, clanId: string) => Array.from({ length: (where.match(/\?/g) ?? []).length }, () => clanId);
  const exported = (s: TableSpec) => columns(s.table).filter((c) => !s.exclude?.includes(c));

  return {
    export(clanId: string): Tagged[] {
      const out: Tagged[] = [];
      for (const s of specs) {
        const cols = exported(s);
        const rows = db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM ${s.table} WHERE ${s.where} ORDER BY rowid`).all(...bind(s.where, clanId)) as Record<string, unknown>[];
        for (const r of rows) if (!s.keep || s.keep(r)) out.push({ t: s.table, r });
      }
      return out;
    },
    /** Returns the rows grouped by table, in spec order. */
    validate(clanId: string, raw: unknown[]): Map<string, Record<string, unknown>[]> {
      if (!Array.isArray(raw) || raw.length > MAX_ROWS) throw new Error('Checkpoint section is malformed.');
      const by = new Map<string, Record<string, unknown>[]>(specs.map((s) => [s.table, []]));
      for (const x of raw) {
        const t = (x as Tagged)?.t, r = (x as Tagged)?.r;
        const s = specs.find((y) => y.table === t);
        if (!s || !r || typeof r !== 'object' || Array.isArray(r)) throw new Error('Checkpoint row for an unexpected table.');
        const allowed = exported(s);
        for (const [k, v] of Object.entries(r)) {
          if (!allowed.includes(k)) throw new Error(`Unexpected column ${t}.${k}.`);
          if (v !== null && typeof v !== 'string' && typeof v !== 'number') throw new Error(`Invalid value in ${t}.${k}.`);
        }
        by.get(t)!.push(r);
      }
      for (const s of specs) for (const r of by.get(s.table)!) for (const [col, sc] of Object.entries(s.scope)) {
        const v = r[col];
        const ok = sc === 'clan' ? v === clanId : typeof sc === 'function' ? sc(v, clanId, by) : by.get(sc.table)?.some((p) => p[sc.column] === v);
        if (!ok) throw new Error(`Row outside this CLAN in ${s.table}.${col}.`);
      }
      return by;
    },
    import(clanId: string, raw: unknown[]) {
      const by = this.validate(clanId, raw);
      for (const s of [...specs].reverse()) if (!s.upsertKey) db.prepare(`DELETE FROM ${s.table} WHERE ${s.where}`).run(...bind(s.where, clanId));
      for (const s of specs) for (const r of by.get(s.table)!) {
        const row = { ...r };
        for (const [c, f] of Object.entries(s.fill ?? {})) if (!(c in row)) row[c] = f();
        const cols = Object.keys(row);
        for (const c of cols) if (!columns(s.table).includes(c)) throw new Error('bad column');
        const update = s.upsertKey ? ` ON CONFLICT (${s.upsertKey.join(', ')}) DO UPDATE SET ${Object.keys(r).filter((c) => !s.upsertKey!.includes(c)).map((c) => `"${c}" = excluded."${c}"`).join(', ') || `"${s.upsertKey[0]}" = excluded."${s.upsertKey[0]}"`}` : '';
        db.prepare(`INSERT INTO ${s.table} (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})${update}`).run(...cols.map((c) => row[c]));
      }
    },
  };
}
