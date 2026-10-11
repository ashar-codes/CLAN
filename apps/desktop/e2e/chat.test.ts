// Chat & direct sends E2E: real Electron apps over the real LAN path (OPAQUE, pinned TLS/WSS, host chat store).
// Native file pickers can't be driven by automation, so the main process's dialog returns a real file on disk; everything
// after the pick (hashing, audience, transfer, verification) is the production path.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

type App = { app: ElectronApplication; page: Page; userData: string; downloads: string };
const apps: ElectronApplication[] = [];
const dirs: string[] = [];
afterAll(async () => { await Promise.all(apps.map((a) => a.close().catch(() => {}))); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p = 'clan-') => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

async function launch(userData = tmp(), downloads = tmp('clan-dl-')): Promise<App> {
  const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: userData, CLASSROOM_DOWNLOADS_DIR: downloads } });
  apps.push(app);
  if (process.env.DEBUG_E2E) app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  page.on('dialog', (d) => d.accept());
  return { app, page, userData, downloads };
}
/** The next file dialog returns `path` (automation can't click a native picker). */
const pickNext = (a: App, path: string) => a.app.evaluate(({ dialog }, p) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as never; }, path);
const file = (name: string, bytes = 200_000) => { const p = join(tmp('clan-src-'), name); const b = randomBytes(bytes); writeFileSync(p, b); return { path: p, sha: createHash('sha256').update(b).digest('hex') }; };

async function hostClan(p: Page, type: 'Classroom' | 'Study group', name: string) {
  await p.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await p.getByRole('button', { name: 'Create CLAN' }).click();
  await p.getByRole('radio', { name: type, exact: true }).click();
  await p.getByLabel(type === 'Classroom' ? 'Class name' : 'Name', { exact: true }).fill(name);
  await p.getByRole('button', { name: type === 'Classroom' ? 'Start Classroom' : 'Start CLAN' }).click();
  return (await p.getByLabel('Join code').textContent())!.replace(/\D/g, '');
}
async function joinClan(p: Page, name: string, code: string, host: Page, first = true) {
  if (!(await p.locator('.code-input').isVisible())) { // after leaving a CLAN the app is already on the join screen
    await p.getByRole('button', { name: 'CLANs', exact: false }).first().click();
    await p.getByRole('button', { name: 'Join by Code' }).click();
  }
  if (first) { await p.getByLabel('Full name').fill(name); await p.getByLabel('Student / roll number').fill(`R-${name}`); await p.getByLabel('Device name').fill(`${name}-Mac`); await p.getByRole('button', { name: 'Save' }).click(); }
  await p.locator('.code-input').fill(code); await p.getByRole('button', { name: 'Join', exact: true }).click();
  await host.getByRole('button', { name: 'Approve', exact: true }).first().click({ timeout: 25_000 });
  await p.getByTestId('secure-state').waitFor({ timeout: 15_000 });
}
const say = async (p: Page, text: string) => { await p.getByTestId('chat-input').fill(text); await p.getByTestId('chat-input').press('Enter'); };
const log = (p: Page) => p.locator('[role="log"]');
const wheel = async (p: Page, who: string, action: 'Message' | 'Send') => {
  await p.locator('.c-room-person', { hasText: who }).click();
  await p.locator('.wheel-pop').getByRole('button', { name: action, exact: true }).click();
};

