// Knowledge-index benchmark: indexing time, index size and retrieval latency for a synthetic course
// (N text PDFs of P pages + notes), using the real @clan/core index (PDF.js extraction, FTS5) and no AI provider.
// Usage: node tools/sim/bench-ai.ts [--pdfs 40] [--pages 20]
import { mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { openDb } from '@classroom/server';
import { openClan } from '../../packages/clan/src/index.ts';
import { makePdf } from '../../packages/clan/test/fixtures/pdf.ts';

const { values } = parseArgs({ options: { pdfs: { type: 'string', default: '40' }, pages: { type: 'string', default: '20' } } });
const N = Number(values.pdfs), P = Number(values.pages);
const dir = mkdtempSync(join(tmpdir(), 'bench-ai-')), dbPath = join(dir, 'clan.db');
const app = openClan(openDb(dbPath), { storageDir: dir });
const me = { kind: 'user' as const, userId: app.me };
const course = app.courses.create(me, { name: 'Bench course' });
const words = 'process thread deadlock semaphore mutex paging segment cache scheduler interrupt kernel syscall inode journal socket'.split(' ');
const para = (i: number, j: number) => Array.from({ length: 30 }, (_, k) => words[(i * 7 + j * 3 + k) % words.length]).join(' ') + `. Lecture ${i} page ${j} detail ${i * 100 + j}.`;
for (let i = 0; i < N; i++) {
  const p = join(dir, `L${i}.pdf`); writeFileSync(p, makePdf(Array.from({ length: P }, (_, j) => `${para(i, j)}\n${para(i, j + 1)}`)));
  const f = await app.files.add(me, p, `Lecture ${i}.pdf`, { kind: 'personal', ownerId: app.me }, 'application/pdf');
  app.courses.link(me, course.id, { module: 'files', entityId: f.refId });
}
for (let i = 0; i < 100; i++) app.courses.link(me, course.id, { module: 'notes', entityId: app.notes.create(me, { title: `Note ${i}`, body: para(i, 99) }).id });
const scope = { kind: 'course' as const, courseId: course.id };
let t = performance.now(); await app.ai.search(me, 'deadlock semaphore', scope); const first = performance.now() - t;
t = performance.now(); await app.ai.search(me, 'deadlock semaphore', scope); const warm = performance.now() - t;
const lat: number[] = [];
for (const q of ['paging cache', 'kernel interrupt', 'detail 1505', 'mutex scheduler journal', 'socket inode']) { t = performance.now(); await app.ai.search(me, q, scope); lat.push(performance.now() - t); }
const size = app.ai.index.size();
console.log(JSON.stringify({ pdfs: N, pagesEach: P, notes: 100, firstIndexAndQueryMs: Math.round(first), indexMs: Math.round(app.ai.index.stats.indexMs), sources: size.sources, chunks: size.chunks,
  indexedChars: size.chars, dbBytes: statSync(dbPath).size, warmQueryMs: Math.round(warm), queryMsP50: Math.round(lat.sort((a, b) => a - b)[2]!), queryMsMax: Math.round(lat.at(-1)!) }, null, 1));
