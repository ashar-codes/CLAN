// Module boundaries, enforced on the source: modules import only core and other modules' public index.ts; SQL in a
// module touches only its own tables (plus documented, read-only classroom readers); UI packages never import the backend.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dirname, '../../..');
const src = join(import.meta.dirname, '../src');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : /\.tsx?$/.test(e.name) ? [join(d, e.name)] : []));
const imports = (f: string) => [...readFileSync(f, 'utf8').matchAll(/(?:from|import)\s*\(?\s*'([^']+)'/g)].map((m) => m[1]!);
const PREFIX: Record<string, string[]> = { clans: ['clans_'], files: ['resources_'], notes: ['notes_'], saved: ['saved_'], diary: ['diary_'], reminders: ['reminders_'], share: [], chat: ['chat_'], capture: ['capture_'], notifications: ['notify_'],
  courses: ['courses_'], tasks: ['tasks_'], exams: ['exams_'], flashcards: ['flashcards_'], study: ['study_'], assignments: ['assign_'], agenda: [], ai: ['ai_'], whiteboard: ['wb_'], recordings: ['rec_'], sync: ['sync_'] };
/** Read-only classroom readers (see their headers). */
const LEGACY_READERS: Record<string, string[]> = { 'modules/clans/classroom-import.ts': ['sessions', 'members'], 'modules/files/classroom-adopt.ts': ['resources'], 'modules/assignments/classroom-read.ts': ['assignments', 'submissions'] };

describe('module boundaries', () => {
  it('core never imports modules', () => {
    for (const f of walk(join(src, 'core'))) expect(imports(f).filter((i) => i.includes('modules/')), relative(src, f)).toEqual([]);
  });

  it('modules import other modules only through their public index.ts', () => {
    for (const f of walk(join(src, 'modules'))) {
      const mod = relative(join(src, 'modules'), f).split('/')[0]!;
      for (const i of imports(f)) {
        if (!i.startsWith('.')) { expect(['zod', 'node:crypto', 'node:path', 'node:fs/promises', '@classroom/protocol', 'pdfjs-dist/legacy/build/pdf.mjs'], `${relative(src, f)} → ${i}`).toContain(i); continue; }
        const target = relative(src, join(f, '..', i));
        if (target.startsWith('core/')) continue;
        const [, other, file] = target.split('/');
        if (other === mod || target === 'modules/contracts.ts' || f.endsWith('contracts.ts')) continue;
        expect(file, `${relative(src, f)} reaches into ${target}`).toBe('index.ts');
      }
    }
  });

  it('modules touch only their own tables; legacy classroom tables only in the read-only readers', () => {
    for (const f of walk(join(src, 'modules'))) {
      const rel = relative(src, f), mod = rel.split('/')[1]!;
      const text = readFileSync(f, 'utf8');
      const tables = [...text.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|TABLE|EXISTS \(SELECT 1 FROM)\s+([a-z_]+)/g)].map((m) => m[1]!).filter((t) => !['json_each', 'excluded', 'pragma_table_info'].includes(t));
      const allowed = [...(PREFIX[mod] ?? []), ...(LEGACY_READERS[rel] ?? [])];
      for (const t of tables) expect(allowed.some((a) => t === a || t.startsWith(a)), `${rel} uses table ${t}`).toBe(true);
      if (LEGACY_READERS[rel]) expect(text, rel).not.toMatch(/\b(INSERT INTO|UPDATE|DELETE FROM)\s+(sessions|members|resources|assignments|submissions)\b/);
    }
  });

  it('UI packages never import backend or CLAN internals', () => {
    for (const dir of ['packages/design/src', 'packages/world/src', 'apps/visual-lab/src'])
      for (const f of walk(join(root, dir))) for (const i of imports(f)) expect(i, relative(root, f)).not.toMatch(/@classroom\/(server|client)|@clan\/core|node:/);
  });

  it('the desktop renderer reaches CLAN only through the preload API', () => {
    for (const f of walk(join(root, 'apps/desktop/src/renderer'))) for (const i of imports(f)) expect(i, relative(root, f)).not.toMatch(/@clan\/core|@classroom\/server|node:sqlite/);
  });
});
