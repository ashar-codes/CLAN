// Stop only orphaned Electron apps launched for this E2E project. Other Playwright sessions belong to their owners.
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appDir = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const fixture = `${appDir}/e2e/fixtures/bridge-host.cjs`;

export default () => () => {
  if (process.platform !== 'darwin') return; // no safe cross-platform owner check here
  let rows = '';
  try { rows = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }); } catch { return; }
  for (const line of rows.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || !match[2]!.includes('Electron.app/Contents/MacOS/Electron') || !match[2]!.includes('playwright-core/lib/server/electron/loader.js')) continue;
    const pid = Number(match[1]);
    try {
      const cwd = execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' });
      if (cwd.split('\n').includes(`n${appDir}`) || match[2]!.includes(fixture)) process.kill(pid, 'SIGTERM');
    } catch { /* process exited or ownership could not be established */ }
  }
};
