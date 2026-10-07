import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '@classroom/server';
import { openClan } from '../src/index.ts';

export const tmp = () => mkdtempSync(join(tmpdir(), 'clan-'));
/** A device database exactly as the classroom app creates it (legacy migrations 1–4), then CLAN on top. */
export function setup(o: { db?: ReturnType<typeof openDb>; storageDir?: string; now?: () => number } = {}) {
  const db = o.db ?? openDb(':memory:');
  const storageDir = o.storageDir ?? tmp();
  return { app: openClan(db, { storageDir, now: o.now }), db, storageDir };
}
export const user = (userId: string) => ({ kind: 'user' as const, userId });
export const file = (dir: string, name: string, content: string) => { const p = join(dir, name); writeFileSync(p, content); return p; };
