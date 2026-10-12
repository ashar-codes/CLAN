import { _electron as electron, type ElectronApplication } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
const profile = mkdtempSync(join(tmpdir(), 'clan-btc2a-directory-ui-'));
let app: ElectronApplication | null = null;
afterAll(async () => { await app?.close(); rmSync(profile,{recursive:true,force:true}); });
it('directory opt-in rejects public destinations and supports explicit disable through real IPC', async () => {
  app = await electron.launch({args:['.'],cwd:join(import.meta.dirname,'..'),env:{...process.env,CLASSROOM_USER_DATA:profile}});
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  await page.evaluate(() => (window as unknown as {classroom:{saveProfile(p:object):Promise<unknown>}}).classroom.saveProfile({fullName:'Directory QA',rollNo:'QA',deviceName:'Disposable'}));
  await page.getByRole('navigation',{name:'Main'}).getByRole('button',{name:/Nearby/}).click();
  const directory = page.locator('[aria-label="Internal network directory"]');
  await directory.getByLabel('LAN directory configuration').fill(JSON.stringify({url:'https://8.8.8.8:443',certificate:'A'.repeat(64),spkiSha256:'B'.repeat(44)}));
  await directory.getByRole('button',{name:'Enable internal directory'}).click();
  await page.getByRole('alert').getByText(/internal IP address/).waitFor();
  const invalidCertificate = await page.evaluate(async () => {
    const api = (window as unknown as {classroom:{people:{directory(v?:unknown):Promise<{config:unknown}>}}}).classroom.people;
    let rejected = false;
    try { await api.directory({url:'https://10.0.0.1:7443',certificate:'A'.repeat(64),spkiSha256:'B'.repeat(44)}); } catch { rejected = true; }
    return { rejected, config:(await api.directory()).config };
  });
  expect(invalidCertificate).toEqual({rejected:true,config:null});
  await directory.getByRole('button',{name:'Disable directory'}).click();
  await page.getByText('Directory disabled; registration expires within 90 seconds.',{exact:true}).waitFor();
  expect(await directory.getByText('LAN directory disabled.',{exact:true}).isVisible()).toBe(true);
},60000);
