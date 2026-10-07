// CLAN Direct Network E2E on the deterministic MOCK backend (macOS/CI). Real Electron apps, real OPAQUE over the BLE
// framing (local-socket "radio"), real sealed Wi-Fi package, real pinned HTTPS. The radio/AP itself is simulated:
// real Windows Direct runtime is UNVERIFIED here (docs/WINDOWS_DIRECT_MODE.md).
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';

const apps: ElectronApplication[] = [];
const dirs: string[] = [];
const scratch = mkdtempSync(join(tmpdir(), 'clan-direct-')); dirs.push(scratch);
const radio = join(scratch, 'radio');
afterAll(async () => { await Promise.all(apps.map((a) => a.close().catch(() => {}))); for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const chooseFiles = (app: ElectronApplication, paths: string[]) => app.evaluate(({ dialog }, ps) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: ps })) as never; }, paths);

async function launch(env: Record<string, string> = {}) {
  const userData = mkdtempSync(join(tmpdir(), 'clan-')); dirs.push(userData);
  const app = await electron.launch({ args: ['.'], cwd: join(import.meta.dirname, '..'),
    env: { ...process.env, CLASSROOM_USER_DATA: userData, CLAN_DIRECT_BACKEND: 'mock', CLAN_MOCK_RADIO_DIR: radio, ...env } });
  apps.push(app);
  if (process.env.DEBUG_E2E) app.process().stderr?.on('data', (d) => process.stderr.write(`[app] ${d}`));
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userData };
}

async function joinByCode(page: Page, name: string, code: string) {
  await page.getByRole('button', { name: 'CLANs', exact: true }).click();
  await page.getByRole('button', { name: 'Join by Code' }).click();
  await page.getByLabel('Full name').fill(name);
  await page.getByLabel('Student / roll number').fill(`R-${name}`);
  await page.getByLabel('Device name').fill(`${name}-Mac`);
  await page.getByRole('button', { name: 'Save' }).click();
  await page.locator('.code-input').fill(code);
  await page.getByRole('button', { name: 'Join', exact: true }).click();
  await page.getByText('Waiting for the host').waitFor({ timeout: 20_000 });
}

it('Host again over Direct (mock): code → BLE bootstrap → Wi-Fi package → OPAQUE/TLS → approve → files (host + peer) → end removes the network', async () => {
  const H = await launch();
  const host = H.page;
  host.on('dialog', (d) => d.accept());
  // an existing Study Group (hosted once on the existing network, then ended)
  await host.getByRole('button', { name: 'CLANs', exact: true }).click();
  await host.getByRole('button', { name: 'Create CLAN' }).click();
  await host.getByLabel('Name', { exact: true }).fill('OS Study Group');
  await host.getByRole('button', { name: 'Start CLAN' }).click();
  const firstCode = (await host.getByLabel('Join code').textContent())!.replace(/\D/g, '');
  await host.getByRole('button', { name: 'End CLAN' }).click();

  // Host again → Direct Network + Peer Assisted
  await host.getByRole('button', { name: 'CLANs', exact: true }).click();
  await host.locator('.clan-card', { hasText: 'OS Study Group' }).click();
  await host.getByRole('button', { name: 'Host again' }).click();
  await host.getByText('Host OS Study Group again').waitFor();
  await host.getByRole('radio', { name: /Direct Network/ }).check();
  await host.getByRole('radio', { name: /Peer Assisted/ }).check();
  await host.getByRole('button', { name: 'Host again' }).click();
  const code = (await host.getByLabel('Join code').textContent())!.replace(/\D/g, '');
  expect(code).toMatch(/^\d{6}$/);
  expect(code).not.toBe(firstCode);
  const card = host.getByTestId('direct-status');
  await expect.poll(() => card.textContent()).toMatch(/CLAN-[0-9A-Z]{4}/);
  expect(await card.textContent()).not.toMatch(/OS Study Group|Ayesha/); // SSID reveals nothing
  expect(readdirSync(radio).filter((f) => f.endsWith('.sock'))).toHaveLength(1); // BLE bootstrap advertised
  expect(existsSync(join(H.userData, 'direct-state.json'))).toBe(true);
  await host.getByRole('button', { name: 'Show QR to join' }).click();
  await host.getByRole('img', { name: 'Join this CLAN' }).waitFor();

  // member A: six digits only
  const dlA = join(scratch, 'A'), dlB = join(scratch, 'B');
  const A = await launch({ CLASSROOM_DOWNLOADS_DIR: dlA });
  await joinByCode(A.page, 'Ali', code);
  await expect.poll(() => host.locator('.timeline').textContent()).toContain('A device paired over Bluetooth');
  await host.getByRole('button', { name: 'Approve', exact: true }).click();
  await A.page.getByTestId('secure-state').waitFor({ timeout: 10_000 });
  await A.page.getByRole('button', { name: 'Details' }).click();

  const big = randomBytes(16 * 1024 * 1024);
  writeFileSync(join(scratch, 'Slides.pdf'), big);
  await chooseFiles(H.app, [join(scratch, 'Slides.pdf')]);
  await host.getByRole('button', { name: 'Add files' }).click();
  const fA = A.page.getByTestId('student-file-Slides.pdf');
  await fA.getByRole('button', { name: 'Download' }).click();
  await expect.poll(() => fA.getByTestId('file-state').textContent(), { timeout: 60_000 }).toMatch(/^Downloaded/);
  expect(sha(readFileSync(join(dlA, 'OS Study Group', 'Slides.pdf')))).toBe(sha(big));

  // member B: topology probe proves member↔member reachability, then a peer-assisted transfer
  const B = await launch({ CLASSROOM_DOWNLOADS_DIR: dlB });
  await joinByCode(B.page, 'Sara', code);
  await host.getByRole('button', { name: 'Approve', exact: true }).click();
  await B.page.getByTestId('secure-state').waitFor({ timeout: 10_000 });
  await B.page.getByRole('button', { name: 'Details' }).click();
  await expect.poll(() => card.textContent(), { timeout: 20_000 }).toContain('Peer Assistance available');
  const fB = B.page.getByTestId('student-file-Slides.pdf');
  await fB.getByRole('button', { name: 'Download' }).click();
  await expect.poll(() => fB.getByTestId('file-state').textContent(), { timeout: 60_000 }).toMatch(/^Downloaded/);
  const via = await fB.getByTestId('file-via').textContent();
  expect(via).toMatch(/1 peer/); // bytes came from member A over the (mock) Direct network
  expect(via).toContain('host-signed ✓');
  expect(sha(readFileSync(join(dlB, 'OS Study Group', 'Slides.pdf')))).toBe(sha(big));

  // end: session closed, BLE gone, network + state file removed
  await host.getByRole('button', { name: 'End CLAN' }).click();
  await B.page.getByText('The CLAN has ended.').waitFor({ timeout: 10_000 });
  await expect.poll(() => readdirSync(radio).filter((f) => f.endsWith('.sock')).length).toBe(0);
  expect(existsSync(join(H.userData, 'direct-state.json'))).toBe(false);
}, 300_000);
