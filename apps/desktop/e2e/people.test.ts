// Nearby people, friends, personal chats, files, voice notes and a real audio call between two app instances (two
// disposable profiles) through the UI. Chromium's fake capture device stands in for a microphone/camera; the permission
// gate in the main process is the real one. Media must actually flow (RTP bytes counted by WebRTC stats).
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const profiles = [mkdtempSync(join(tmpdir(), 'clan-ppl-a-')), mkdtempSync(join(tmpdir(), 'clan-ppl-b-'))];
const work = mkdtempSync(join(tmpdir(), 'clan-ppl-files-'));
const apps = new Map<string, ElectronApplication>();
afterAll(async () => { for (const a of apps.values()) await a.close().catch(() => {}); for (const p of [...profiles, work]) rmSync(p, { recursive: true, force: true }); });

async function launch(profile: string, device: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: ['.', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, CLASSROOM_USER_DATA: profile, CLAN_TEST_LOOPBACK: '1' },
  });
  apps.set(profile, app);
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  if (process.env.DEBUG_E2E) page.on('pageerror', (e) => process.stderr.write(`[renderer] ${e.stack}\n`));
  await page.evaluate((n) => (window as unknown as { classroom: { saveProfile(p: object): Promise<unknown> } }).classroom.saveProfile({ fullName: n, rollNo: 'FA23-001', deviceName: n }), device);
  return { app, page };
}
const tab = (p: Page, name: string) => p.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^.?${name}`) }).click();
/** Native file dialogs cannot be driven; answer them from the main process like the person would. */
const answerDialogs = (app: ElectronApplication, open: string, save: string) => app.evaluate(({ dialog }, [o, s]) => {
  dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [o] })) as never;
  dialog.showSaveDialog = (async () => ({ canceled: false, filePath: s })) as never;
}, [open, save]);

let A: { app: ElectronApplication; page: Page }, B: { app: ElectronApplication; page: Page };

it('profiles, QR first contact (picture scan), friend request and acceptance', async () => {
  A = await launch(profiles[0]!, 'Aisha Khan'); B = await launch(profiles[1]!, 'Bilal Ahmed');
  // A fills in a profile field visible to everyone; B keeps defaults
  await tab(A.page, 'Friends');
  const prof = A.page.getByRole('region', { name: 'Your profile' });
  await prof.getByLabel('Name').fill('Aisha Khan');
  await prof.getByLabel('University').fill('FAST Lahore');
  await prof.getByLabel('Shown to').first().selectOption('everyone');
  await prof.getByRole('button', { name: 'Save profile' }).click();
  await prof.getByText('Profile saved.').waitFor();

  // A shows its code; B scans a picture of it
  await tab(A.page, 'Nearby');
  await A.page.getByRole('button', { name: 'Show my code' }).click();
  const png = await A.page.getByAltText('Your CLAN profile code').getAttribute('src');
  const qrFile = join(work, 'aisha-qr.png'); writeFileSync(qrFile, Buffer.from(png!.split(',')[1]!, 'base64'));
  await tab(B.page, 'Nearby');
  await B.page.locator('input[type=file][accept="image/*"]').setInputFiles(qrFile);
  await B.page.getByText('Connected to Aisha Khan. Their identity matched the code.').waitFor({ timeout: 20_000 });
  const card = B.page.getByRole('list', { name: 'Connected by code' }).getByRole('listitem', { name: 'Aisha Khan' });
  await card.getByText('✓ verified').waitFor();
  await card.getByText('FAST Lahore').waitFor(); // the field she shares with everyone
  await card.getByRole('button', { name: 'Add friend' }).click();

  // A gets the request (badge on Friends) and accepts
  await A.page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Friends.*1 new/ }).waitFor({ timeout: 20_000 });
  await tab(A.page, 'Friends');
  await A.page.getByRole('region', { name: 'Friend requests' }).getByRole('button', { name: 'Accept' }).click();
  await A.page.getByRole('region', { name: 'Friends list' }).getByText('Bilal Ahmed').waitFor();
  await tab(B.page, 'Friends');
  await B.page.getByRole('region', { name: 'Friends list' }).getByText('Aisha Khan').waitFor({ timeout: 20_000 });
  // safety number is the same on both sides
  await B.page.getByRole('button', { name: 'Open Aisha Khan' }).click();
  const snB = await B.page.getByRole('region', { name: 'Profile of Aisha Khan' }).locator('.mono').textContent();
  await A.page.getByRole('button', { name: 'Open Bilal Ahmed' }).click();
  const snA = await A.page.getByRole('region', { name: 'Profile of Bilal Ahmed' }).locator('.mono').textContent();
  expect(snA).toBe(snB); expect(snA).toMatch(/\d{5}/);
}, 120_000);

it('permanent chat: delivery, read receipts, file with consent and verification, voice note', async () => {
  await B.page.getByRole('region', { name: 'Profile of Aisha Khan' }).getByRole('button', { name: 'Chat' }).click();
  const chatB = B.page.getByRole('region', { name: 'Chat with Aisha Khan' });
  await chatB.getByLabel('Message', { exact: true }).fill('Hello Aisha');
  await chatB.getByLabel('Message', { exact: true }).press('Enter');
  await tab(A.page, 'Chats');
  await A.page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /Bilal Ahmed/ }).click({ timeout: 20_000 });
  const chatA = A.page.getByRole('region', { name: 'Chat with Bilal Ahmed' });
  await chatA.getByText('Hello Aisha').waitFor({ timeout: 20_000 });
  await chatB.getByText(/✓✓ Read/).waitFor({ timeout: 20_000 });

  // reply, react, edit and delete for everyone: author-only, signed, applied on the other device
  const text = (chat: typeof chatA, t: string) => chat.locator('.msg-text', { hasText: new RegExp(`^${t}$`) });
  const bubble = (chat: typeof chatA, t: string) => chat.locator('.msg', { has: chat.page().locator('.msg-text', { hasText: new RegExp(`^${t}$`) }) });
  await chatB.getByLabel('Message', { exact: true }).fill('Edit me please');
  await chatB.getByLabel('Message', { exact: true }).press('Enter');
  await text(chatA, 'Edit me please').click({ button: 'right', timeout: 20_000 });
  await chatA.getByRole('menuitem', { name: 'React 👍' }).click();
  await bubble(chatB, 'Edit me please').locator('.msg-reactions', { hasText: '👍' }).waitFor({ timeout: 20_000 });
  await text(chatA, 'Edit me please').click({ button: 'right' });
  expect(await chatA.getByRole('menuitem', { name: '✎ Edit' }).count()).toBe(0); // not A's message
  expect(await chatA.getByRole('menuitem', { name: '⊘ Delete for everyone' }).count()).toBe(0);
  await chatA.getByRole('menuitem', { name: '↩ Reply' }).click();
  await chatA.getByLabel('Message', { exact: true }).fill('Reply from Aisha');
  await chatA.getByLabel('Message', { exact: true }).press('Enter');
  await bubble(chatB, 'Reply from Aisha').locator('.msg-reply', { hasText: 'Edit me please' }).waitFor({ timeout: 20_000 });
  await text(chatB, 'Edit me please').click({ button: 'right' });
  await chatB.getByRole('menuitem', { name: '✎ Edit' }).click();
  await chatB.getByLabel('Message', { exact: true }).fill('Edited by Bilal');
  await chatB.getByRole('button', { name: 'Save' }).click();
  await bubble(chatA, 'Edited by Bilal').getByText(/Edited ·/).waitFor({ timeout: 20_000 });
  B.page.once('dialog', (d) => void d.accept());
  await text(chatB, 'Edited by Bilal').click({ button: 'right' });
  await chatB.getByRole('menuitem', { name: '⊘ Delete for everyone' }).click();
  await chatA.getByText('This message was deleted').waitFor({ timeout: 20_000 });
  await chatB.getByText('You deleted this message').waitFor();
  await bubble(chatA, 'Reply from Aisha').locator('.msg-reply', { hasText: 'Message deleted' }).waitFor();
  expect(await text(chatA, 'Edited by Bilal').count()).toBe(0);

  // B sends a file; nothing moves until A accepts; A previews and saves a verified copy
  const src = join(work, 'notes.txt'), saved = join(work, 'saved-notes.txt');
  writeFileSync(src, 'Lecture 7: transport layer\n'.repeat(2000));
  await answerDialogs(B.app, src, join(work, 'unused'));
  await answerDialogs(A.app, join(work, 'unused'), saved);
  await chatB.getByRole('button', { name: 'Send a file' }).click();
  const fileA = chatA.getByLabel('File notes.txt');
  await fileA.getByRole('button', { name: /^Accept/ }).click({ timeout: 20_000 });
  await fileA.getByText(/Verified/).waitFor({ timeout: 30_000 });
  await fileA.getByRole('button', { name: 'Preview' }).click();
  await fileA.getByText(/Lecture 7: transport layer/).first().waitFor();
  await fileA.getByRole('button', { name: 'Save a copy' }).click();
  await expect.poll(() => { try { return readFileSync(saved, 'utf8') === readFileSync(src, 'utf8'); } catch { return false; } }, { timeout: 10_000 }).toBe(true);
  await chatB.getByLabel('File notes.txt').getByText(/Verified/).waitFor({ timeout: 20_000 }); // the receiver's signed receipt reached the sender

  // B records a voice note from the (fake) microphone, listens back, sends; A accepts and plays it
  await B.app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0]?.focus(); });
  await B.page.bringToFront();
  await chatB.getByRole('button', { name: 'Record a voice message' }).click();
  await chatB.getByText(/0:0[1-9]/).waitFor({ timeout: 10_000 });
  await chatB.getByRole('button', { name: 'Stop' }).click();
  await chatB.getByLabel('Listen before sending').waitFor();
  await chatB.getByRole('button', { name: 'Send voice' }).click();
  const voiceA = chatA.getByLabel('Voice message', { exact: true }).last();
  await A.app.evaluate(({ app, BrowserWindow }) => { app.focus({ steal: true }); BrowserWindow.getAllWindows()[0]?.focus(); });
  await A.page.bringToFront();
  // voice notes inside an accepted chat download by themselves (≤ 10 MB, verified like any file)
  await voiceA.getByRole('button', { name: 'Play' }).click({ timeout: 30_000 });
  await voiceA.getByRole('button', { name: 'Pause' }).waitFor();
}, 150_000);

it('audio call: ringing, answer, encrypted audio flows both ways, hang up is logged', async () => {
  const chatA = A.page.getByRole('region', { name: 'Chat with Bilal Ahmed' });
  await chatA.getByRole('button', { name: 'Voice call Bilal Ahmed' }).click();
  const ring = B.page.getByRole('alertdialog', { name: /Incoming call: Aisha Khan/ });
  await ring.getByRole('button', { name: 'Answer' }).click({ timeout: 20_000 });
  const panelA = A.page.locator('.call-panel'), panelB = B.page.locator('.call-panel');
  await panelA.getByText(/In call/).waitFor({ timeout: 30_000 });
  await panelB.getByText(/In call/).waitFor({ timeout: 30_000 });
  await expect.poll(async () => Number(await panelA.getAttribute('data-rx')), { timeout: 15_000 }).toBeGreaterThan(1000);
  await expect.poll(async () => Number(await panelB.getAttribute('data-rx')), { timeout: 15_000 }).toBeGreaterThan(1000);
  await panelA.getByText('Receiving audio · encrypted, on this network').waitFor();
  await panelA.getByRole('button', { name: 'Hang up' }).click();
  await panelB.getByText(/Call ended/).waitFor({ timeout: 15_000 });
  await chatA.getByText(/^Call · \d+:\d\d/).waitFor({ timeout: 10_000 });
}, 120_000);

it('video call: real decoded frames and audio, camera toggles, upgrade, hangup releases tracks',async()=>{
  const chat=A.page.getByRole('region',{name:'Chat with Bilal Ahmed'});
  await chat.getByRole('button',{name:'Video call Bilal Ahmed'}).click();
  await B.page.getByRole('alertdialog',{name:/Incoming call:/}).getByRole('button',{name:'Answer'}).click();
  const pa=A.page.locator('.call-panel'),pb=B.page.locator('.call-panel');
  await expect.poll(async()=>Number(await pa.getAttribute('data-video-rx')),{timeout:20000}).toBeGreaterThan(1000);
  await expect.poll(async()=>Number(await pb.getAttribute('data-video-rx')),{timeout:20000}).toBeGreaterThan(1000);
  for(const p of [A.page,B.page]){
    await p.bringToFront();
    const counts=await p.getByLabel('Remote video',{exact:true}).evaluate(async(node)=>{const v=node as HTMLVideoElement;let frames=0;const end=Date.now()+2000;while(Date.now()<end){await new Promise<void>(resolve=>{const timeout=setTimeout(resolve,500);v.requestVideoFrameCallback(()=>{clearTimeout(timeout);frames++;resolve();});});}return {frames,width:v.videoWidth,height:v.videoHeight};});
    expect(counts.frames).toBeGreaterThan(10);expect(counts.width).toBeGreaterThan(0);
  }
  await pa.getByRole('button',{name:'Camera off',exact:true}).click();await pa.getByRole('button',{name:'Camera on',exact:true}).waitFor();
  await pa.getByRole('button',{name:'Camera on',exact:true}).click();await pa.getByRole('button',{name:'Camera off',exact:true}).waitFor();
  await pa.getByRole('button',{name:'Hang up'}).click();await pb.getByText(/Call ended/).waitFor();
  expect(await pa.getByLabel('Local video',{exact:true}).evaluate(v=>(v as HTMLVideoElement).srcObject)).toBeNull();
},90000);

it('audio-only calls upgrade to video with explicit camera consent and keep the original call',async()=>{
  await A.page.getByRole('region',{name:'Chat with Bilal Ahmed'}).getByRole('button',{name:'Voice call Bilal Ahmed'}).click();
  await B.page.getByRole('alertdialog',{name:/Incoming call:/}).getByRole('button',{name:'Answer'}).click();
  const a=A.page.locator('.call-panel'),b=B.page.locator('.call-panel');await a.getByRole('button',{name:'Camera on',exact:true}).waitFor();
  await a.getByRole('button',{name:'Camera on',exact:true}).click();await expect.poll(async()=>Number(await b.getAttribute('data-video-rx')),{timeout:15000}).toBeGreaterThan(1000);
  await b.getByRole('button',{name:'Camera on',exact:true}).click();await expect.poll(async()=>Number(await a.getAttribute('data-video-rx')),{timeout:15000}).toBeGreaterThan(1000);
  await a.getByRole('button',{name:'Camera off',exact:true}).click();await expect.poll(()=>a.getAttribute('data-phase')).toBe('connected');
  await a.getByRole('button',{name:'Hang up'}).click();await b.getByText(/Call ended/).waitFor();
},60000);

it('temporary chat terms need acceptance; queued messages reach a restarted app; history survives restart', async () => {
  const chatA = A.page.getByRole('region', { name: 'Chat with Bilal Ahmed' });
  await chatA.getByRole('button', { name: 'Chat options', exact: true }).click();
  await chatA.getByRole('button', { name: 'Change terms…' }).click();
  await chatA.getByLabel(/Temporary — messages and files disappear after 1 hour/).check();
  await chatA.getByRole('button', { name: 'Send invitation' }).click();
  await chatA.getByText(/Waiting for Bilal Ahmed to accept/).waitFor();
  const chatB = B.page.getByRole('region', { name: 'Chat with Aisha Khan' });
  const inv = chatB.getByRole('group', { name: 'Chat invitation' });
  await inv.getByText(/temporary/).waitFor({ timeout: 20_000 });
  await inv.getByRole('button', { name: 'Accept' }).click();
  await chatA.getByText('Disappears after 1 hour').first().waitFor({ timeout: 20_000 });
  await chatA.getByLabel('Message', { exact: true }).fill('This one disappears');
  await chatA.getByLabel('Message', { exact: true }).press('Enter');
  await chatB.getByText('This one disappears').waitFor({ timeout: 20_000 });
  await chatB.getByText(/disappears in (59|60) min/).first().waitFor();

  // B quits; A's next message waits in the queue; B restarts (same identity, same port) and receives it
  await B.app.close(); apps.delete(profiles[1]!);
  await chatA.getByLabel('Message', { exact: true }).fill('Sent while you were away');
  await chatA.getByLabel('Message', { exact: true }).press('Enter');
  await chatA.getByText('Sent while you were away').waitFor();
  B = await launch(profiles[1]!, 'Bilal Ahmed');
  await tab(B.page, 'Chats');
  await B.page.getByRole('navigation', { name: 'Conversations' }).getByRole('button', { name: /Aisha Khan/ }).click();
  const chatB2 = B.page.getByRole('region', { name: 'Chat with Aisha Khan' });
  await chatB2.getByText('Sent while you were away').waitFor({ timeout: 45_000 });
  await chatB2.getByText('Hello Aisha').waitFor(); // earlier saved history is still there
  await chatB2.getByText('This one disappears').waitFor();
  await chatA.locator('.msg', { hasText: 'Sent while you were away' }).getByText(/Delivered|Read/).waitFor({ timeout: 20_000 });

  // clearing is local and says so
  await chatB2.getByRole('button', { name: 'Chat options', exact: true }).click();
  await chatB2.getByRole('button', { name: 'Clear history' }).click();
  await chatB2.getByText(/Aisha Khan keeps their own copy/).waitFor();
  await chatB2.getByRole('alertdialog').getByRole('button', { name: 'Clear history' }).click();
  await expect.poll(() => chatB2.locator('.msg').count()).toBe(0);
  await chatA.getByText('Hello Aisha').waitFor(); // A's copy is untouched
}, 180_000);

it('visibility: Everyone Nearby is discovered automatically; Invisible disappears; blocking stops contact', async () => {
  await tab(A.page, 'Nearby');
  await A.page.getByRole('button', { name: 'Everyone nearby', exact: true }).click();
  await A.page.getByText(/You are visible to everyone nearby/).waitFor();
  await tab(B.page, 'Nearby');
  // automatic discovery over mDNS (needs multicast on this network); friends are also found in Friends Only
  await B.page.getByRole('list', { name: 'People nearby' }).getByRole('listitem', { name: 'Aisha Khan' }).waitFor({ timeout: 45_000 });
  await A.page.getByRole('button', { name: 'Invisible' }).click();
  await A.page.getByText(/You are invisible/).first().waitFor();
  await B.page.getByRole('list', { name: 'People nearby' }).getByRole('listitem', { name: 'Aisha Khan' }).waitFor({ state: 'detached', timeout: 60_000 });

  // B blocks A: A's messages are refused
  await A.page.getByRole('button', { name: 'Friends only' }).click();
  await tab(B.page, 'Friends');
  await B.page.getByRole('button', { name: 'Open Aisha Khan' }).click();
  await B.page.getByRole('region', { name: 'Profile of Aisha Khan' }).getByRole('button', { name: 'Block' }).click();
  await B.page.getByRole('alertdialog').getByRole('button', { name: 'Block' }).click();
  await B.page.getByRole('region', { name: 'Blocked people' }).getByText('Aisha Khan').waitFor();
  await tab(A.page, 'Chats');
  const chatA = A.page.getByRole('region', { name: 'Chat with Bilal Ahmed' });
  await chatA.getByLabel('Message', { exact: true }).fill('Can you see this?');
  await chatA.getByLabel('Message', { exact: true }).press('Enter');
  const refused = chatA.locator('.msg', { hasText: 'Can you see this?' });
  await refused.locator('.msg-meta').filter({ hasText: /⚠ Failed/ }).waitFor({ timeout: 30_000 });
  expect(await refused.getAttribute('data-state')).toBe('failed');
}, 180_000);