it('Study Group: group chat, reply, send to one member only, table share, direct conversation, re-host keeps history', async () => {
  const a = await launch(), b = await launch(), c = await launch();
  const code = await hostClan(a.page, 'Study group', 'Chat Study Group');
  await joinClan(b.page, 'Bea', code, a.page);
  await joinClan(c.page, 'Cal', code, a.page);

  // A → group; B and C receive it.
  await a.page.getByTestId('chat').waitFor();
  await say(a.page, 'hello everyone');
  for (const x of [b, c]) await log(x.page).getByText('hello everyone').waitFor({ timeout: 15_000 });
  // B replies: the reply points at A's message (quoted from the original, not copied).
  const original = log(b.page).getByTestId('chat-message').filter({ hasText: 'hello everyone' });
  await original.getByRole('button', { name: 'Reply' }).click();
  await say(b.page, 'hi from Bea');
  const reply = log(a.page).getByTestId('chat-message').filter({ hasText: 'hi from Bea' });
  await expect.poll(() => reply.locator('.chat-quote').textContent(), { timeout: 15_000 }).toContain('hello everyone');
  await log(a.page).getByText('Seen by').first().waitFor({ timeout: 15_000 }); // B and C really showed it

  // A sends a file to B only (CLANmate › Send).
  const secret = file('only-bea.pdf');
  await pickNext(a, secret.path);
  await wheel(a.page, 'Bea', 'Send');
  await a.page.getByText('to Bea only').waitFor({ timeout: 15_000 });
  await b.page.getByTestId('thread-Host').click({ timeout: 15_000 });
  const att = log(b.page).getByTestId('chat-file').filter({ hasText: 'only-bea.pdf' });
  await att.getByText('only the two of you').waitFor();
  await att.getByTestId('chat-download').click();
  await att.getByText('verified ✓').waitFor({ timeout: 30_000 });
  const got = readdirSync(b.downloads, { recursive: true }).map(String).find((f) => f.endsWith('only-bea.pdf'))!;
  expect(createHash('sha256').update(readFileSync(join(b.downloads, got))).digest('hex')).toBe(secret.sha);
  // C: no conversation, no file — not on the table, not in C's files.
  expect(await c.page.getByTestId('thread-Host').count()).toBe(0);
  expect(await c.page.getByText('only-bea.pdf').count()).toBe(0);
  expect(await a.page.getByTestId('room-table').getByTitle('only-bea.pdf').count()).toBe(0);

  // The table: everyone.
  const shared = file('for-everyone.pdf');
  await pickNext(a, shared.path);
  await a.page.getByRole('button', { name: 'Add files' }).click();
  for (const x of [b, c]) await x.page.getByText('for-everyone.pdf').first().waitFor({ timeout: 15_000 });

  // B → A directly; C never sees it.
  await wheel(b.page, 'Host', 'Message');
  await say(b.page, 'psst, a question for you');
  await a.page.getByTestId('thread-Bea').click({ timeout: 15_000 });
  await log(a.page).getByText('psst, a question for you').waitFor();
  await c.page.waitForTimeout(500);
  expect(await c.page.getByText('psst, a question for you').count()).toBe(0);
  expect(await c.page.locator('.chat-thread').count()).toBe(1); // only "Everyone"

  // End, then host the same CLAN again: the history is there, once.
  await a.page.getByRole('button', { name: 'End CLAN' }).click();
  await b.page.getByRole('button', { name: 'OK' }).click({ timeout: 15_000 });
  await a.page.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await a.page.locator('.place-card', { hasText: 'Chat Study Group' }).click();
  await a.page.getByRole('button', { name: 'Host again' }).click();
  await a.page.getByRole('button', { name: 'Host again' }).click();
  const code2 = (await a.page.getByLabel('Join code').textContent())!.replace(/\D/g, '');
  await joinClan(b.page, 'Bea', code2, a.page, false);
  await log(b.page).getByText('hello everyone', { exact: true }).first().waitFor({ timeout: 15_000 });
  expect(await log(b.page).getByText('hello everyone', { exact: true }).count()).toBe(1);
  expect(await log(b.page).getByText('hi from Bea', { exact: true }).count()).toBe(1);
  await say(b.page, 'back again');
  await log(a.page).getByText('back again').waitFor({ timeout: 15_000 });
  await a.page.getByTestId('thread-Bea').click();
  await log(a.page).getByText('psst, a question for you').waitFor();

  // B restarts its app offline from the host: the cached conversation is readable in the CLAN's Chat tab.
  await b.app.close();
  const b2 = await launch(b.userData, b.downloads);
  await b2.page.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await b2.page.locator('.place-card', { hasText: 'Chat Study Group' }).click();
  await b2.page.getByRole('tab', { name: 'Chat' }).click();
  await b2.page.getByRole('button', { name: 'Everyone' }).click();
  await b2.page.getByText('back again').waitFor();
  expect(await b2.page.locator('.chat-log.offline .line', { hasText: 'hello everyone' }).count()).toBe(1); // cached once, not per session
}, 300_000);

