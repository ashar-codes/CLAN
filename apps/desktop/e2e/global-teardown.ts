// A timed-out test can leave its Electron app running (app.close() hangs), loading the machine for every later run.
// After the suite, stop any app that Playwright launched (they carry Playwright's loader; dev instances don't).
import { execFileSync } from 'node:child_process';
export default () => () => { try { execFileSync('pkill', ['-f', 'playwright-core/lib/server/electron/loader.js']); } catch { /* none left */ } };
