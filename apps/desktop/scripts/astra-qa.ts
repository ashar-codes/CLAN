// Real production Electron renderer; disposable data through public application interfaces.
// 390/360 captures are desktop responsive views, never native Android evidence.
import { _electron as electron, type Page } from 'playwright-core';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const out = join(import.meta.dirname, '../../../design/astra');
mkdirSync(out, { recursive: true });
const start = performance.now();
const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: mkdtempSync(join(tmpdir(), 'clan-astra-qa-')) } });
const errors: string[] = [], checks: object[] = [];
try {
 const p = await app.firstWindow(); await p.waitForLoadState(); await p.locator('.tabs-main').waitFor();
 const startupMs = Math.round(performance.now() - start);
 p.on('pageerror', (e) => errors.push(e.message)); p.on('dialog', (d) => d.accept());
 await p.evaluate(() => { localStorage.setItem('clan.experience', 'full'); document.documentElement.dataset.theme = 'light'; });
 await p.reload();
 const ids = await p.evaluate(async () => {
  const a = window.classroom;
  await a.clan.rename('Ayesha Khan');
  const courses: string[] = [];
  for (const [name, code, topics] of [['Operating Systems','CS-330',['Processes','Scheduling','Memory','Deadlocks']], ['Linear Algebra','MA-210',['Vectors','Eigenvalues','Transformations']], ['Design Research','DS-120',[]]] as const) {
   const c = await a.study.createCourse({ name, code, term: 'Fall 2026' }); courses.push(c.id);
   for (const [i, title] of topics.entries()) { const t = await a.study.addTopic(c.id, title); if (i === 0) await a.study.setConfidence(t.id, 'confident'); }
  }
  const exam = await a.study.createExam({ courseId: courses[0]!, name: 'Systems midterm', at: Date.now() + 5 * 86400000 }, []);
  await a.study.createTask({ courseId: courses[0], title: 'Review process scheduling', dueAt: Date.now() + 3600000 });
  await a.clan.createNote({ title: 'A good study rhythm', body: 'Read, explain it in your own words, then test yourself.' });
  await a.clan.save({ title: 'Course reading list', url: 'https://example.org/reading', tags: ['reading'] });
  await a.clan.writeDiary({ day: new Date().toLocaleDateString('en-CA'), body: 'The scheduling lecture clicked today. Tomorrow: work through the examples with my study group.', mood: 'calm' });
  const board = await a.board.create({ kind: 'personal', id: 'me' }, 'Study map');
  await a.board.edit(board.id, [ { t: 'put', id: crypto.randomUUID(), obj: crypto.randomUUID(), clock: 1, data: { kind: 'sticky', page: 0, x: 70, y: 70, w: 180, h: 120, color: '#17233b', fill: '#fbe9be', width: 1, z: 1, text: 'Explain the idea\nTry an example\nCheck your answer' } }, { t: 'put', id: crypto.randomUUID(), obj: crypto.randomUUID(), clock: 2, data: { kind: 'arrow', page: 0, x: 260, y: 125, w: 140, h: 35, color: '#287a4e', width: 4, z: 2 } } ]);
  return { courses, exam: exam.id, board: board.id };
 });
 await p.reload(); await p.waitForTimeout(500);
 const tab = async (name: string) => { await p.locator('.tabs-main').getByRole('button', { name, exact: false }).click(); };
 const study = async (name: string) => { await tab('Study'); await p.getByRole('tablist', { name: 'Study area' }).getByRole('tab', { name, exact: true }).click(); };
 const shot = async (name: string) => {
  for (const [width, height] of [[1440,900],[1024,768],[390,844],[360,800]]) {
   await p.setViewportSize({ width: width!, height: height! }); await p.waitForTimeout(300);
   const dir = join(out, `desktop-responsive-${width}x${height}`); mkdirSync(dir, { recursive: true });
   await p.screenshot({ path: join(dir, `${name}.png`) });
   checks.push({ screen: name, width, overflow: await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1) });
  }
  await p.setViewportSize({ width: 1440, height: 900 });
 };
 await tab('My Space'); await shot('01-my-space');
 // Real object action, keyboard activation, and persisted customization.
 await p.getByRole('button', { name: 'Journal: your private Diary' }).press('Enter'); await p.getByLabel('Diary entry').waitFor();
 await shot('07-diary');
 await tab('Me'); await p.getByLabel('Hairstyle', { exact: true }).selectOption('curls');
 await p.getByLabel('Accessory', { exact: true }).selectOption('glasses');
 const localAvatar = await p.locator('.me-mate .c-mate > svg').innerHTML();
 checks.push({ customization: await p.evaluate(() => JSON.parse(localStorage.getItem('clan.appearance.v1')!).hair === 'curls') });
 await tab('Commons'); await shot('02-commons');
 await study('Campus'); await p.waitForTimeout(1500); await shot('04-knowledge-campus');
 const scene = await p.evaluate(() => window.__clanPerf);
 await p.getByRole('button', { name: 'Operating Systems', exact: true }).click(); await shot('05-course');
 await tab('Saved'); await shot('06-saved');
 await study('Exams'); await p.getByRole('button', { name: /Systems midterm,/ }).click(); await shot('08-exam-prep');
 await study('Boards'); await p.getByTestId('board-card').filter({ hasText: 'Study map' }).click(); await shot('10-whiteboard');
 // Reduced and Minimal remain functional and have no 3D context.
 for (const mode of ['Reduced','Minimal']) {
  await tab('Me'); await p.getByRole('radio', { name: new RegExp(`^${mode}`) }).check();
  await tab('My Space'); await shot(`mode-${mode.toLowerCase()}`);
  await study('Campus'); checks.push({ mode, canvases: await p.locator('canvas').count(), courseAccess: await p.getByText('Operating Systems', { exact: true }).count() > 0 });
 }
 await tab('Me'); await p.getByRole('radio', { name: /^Full/ }).check();
 await p.emulateMedia({ reducedMotion: 'reduce' }); await tab('My Space');
 checks.push({ reducedMotionDuration: await p.locator('.c-mate-body').first().evaluate((e) => getComputedStyle(e).animationDuration) });
 await p.emulateMedia({ reducedMotion: 'no-preference' });
 await tab('CLANs'); await p.getByRole('button', { name: 'Create CLAN' }).click(); await p.getByRole('radio', { name: 'Study group', exact: true }).click(); await p.getByLabel('Name', { exact: true }).fill('Systems study circle'); await p.getByRole('button', { name: 'Start CLAN' }).click(); await p.getByLabel('Join code').waitFor();
 const roomAvatarMatches = await p.locator('[data-person="host"] .c-mate > svg').innerHTML() === localAvatar;
 checks.push({ roomAvatarMatches });
 if (!roomAvatarMatches) throw new Error('Local appearance did not follow the host into the room');
 await shot('03-clan-room');
 await p.locator('.chat textarea').fill('Let’s compare our scheduling examples, then explain the tricky steps together.');
 await p.locator('.chat').getByRole('button', { name: 'Send', exact: true }).click();
 await p.locator('.chat').getByText('Let’s compare our scheduling examples, then explain the tricky steps together.', { exact: true }).waitFor();
 await p.locator('.chat').scrollIntoViewIfNeeded(); await shot('09-chat');
 const memory = await app.evaluate(({ app }) => app.getAppMetrics().map((m) => ({ type: m.type, workingSetKB: m.memory.workingSetSize })));
 const frame = await p.evaluate(async () => { const values: number[] = []; let last = performance.now(); for (let i = 0; i < 120; i++) await new Promise<void>((resolve) => requestAnimationFrame((now) => { values.push(now-last); last=now; resolve(); })); values.sort((a,b) => a-b); return { p50Ms: values[60], p90Ms: values[108], samples: values.length }; });
 writeFileSync(join(out,'qa.json'), JSON.stringify({ startupMs, scene, memory, frame, checks, errors, platform: 'macOS Electron; responsive captures are not native mobile' }, null, 2));
 console.log(JSON.stringify({ startupMs, scene, frame, errors, overflow: checks.filter((x: any) => x.overflow) }, null, 2));
} finally { await app.close(); }
