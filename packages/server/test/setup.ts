import { afterAll } from 'vitest';
import { rmSync } from 'node:fs';

afterAll(() => {
  const dirs = (globalThis as { __classroomTmpDirs?: string[] }).__classroomTmpDirs ?? [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
