import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@classroom/server';
import { openClan } from '../src/index.ts';

// Use the existing suite teardown registry. In-memory databases otherwise leave their object stores on disk.
export const tmp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'clan-'));
  const dirs = ((globalThis as { __classroomTmpDirs?: string[] }).__classroomTmpDirs ??= []);
  dirs.push(dir);
  writeFileSync(join(dir, '.clan-disposable-test.json'), JSON.stringify({ purpose: 'clan-vitest', pid: process.pid, dir }));
  return dir;
};
/** A device database exactly as the classroom app creates it (legacy migrations 1–4), then CLAN on top. */
export function setup(o: { db?: ReturnType<typeof openDb>; storageDir?: string; now?: () => number; aiProvider?: Parameters<typeof openClan>[1]['aiProvider'] } = {}) {
  const db = o.db ?? openDb(':memory:');
  const storageDir = o.storageDir ?? tmp();
  return { app: openClan(db, { storageDir, now: o.now, aiProvider: o.aiProvider }), db, storageDir };
}
export const user = (userId: string) => ({ kind: 'user' as const, userId });
export const file = (dir: string, name: string, content: string) => { const p = join(dir, name); writeFileSync(p, content); return p; };
