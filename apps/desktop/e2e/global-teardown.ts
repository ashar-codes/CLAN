// Stop only Electron apps still owned by this E2E runner. A project cwd alone
// cannot distinguish simultaneous runs; reparented/uncertain processes are retained.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appDir = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const fixture = `${appDir}/e2e/fixtures/bridge-host.cjs`;

export function belongsToRun(pid: number, owner: number, parents: ReadonlyMap<number, number>) {
  const seen = new Set<number>();
  for (let n = 0; n < 128 && pid > 1 && !seen.has(pid); n++) {
    if (pid === owner) return true;
    seen.add(pid); pid = parents.get(pid) ?? 0;
  }
  return false;
}

export default () => {
 const owner = process.pid;
 return () => {
  if (process.platform !== 'darwin') return; // no safe cross-platform owner check here
  let rows = '';
  try { rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' }); } catch { return; }
  const parsed = rows.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line)).filter(row => row !== null);
  const parents = new Map(parsed.map(row => [Number(row[1]), Number(row[2])]));
  for (const match of parsed) {
    if (!match[3]!.includes('Electron.app/Contents/MacOS/Electron') || !match[3]!.includes('playwright-core/lib/server/electron/loader.js')) continue;
    const pid = Number(match[1]);
    if (!belongsToRun(pid, owner, parents)) continue;
    try {
      const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
      if (cwd.split('\n').includes(`n${appDir}`) || match[3]!.includes(fixture)) process.kill(pid, 'SIGTERM');
    } catch { /* process exited or ownership could not be established */ }
  }
 };
};
