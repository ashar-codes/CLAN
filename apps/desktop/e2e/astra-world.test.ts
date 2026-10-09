import { _electron as electron } from 'playwright-core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it('Astra object actions, responsive layout, reduced motion and GPU fallback stay usable', async () => {
 const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: mkdtempSync(join(tmpdir(), 'clan-astra-world-')) } });
 try {
  const p = await app.firstWindow(); await p.waitForLoadState();
  const tab = async (name: string) => p.locator('.tabs-main').getByRole('button', { name, exact: false }).click();
  await p.evaluate(async () => { localStorage.setItem('clan.experience','full'); await window.classroom.study.createCourse({ name: 'Course with no topics' }); });
  await p.reload();
  for (const [object, target] of [['Library:', 'Knowledge Campus'], ['Semester board:', 'Semester Board'], ['Backpack:', 'Your shelves'], ['Commons:', 'Who’s around']] as const) {
   await tab('My Space');
   const button = p.locator('svg.room').getByRole('button', { name: new RegExp(`^${object}`) });
   await button.press('Enter'); await expect.poll(() => p.locator('h1').allTextContents()).toContain(target);
  }
  await tab('My Space'); await p.getByRole('button', { name: 'Journal: your private Diary' }).press('Enter');
  await p.getByLabel('Diary entry').waitFor();
  await p.getByText('No AI provider. Study, search and your material work without one.').waitFor();
  for (const width of [1440,1024,390,360]) { await p.setViewportSize({ width, height: 844 }); expect(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true); }
  await p.setViewportSize({ width:1440,height:900 });
  await tab('Me'); await p.getByLabel('Hairstyle', { exact: true }).selectOption('bun'); await p.reload(); await tab('Me');
  expect(await p.getByLabel('Hairstyle', { exact: true }).inputValue()).toBe('bun');
  for (const mode of ['Reduced','Minimal']) {
   await p.getByRole('radio', { name: new RegExp(`^${mode}`) }).check(); await tab('Study');
   await p.getByText('Course with no topics', { exact: true }).first().waitFor(); // courses load async: count() alone raced it
   expect(await p.locator('canvas').count()).toBe(0); await tab('Me');
  }
  await p.getByRole('radio', { name: /^Full/ }).check(); await p.emulateMedia({ reducedMotion: 'reduce' }); await tab('My Space');
  expect(await p.locator('.c-mate-body').evaluate((e) => parseFloat(getComputedStyle(e).animationDuration))).toBeLessThan(.001);
  await p.emulateMedia({ reducedMotion: 'no-preference' });
  await p.evaluate(() => {
    const active = new Set<EventListenerOrEventListenerObject>();
    const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
    document.addEventListener = ((type: string, cb: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => { if (type === 'visibilitychange') active.add(cb); add(type, cb, opts); }) as typeof document.addEventListener;
    document.removeEventListener = ((type: string, cb: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) => { active.delete(cb); remove(type, cb, opts); }) as typeof document.removeEventListener;
    (window as unknown as { __sceneListeners: Set<unknown> }).__sceneListeners = active;
  });
  await tab('Study');
  await p.locator('canvas').waitFor(); await p.locator('canvas').dispatchEvent('webglcontextlost');
  await p.getByText('3D is unavailable. Your courses are ready below.').waitFor();
  expect(await p.locator('canvas').count()).toBe(0);
  expect(await p.evaluate(() => (window as unknown as { __sceneListeners: Set<unknown> }).__sceneListeners.size)).toBe(0);
  await p.getByRole('button', { name: 'Course with no topics', exact: true }).first().click(); await p.getByTestId('course-space').waitFor();
 } finally { await app.close(); }
});
