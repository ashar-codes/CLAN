// Type-only stand-in for `node:sqlite` when typechecking core for the phone: the subset src/core/sqlite.ts provides.
type Param = string | number | null | Uint8Array;
export type DatabaseSync = {
  exec(sql: string): void;
  prepare(sql: string): { get(...p: Param[]): any; all(...p: Param[]): any[]; run(...p: Param[]): { changes: number; lastInsertRowid: number } };
};
