// Screen sharing E2E: real Electron apps, real local SFU, real WebRTC. The presenter uses the TEST-ONLY pattern source
// (CLAN_TEST_CAPTURE=1, development builds only) so the viewer can prove it receives *changing* frames.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [];
const owners = new Map<Page, ElectronApplication>();
const dirs: string[] = [];
afterAll(async () => { await Promise.all(apps.map((a) => a.close().catch(() => {}))); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
async function launch() {
  const userData = mkdtempSync(join(tmpdir(), 'clan-')); dirs.push(userData);
  const app = await electron.launch({ args: ['.','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: userData, CLAN_TEST_CAPTURE: '1' } });
  apps.push(app);
  if (process.env.DEBUG_E2E) app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`));
  await app.evaluate(({BrowserWindow},x)=>BrowserWindow.getAllWindows()[0]?.setBounds({x,y:0,width:500,height:720}), (apps.length-1)*510);
  const page = await app.firstWindow();
  owners.set(page, app);
  await page.waitForLoadState('domcontentloaded');
  page.on('dialog', (d) => d.accept());
  return page;
}
async function hostClan(p: Page, type: 'Classroom' | 'Study group', name: string) {
  await p.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await p.getByRole('button', { name: 'Create CLAN' }).click();
  await p.getByRole('radio', { name: type, exact: true }).click();
  await p.getByLabel(type === 'Classroom' ? 'Class name' : 'Name', { exact: true }).fill(name);
  await p.getByRole('button', { name: type === 'Classroom' ? 'Start Classroom' : 'Start CLAN' }).click();
  return (await p.getByLabel('Join code').textContent())!.replace(/\D/g, '');
}
async function joinClan(p: Page, name: string, code: string, host: Page) {
  await p.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await p.getByRole('button', { name: 'Join by Code' }).click();
  await p.getByLabel('Full name').fill(name); await p.getByLabel('Student / roll number').fill(`R-${name}`); await p.getByLabel('Device name').fill(`${name}-Mac`);
  await p.getByRole('button', { name: 'Save' }).click();
  await p.locator('.code-input').fill(code); await p.getByRole('button', { name: 'Join', exact: true }).click();
  try { await host.getByRole('button', { name: 'Approve', exact: true }).click({ timeout: 25_000 }); }
  catch (error) {
    console.error('Bounded join failure', { fixtureMember: name, approvalButtons: await host.getByRole('button', { name: 'Approve', exact: true }).count(), authenticatedPendingScreen: await p.getByText(/Waiting for .* to let you in/).count(), joinErrors: await p.locator('.error').count(), stillJoining: await p.getByRole('button', { name: 'Joining…', exact: true }).count(), noReachableHint: await p.locator('.error').filter({ hasText: /No classrooms found|Could not reach|No additional reachable/ }).count(), badCode: await p.locator('.error').filter({ hasText: /No CLAN matches/ }).count(), hostWaitingSection: await host.getByRole('heading', { name: /Waiting to join/ }).count() });
    throw error;
  }
  await p.getByTestId('secure-state').waitFor({ timeout: 15_000 });
}

async function frameHashes(p:Page,label:string){await p.getByLabel(label,{exact:true}).scrollIntoViewIfNeeded();return p.getByLabel(label,{exact:true}).evaluate(async(node)=>{
 const v=node as HTMLVideoElement,c=Object.assign(document.createElement('canvas'),{width:64,height:48}),g=c.getContext('2d')!,values=new Set<number>();
 for(let f=0;f<7;f++){if(v.videoWidth){g.drawImage(v,0,0,64,48);const bytes=g.getImageData(0,0,64,48).data;let hash=0;for(let i=0;i<bytes.length;i+=43)hash=(hash*31+bytes[i]!)>>>0;values.add(hash);}await new Promise(r=>setTimeout(r,200));}return values.size;
});}
it('three authenticated UI participants publish video, chat, raise hands and share changing frames; host ends everyone',async()=>{
 const host=await launch(),code=await hostClan(host,'Study group','Meeting UI'),sara=await launch();await joinClan(sara,'Sara',code,host);
 const ali=await launch();await joinClan(ali,'Ali',code,host);
 const h=host.getByRole('region',{name:'CLAN meetings'}),s=sara.getByRole('region',{name:'CLAN meetings'}),a=ali.getByRole('region',{name:'CLAN meetings'});
 await h.getByRole('button',{name:'Start video meeting',exact:true}).click();await h.getByRole('button',{name:'Join video',exact:true}).click();
 for(const name of ['Sara','Ali'])await h.locator('.row').filter({hasText:name}).getByRole('button',{name:'Invite',exact:true}).click();
 await s.getByRole('button',{name:'Join video',exact:true}).click({timeout:15000});await a.getByRole('button',{name:'Join video',exact:true}).click({timeout:15000});
 for(const panel of [h,s,a])await expect.poll(()=>panel.getByRole('article').count(),{timeout:20000}).toBe(3);
 await host.bringToFront();await expect.poll(()=>frameHashes(host,'Video Sara'),{timeout:20000}).toBeGreaterThanOrEqual(3);
 await s.getByRole('button',{name:'Raise hand',exact:true}).click();await h.getByLabel('Raised hands').getByText('Sara raised a hand').waitFor({timeout:10000});
 await s.getByLabel('Meeting message',{exact:true}).fill('Authenticated meeting chat');await s.getByRole('button',{name:'Send meeting message'}).click();await h.getByLabel('Meeting chat').getByText('Authenticated meeting chat',{exact:false}).waitFor({timeout:10000});
 await h.getByRole('button',{name:'Share screen or window'}).click();await h.getByRole('button',{name:'Test pattern (screen)',exact:true}).click();
 await sara.bringToFront();await expect.poll(()=>frameHashes(sara,'Meeting shared screen'),{timeout:20000}).toBeGreaterThanOrEqual(3);
 await h.getByRole('button',{name:'Stop sharing',exact:true}).click();await expect.poll(()=>s.getByLabel('Meeting shared screen',{exact:true}).count()).toBe(0);
 await h.getByRole('button',{name:'End meeting',exact:true}).click();for(const panel of [h,s,a])await expect.poll(()=>panel.getByRole('article').count(),{timeout:15000}).toBe(0);
},180000);
