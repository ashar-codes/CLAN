// Manual cross-device QA helper (not part of the suite): launches this desktop build on a DISPOSABLE profile and
// exposes POST http://127.0.0.1:<port>/eval {code} → page.evaluate for scripted steps against a phone/emulator.
import { _electron as electron } from 'playwright-core';
import { createServer } from 'node:http';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const profile = process.env.CLASSROOM_USER_DATA;
if (!profile || !/tmp|scratchpad|T\//.test(profile)) throw new Error('Set CLASSROOM_USER_DATA to a disposable directory.');
if (!existsSync(join(profile, 'profile.json'))) writeFileSync(join(profile, 'profile.json'), JSON.stringify({ fullName: process.env.NAME ?? 'Desk Tester', rollNo: '', deviceName: process.env.DEVICE ?? 'QA MacBook' }));
const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env } });
const page = await app.firstWindow();
createServer((req, res) => {
  let body = ''; req.on('data', (c) => { body += c; });
  req.on('end', async () => {
    try { const out = await page.evaluate(`(async () => { ${JSON.parse(body).code} })()`); res.end(JSON.stringify(out ?? null)); }
    catch (e) { res.statusCode = 500; res.end(String(e)); }
  });
}).listen(Number(process.env.PORT ?? 7788), '127.0.0.1', () => console.log('driver ready'));
