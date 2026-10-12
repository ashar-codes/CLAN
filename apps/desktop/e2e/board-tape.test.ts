// Whiteboard and Study Tape end to end in real apps (no cloud, deterministic test capture):
// Study Group board: two members draw at once → text/sticky/file card → others receive → leave/rejoin restores →
// host again keeps the board. Classroom: view-only until the host lets students draw.
// Study Tape: Study Session → record test source → ⭐ 📝 📸 🔖 → stop → play → jump → link lecture → restart persists.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'clan-bt-')); dirs.push(scratch);
afterAll(async () => { await Promise.all(apps.map((a) => a.close().catch(() => {}))); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const chooseFiles = (app: ElectronApplication, paths: string[]) => app.evaluate(({ dialog }, ps) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: ps })) as never; }, paths);

async function launch(env: Record<string, string> = {}, userData = mkdtempSync(join(tmpdir(), 'clan-'))) {
  if (!dirs.includes(userData)) dirs.push(userData);
  const exe = process.env.E2E_EXECUTABLE;
  const app = await electron.launch({ ...(exe ? { executablePath: exe, args: [] } : { args: ['.'] }), cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: userData, ...env } });
  apps.push(app);
  if (process.env.DEBUG_E2E) app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  if (process.env.DEBUG_E2E) page.on('pageerror', (e) => process.stderr.write(`[renderer] ${e.stack}\n`));
  page.on('dialog', (d) => void d.accept()); // confirm() prompts (wall switching)
  return { app, page, userData };
}
async function joinByCode(page: Page, name: string, code: string) {
  await page.getByRole('button', { name: 'My CLANs', exact: true }).or(page.locator('.code-input')).first().waitFor();
  if (await page.getByRole('button', { name: 'My CLANs', exact: true }).isVisible()) { // from the world; after Leave we're already on the join screen
    await page.getByRole('button', { name: 'My CLANs', exact: true }).click();
    await page.getByRole('button', { name: 'Join by Code' }).click();
  }
  await page.getByLabel('Full name').or(page.locator('.code-input')).first().waitFor();
  if (await page.getByLabel('Full name').isVisible()) {
    await page.getByLabel('Full name').fill(name);
    await page.getByLabel('Student / roll number').fill(`R-${name}`);
    await page.getByLabel('Device name').fill(`${name}-Mac`);
    await page.getByRole('button', { name: 'Save' }).click();
  }
  await page.locator('.code-input').fill(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  // a new member waits for approval; a known device may be let straight in
  await page.getByText(/Waiting for the (host|teacher)/).or(page.getByTestId('secure-state')).first().waitFor({ timeout: 20_000 });
}
const count = async (p: Page) => Number(/: (\d+) objects/.exec((await p.getByTestId('board-canvas').getAttribute('aria-label')) ?? '')?.[1] ?? -1);
async function drawStroke(p: Page, dx: number, dy: number) {
  const b = (await p.getByTestId('board-canvas').boundingBox())!;
  await p.mouse.move(b.x + 60 + dx, b.y + 60 + dy); await p.mouse.down();
  for (let i = 1; i <= 8; i++) await p.mouse.move(b.x + 60 + dx + i * 12, b.y + 60 + dy + (i % 2) * 10);
  await p.mouse.up();
}
async function dragShape(p: Page, tool: string, x: number, y: number) {
  await p.getByRole('toolbar', { name: 'Whiteboard tools' }).getByRole('button', { name: tool, exact: true }).click();
  const b = (await p.getByTestId('board-canvas').boundingBox())!;
  await p.mouse.move(b.x + x, b.y + y); await p.mouse.down(); await p.mouse.move(b.x + x + 80, b.y + y + 50, { steps: 4 }); await p.mouse.up();
}

it('Study Group board: concurrent drawing, text/sticky/file card, rejoin restores, host again persists', async () => {
  const { app: hostApp, page: host } = await launch();
  await host.getByRole('button', { name: 'My CLANs', exact: true }).click();
  await host.getByRole('button', { name: 'Create CLAN' }).click();
  await host.getByLabel('Name', { exact: true }).fill('Board Group');
  await host.getByRole('button', { name: 'Start CLAN' }).click();
  const code = (await host.getByLabel('Join code').textContent())!.replace(/\D/g, '');
  const A = await launch(), B = await launch();
  await joinByCode(A.page, 'Ali', code); await host.getByRole('button', { name: 'Approve', exact: true }).click();
  await joinByCode(B.page, 'Sara', code); await host.getByRole('button', { name: 'Approve', exact: true }).click();
  for (const p of [A.page, B.page]) await p.getByTestId('secure-state').waitFor({ timeout: 15_000 });

  // put the board on the wall (host); everyone sees it
  await host.getByRole('group', { name: 'Whiteboard' }).getByRole('button', { name: 'Whiteboard' }).click();
  for (const p of [host, A.page, B.page]) await p.getByTestId('wall-board').waitFor({ timeout: 10_000 });

  // two members draw at the same time
  await Promise.all([drawStroke(A.page, 0, 0), dragShape(B.page, 'Rectangle', 300, 80)]);
  for (const p of [host, A.page, B.page]) await expect.poll(() => count(p), { timeout: 10_000 }).toBe(2);
  // text and a sticky note
  await A.page.getByRole('toolbar', { name: 'Whiteboard tools' }).getByRole('button', { name: 'Sticky note', exact: true }).click();
  const ba = (await A.page.getByTestId('board-canvas').boundingBox())!;
  await A.page.mouse.click(ba.x + 120, ba.y + 220);
  await A.page.getByLabel('Sticky note text').fill('Deadlock: 4 conditions');
  await A.page.keyboard.press('Enter');
  await B.page.getByRole('toolbar', { name: 'Whiteboard tools' }).getByRole('button', { name: 'Text', exact: true }).click();
  const bb = (await B.page.getByTestId('board-canvas').boundingBox())!;
  await B.page.mouse.click(bb.x + 420, bb.y + 240);
  await B.page.getByLabel('Text on the board').fill('mutual exclusion');
  await B.page.keyboard.press('Enter');
  // a file from the table, placed as a card (only shared files can be placed)
  writeFileSync(join(scratch, 'diagram.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await chooseFiles(hostApp, [join(scratch, 'diagram.png')]);
  await host.getByRole('button', { name: 'Add files' }).click();
  await A.page.getByRole('button', { name: 'Place…' }).click();
  await A.page.getByRole('option', { name: /diagram\.png/ }).click({ timeout: 15_000 });
  for (const p of [host, A.page, B.page]) await expect.poll(() => count(p), { timeout: 10_000 }).toBe(5);
  expect(await B.page.getByRole('list', { name: 'Board text' }).textContent()).toContain('Deadlock: 4 conditions');

  // Sara leaves and joins again: the board comes back from the host
  await B.page.getByRole('button', { name: 'Leave', exact: true }).click();
  await joinByCode(B.page, 'Sara', code);
  if (await B.page.getByText(/Waiting for the host/).isVisible()) await host.getByRole('button', { name: 'Approve', exact: true }).click();
  await B.page.getByTestId('wall-board').waitFor({ timeout: 15_000 });
  await expect.poll(() => count(B.page), { timeout: 10_000 }).toBe(5);

  // host again: new session, same CLAN board
  await host.getByRole('button', { name: 'End CLAN' }).click();
  await host.getByRole('button', { name: 'My CLANs', exact: true }).click();
  await host.locator('.clan-card', { hasText: 'Board Group' }).click();
  await host.getByRole('button', { name: 'Host again' }).click();
  await host.getByRole('button', { name: 'Host again' }).click();
  await host.getByLabel('Join code').waitFor({ timeout: 15_000 });
  await host.getByRole('group', { name: 'Whiteboard' }).getByRole('button', { name: 'Whiteboard' }).click();
  await host.getByTestId('wall-board').waitFor();
  await expect.poll(() => count(host), { timeout: 10_000 }).toBe(5);
}, 300_000);

it('Classroom board: students view only until the teacher lets them draw', async () => {
  const { page: t } = await launch();
  await t.getByText('Create Classroom').click();
  await t.getByLabel('Class name').fill('OS Board Class');
  await t.getByRole('button', { name: 'Start Classroom' }).click();
  const code = (await t.getByLabel('Join code').textContent())!.replace(/\D/g, '');
  const S = await launch();
  await joinByCode(S.page, 'Omar', code);
  await t.getByRole('button', { name: 'Approve', exact: true }).click();
  await S.page.getByTestId('secure-state').waitFor({ timeout: 15_000 });
  await t.getByRole('group', { name: 'Whiteboard' }).getByRole('button', { name: 'Whiteboard' }).click();
  await S.page.getByTestId('wall-board').waitFor({ timeout: 10_000 });
  await S.page.getByText('View only — the host can let you draw.').waitFor();
  expect(await S.page.getByRole('toolbar', { name: 'Whiteboard tools' }).getByRole('button', { name: 'Pen', exact: true }).count()).toBe(0);
  await t.getByLabel('Students may draw').click();
  await expect.poll(() => t.getByLabel('Students may draw').isChecked()).toBe(true); // confirmed by the host session
  await S.page.getByRole('toolbar', { name: 'Whiteboard tools' }).getByRole('button', { name: 'Pen', exact: true }).waitFor({ timeout: 10_000 });
  await S.page.getByRole('toolbar', { name: 'Whiteboard tools' }).getByRole('button', { name: 'Pen', exact: true }).click();
  await drawStroke(S.page, 0, 0);
  await expect.poll(() => count(t), { timeout: 10_000 }).toBe(1);
}, 180_000);

it('Study Tape: session → record → markers → stop → play → jump → link → restart persists', async () => {
  const { page: p, userData, app } = await launch({ CLAN_TEST_CAPTURE: '1' });
  const ids = await p.evaluate(async () => { const c = await window.classroom.study.createCourse({ name: 'Operating Systems', code: 'CS-330' }); const l = await window.classroom.study.addLecture(c.id, { title: 'Lecture 7' }); return { course: c.id, lecture: l.id }; });
  await p.getByRole('button', { name: 'Start studying' }).click();
  await p.getByTestId('session-bar').getByRole('button', { name: 'Record' }).click();
  const dlg = p.getByRole('dialog', { name: 'Record a Study Tape' });
  await dlg.getByLabel('Tape title').fill('OS lecture tape');
  await dlg.getByRole('option', { name: /Test pattern/ }).click();
  await dlg.getByLabel('Course').selectOption({ label: 'Operating Systems' });
  await dlg.getByRole('button', { name: 'Start recording' }).click();
  const ind = p.getByTestId('rec-indicator');
  await ind.waitFor();
  // the indicator stays while navigating
  await p.getByRole('button', { name: 'Me', exact: true }).click(); await ind.waitFor();
  await p.waitForTimeout(1500);
  await ind.getByRole('button', { name: 'Mark important' }).click();
  await ind.getByRole('button', { name: 'Add note' }).click();
  await ind.getByLabel('Timeline note').fill('Exam hint: Banker algorithm');
  await ind.getByRole('button', { name: 'Add', exact: true }).click();
  await ind.getByRole('button', { name: 'Capture screenshot' }).click();
  await p.waitForTimeout(800);
  await ind.getByRole('button', { name: 'Bookmark' }).click();
  await p.waitForTimeout(1500);
  // end the session: stop the recording too and save the tape
  await p.getByTestId('session-bar').getByRole('button', { name: 'End session' }).click();
  await p.getByRole('button', { name: 'Save and end' }).click();
  await expect.poll(() => ind.count(), { timeout: 15_000 }).toBe(0);
  // The indicator disappears when stop starts; saving the final chunk and ending the session are still asynchronous.
  await expect.poll(() => p.getByTestId('session-bar').count(), { timeout: 15_000 }).toBe(0);
  // play it from the shelf
  await p.bringToFront();
  await p.getByRole('button', { name: 'Study', exact: true }).click();
  await p.getByRole('tablist', { name: 'Study area' }).getByRole('tab', { name: 'Study Tapes', exact: true }).click();
  await p.getByTestId('tape-case').first().click();
  await p.getByTestId('tape-player').waitFor();
  await expect.poll(() => p.getByTestId('tape-event').count()).toBe(4);
  await expect.poll(() => p.getByTestId('tape-video').evaluate((v: HTMLVideoElement) => v.readyState), { timeout: 15_000 }).toBeGreaterThan(0);
  await p.getByTestId('tape-event').filter({ hasText: '📝' }).getByRole('button', { name: /Jump to/ }).click();
  await expect.poll(() => p.getByTestId('tape-video').evaluate((v: HTMLVideoElement) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(1);
  await p.getByTestId('tape-player').getByLabel('Lecture', { exact: true }).selectOption({ label: 'Lecture 7' });
  await expect.poll(() => p.evaluate(async (l) => (await window.classroom.rec.list({ lectureId: l })).length, ids.lecture)).toBe(1);
  // restart: everything is still there
  await app.close();
  const again = await launch({ CLAN_TEST_CAPTURE: '1' }, userData);
  const after = await again.page.evaluate(async () => { const [t] = await window.classroom.rec.list(); const d = await window.classroom.rec.get(t!.id); return { status: t!.status, bytes: t!.bytes, lecture: t!.lectureId, course: t!.courseId, events: d!.events.map((e) => e.kind), dur: t!.durationMs }; });
  expect(after).toMatchObject({ status: 'ready', lecture: ids.lecture, course: ids.course, events: ['important', 'note', 'screenshot', 'bookmark'] });
  expect(after.bytes).toBeGreaterThan(10_000);
  expect(after.dur).toBeGreaterThan(3000);
  // the Course shows it under Recordings, by reference
  expect(await again.page.evaluate(async (c) => (await window.classroom.study.course(c)).tapes.length, ids.course)).toBe(1);
}, 180_000);
