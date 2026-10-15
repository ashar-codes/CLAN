// First run on a fresh profile: onboarding is required, names the person and this device, and makes them visible to
// Everyone Nearby by default (persisting, not one hour); the saved People identity uses exactly what was typed.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const profile = mkdtempSync(join(tmpdir(), 'clan-onboard-'));
afterAll(() => rmSync(profile, { recursive: true, force: true }));

it('requires name and device name, then People shows them with Everyone Nearby on', async () => {
  const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: profile, CLAN_E2E_ONBOARDING: '1' } });
  try {
    const page = await app.firstWindow();
    await page.getByRole('heading', { name: 'Welcome to CLAN' }).waitFor({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('alert').getByText('Enter your full name.').waitFor();
    await page.getByLabel('Full name').fill('  Zoë   Ñúñez ');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('alert').getByText(/Name this computer/).waitFor();
    await page.getByLabel('Device name').fill('Zoë’s MacBook');
    expect(await page.getByLabel(/Everyone nearby/).isChecked()).toBe(true);
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('heading', { name: 'Welcome to CLAN' }).waitFor({ state: 'detached' });
    const me = await page.evaluate(() => (window as unknown as { classroom: { people: { me(): Promise<{ profile: { name: string; deviceName: string | null; visibility: string; everyoneUntil: number | null } }> } } }).classroom.people.me());
    expect(me.profile).toMatchObject({ name: 'Zoë Ñúñez', deviceName: 'Zoë’s MacBook', visibility: 'everyone', everyoneUntil: null });
    expect(await page.evaluate(() => document.body.innerText.includes('Ashar') || document.body.innerText.includes('CLAN user'))).toBe(false);
  } finally { await app.close(); }
}, 90_000);
