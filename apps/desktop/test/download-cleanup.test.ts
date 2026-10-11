import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const paths = vi.hoisted(() => ({ userData: '', downloads: '' }));
vi.mock('electron', () => ({ app: { isPackaged: false, getPath: (name: keyof typeof paths) => paths[name] }, dialog: {}, shell: {} }));
const { StudentFiles } = await import('../src/main/student.ts');
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');

describe('indexed device download cleanup', () => {
  it('removes scoped verified copies and partials while retaining changed, shared, external and other CLAN files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'clan-download-cleanup-')); dirs.push(dir);
    paths.userData = join(dir, 'profile'); paths.downloads = join(dir, 'downloads');
    mkdirSync(paths.userData); const folder = join(paths.downloads, 'CLAN', 'Same title'); mkdirSync(join(folder, '.partial'), { recursive: true });
    const sid = randomUUID(), other = randomUUID(), resourceId = randomUUID();
    const own = join(folder, 'own.txt'), changed = join(folder, 'changed.txt'), shared = join(folder, 'shared.txt'), otherFile = join(folder, 'other.txt'), exported = join(dir, 'exported.txt'), symlink = join(folder, 'link.txt');
    for (const file of [own, shared, otherFile, exported]) writeFileSync(file, 'original');
    writeFileSync(changed, 'edited by student'); symlinkSync(exported, symlink);
    const part = join(folder, '.partial', `${resourceId}.part`), meta = join(folder, '.partial', `${resourceId}.json`);
    writeFileSync(part, 'partial'); writeFileSync(meta, '{}');
    const entry = (path: string) => ({ path, sha256: hash('original') });
    writeFileSync(join(paths.userData, 'downloads.json'), JSON.stringify({
      [`${sid}:own`]: entry(own), [`${sid}:changed`]: entry(changed), [`${sid}:shared`]: entry(shared),
      [`${other}:shared`]: entry(shared), [`${other}:other`]: entry(otherFile), [`${sid}:export`]: entry(exported), [`${sid}:link`]: entry(symlink),
    }));
    writeFileSync(join(paths.userData, 'download-copies.json'), JSON.stringify({ [`${sid}:${resourceId}`]: { sessionId: sid, resourceId, dir: folder } }));
    const files = new StudentFiles(() => undefined, {} as never);
    expect(await files.removeSessionCopies([sid])).toEqual({ removed: 1, retained: 4 });
    expect(existsSync(own)).toBe(false); expect(existsSync(part)).toBe(false); expect(existsSync(meta)).toBe(false);
    for (const file of [changed, shared, otherFile, exported, symlink]) expect(existsSync(file)).toBe(true);
    expect(readFileSync(changed, 'utf8')).toBe('edited by student');
    const index = JSON.parse(readFileSync(join(paths.userData, 'downloads.json'), 'utf8'));
    expect(index[`${sid}:own`]).toBeUndefined(); expect(index[`${other}:other`]).toEqual(entry(otherFile));
    expect(JSON.parse(readFileSync(join(paths.userData, 'download-copies.json'), 'utf8'))).toEqual({});
    expect(await files.removeSessionCopies([sid])).toEqual({ removed: 0, retained: 4 });
  });
});