it('Classroom: a student sees only their CLAN’s conversation, can message the teacher, and cannot send files', async () => {
  const t = await launch(), s1 = await launch(), s2 = await launch();
  const code = await hostClan(t.page, 'Classroom', 'Chat Classroom');
  await joinClan(s1.page, 'Sana', code, t.page);
  await joinClan(s2.page, 'Omar', code, t.page);
  // No classmates to pick (no member list in a Classroom) — only the teacher; no file attachments.
  await s1.page.getByTestId('chat').waitFor();
  expect(await s1.page.getByRole('button', { name: 'Attach file' }).count()).toBe(0);
  expect(await s1.page.locator('.chat-people').getByRole('button').allTextContents()).toEqual(['Host (host)']);
  await s2.page.locator('.chat-people').getByRole('button', { name: 'Host (host)' }).click();
  await say(s2.page, 'question only for the teacher');
  await t.page.getByTestId('thread-Omar').click({ timeout: 15_000 });
  await log(t.page).getByText('question only for the teacher').waitFor();
  await say(t.page, 'answer for Omar');
  await log(s2.page).getByText('answer for Omar').waitFor({ timeout: 15_000 });
  await s1.page.waitForTimeout(500);
  expect(await s1.page.getByText('question only for the teacher').count()).toBe(0);
  expect(await s1.page.getByText('answer for Omar').count()).toBe(0);
  // Group messages still reach the whole class.
  await say(s1.page, 'when is the quiz?');
  await t.page.getByTestId('thread-group').click();
  await log(t.page).getByText('when is the quiz?').waitFor({ timeout: 15_000 });
}, 240_000);

it('clan:// intake: a link from another app lands in the Inbox; malformed or dangerous payloads are ignored', async () => {
  const x = await launch();
  const open = (url: string) => x.app.evaluate(({ app }, u) => { app.emit('open-url', { preventDefault() {} }, u); }, url);
  await open('clan://capture?url=https%3A%2F%2Fexample.org%2Fnotes&title=Lecture%20notes');
  for (const bad of ['clan://capture?url=javascript%3Aalert(1)', 'clan://capture?path=%2Fetc%2Fpasswd', 'clan://capture?url=file%3A%2F%2F%2Fetc%2Fhosts', 'clan://open?url=https%3A%2F%2Fevil.example']) await open(bad);
  await x.page.getByRole('button', { name: 'Saved', exact: false }).first().click();
  await x.page.getByTestId('inbox').getByText('Lecture notes').waitFor({ timeout: 10_000 });
  expect(await x.page.getByTestId('inbox-item').count()).toBe(1);
}, 60_000);

it('chat scroll stays put while reading, jumps to latest, and preserves the visible message on pagination', async () => {
  const h = await launch(), s = await launch();
  const code = await hostClan(h.page, 'Study group', 'History Group');
  await joinClan(s.page, 'Reader', code, h.page);
  await h.page.getByTestId('chat-input').waitFor();
  // Respect the real 30 messages / 10 s per-author limit.
  for (let i = 0; i < 58; i++) await say(i % 2 ? s.page : h.page, `history ${String(i).padStart(2, '0')}`);
  await expect.poll(() => log(s.page).getByTestId('chat-message').count()).toBe(58);
  await log(s.page).evaluate((el) => { el.scrollTop = 100; el.dispatchEvent(new Event('scroll')); });
  const top = await log(s.page).evaluate((el) => el.scrollTop);
  await say(h.page, 'arrived while reading');
  await log(s.page).getByText('arrived while reading').waitFor();
  expect(Math.abs(await log(s.page).evaluate((el) => el.scrollTop) - top)).toBeLessThan(3);
  await s.page.getByRole('button', { name: 'Jump to latest' }).click();
  await expect.poll(() => log(s.page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThan(3);

  await s.app.close();
  const again = await launch(s.userData, s.downloads);
  await again.page.getByRole('button', { name: 'CLANs', exact: false }).first().click();
  await again.page.getByRole('button', { name: 'Join by Code' }).click();
  await again.page.getByRole('button', { name: 'Rejoin', exact: false }).first().click();
  await log(again.page).getByText('arrived while reading').waitFor();
  expect(await log(again.page).getByTestId('chat-message').count()).toBe(50);
  await log(again.page).evaluate((el) => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  const anchor = log(again.page).getByTestId('chat-message').first();
  const label = await anchor.getAttribute('aria-label'), y = (await anchor.boundingBox())!.y;
  await again.page.getByRole('button', { name: 'Load earlier messages' }).click();
  await expect.poll(() => log(again.page).getByTestId('chat-message').count()).toBe(59);
  const same = log(again.page).getByTestId('chat-message').filter({ has: again.page.getByText('history 09', { exact: true }) });
  expect(await same.getAttribute('aria-label')).toBe(label);
  expect(Math.abs((await same.boundingBox())!.y - y)).toBeLessThan(3);
  for (const width of [1440, 1024, 390, 360]) {
    await again.page.setViewportSize({ width, height: 844 });
    expect(await log(again.page).evaluate((el) => el.scrollHeight > el.clientHeight && el.clientHeight > 100)).toBe(true);
    expect(await again.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await expect.poll(() => again.page.getByTestId('chat-input').isVisible()).toBe(true);
  }
}, 180_000);
