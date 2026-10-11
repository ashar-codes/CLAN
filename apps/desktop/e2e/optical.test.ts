// QR file transfer between two real app instances without any network: the receiver's camera is Chromium's fake
// capture device playing a video (Y4M) of real clan-qrx/1 frames; the sender's on-screen frames are read back from the
// page and decoded with a QR decoder. Byte-exact results are required on both paths.
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import QRCode from 'qrcode';
import jsQRImport from 'jsqr';
import { PNG } from 'pngjs';
import { encodeTransfer, QrxReceiver } from '@classroom/protocol';

type Decode = (d: Uint8ClampedArray, w: number, h: number) => { data: string } | null;
const jsQR = ((jsQRImport as unknown as { default?: Decode }).default ?? jsQRImport) as unknown as Decode;
const work = mkdtempSync(join(tmpdir(), 'clan-optical-'));
const profiles = [mkdtempSync(join(tmpdir(), 'clan-opt-a-')), mkdtempSync(join(tmpdir(), 'clan-opt-b-'))];
const apps: ElectronApplication[] = [];
afterAll(async () => { for (const a of apps) await a.close().catch(() => {}); for (const p of [...profiles, work]) rmSync(p, { recursive: true, force: true }); });

async function launch(profile: string, name: string, extra: string[] = []): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({ args: ['.', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', ...extra], cwd: join(import.meta.dirname, '..'), env: { ...process.env, CLASSROOM_USER_DATA: profile, CLAN_TEST_LOOPBACK: '1' } });
  apps.push(app);
  const page = await app.firstWindow(); await page.waitForLoadState('domcontentloaded');
  await page.evaluate((n) => (window as unknown as { classroom: { saveProfile(p: object): Promise<unknown> } }).classroom.saveProfile({ fullName: n, rollNo: 'FA23-001', deviceName: n }), name);
  return { app, page };
}
const tab = (p: Page, name: string) => p.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: new RegExp(`^.?${name}`) }).click();

/** A Y4M video (what a camera would see) of QR frames, each held for `hold` video frames. */
function y4m(path: string, texts: string[], size = 360, hold = 3) {
  const fd = openSync(path, 'w');
  writeSync(fd, `YUV4MPEG2 W${size} H${size} F30:1 Ip A1:1 C420jpeg\n`);
  const chroma = Buffer.alloc((size / 2) * (size / 2) * 2, 128);
  for (const t of texts) {
    const q = QRCode.create(t, { errorCorrectionLevel: 'L' }), n = q.modules.size, scale = Math.floor(size / (n + 8)), off = Math.floor((size - n * scale) / 2);
    const y = Buffer.alloc(size * size, 235);
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.modules.data[r * n + c]) for (let dy = 0; dy < scale; dy++) y.fill(16, (off + r * scale + dy) * size + off + c * scale, (off + r * scale + dy) * size + off + (c + 1) * scale);
    for (let h = 0; h < hold; h++) { writeSync(fd, 'FRAME\n'); writeSync(fd, y); writeSync(fd, chroma); }
  }
  closeSync(fd);
}

it('receives a file from a filmed QR stream (fake camera) and verifies it byte for byte; nothing before Accept', async () => {
  const bytes = Buffer.from('Week 6 summary: congestion control, AIMD, slow start.\n'.repeat(110)); // ~6 KB
  const tx = encodeTransfer({ bytes: new Uint8Array(bytes), name: 'week6.txt', mime: 'text/plain' }, { blockSize: 200 });
  const video = join(work, 'stream.y4m');
  y4m(video, Array.from({ length: Math.ceil(tx.minFrames * 1.6) }, (_, i) => tx.frame(i)));
  const B = await launch(profiles[1]!, 'Bilal Ahmed', [`--use-file-for-fake-video-capture=${video}`]);
  const saved = join(work, 'saved.txt');
  await B.app.evaluate(({ dialog }, s) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: s })) as never; }, saved);
  await tab(B.page, 'Nearby');
  await B.page.getByRole('button', { name: /QR file transfer/ }).click();
  const panel = B.page.getByRole('region', { name: 'QR file transfer' });
  await panel.getByRole('button', { name: 'Receive a file' }).click();
  await panel.getByRole('button', { name: 'Receive a public transfer' }).click();
  const offer = panel.getByRole('group', { name: 'Incoming transfer' });
  await offer.getByText(/week6\.txt/).waitFor({ timeout: 30_000 });
  expect(await panel.getByText(/Receiving…/).count()).toBe(0); // nothing is collected before the person accepts
  await offer.getByRole('button', { name: 'Accept' }).click();
  const got = panel.getByLabel('Received file');
  await got.getByText(/Length and SHA-256 match exactly/).waitFor({ timeout: 90_000 });
  await got.getByRole('button', { name: 'Save a copy…' }).click();
  await got.getByText(/Saved as saved\.txt/).waitFor();
  expect(readFileSync(saved)).toEqual(bytes);
  await got.getByRole('button', { name: 'Save to Inbox' }).click();
  await got.getByText('Saved to your Inbox.').waitFor();
  await got.getByRole('button', { name: 'Show receipt' }).click();
  await got.getByAltText('Receipt code for the sender').waitFor();
}, 180_000);

it('the sender shows a QR stream that decodes back to the exact file', async () => {
  const A = await launch(profiles[0]!, 'Aisha Khan');
  const src = join(work, 'diagram.bin'); const bytes = Buffer.alloc(9000); for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + 7) & 255; writeFileSync(src, bytes);
  await A.app.evaluate(({ dialog }, s) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [s] })) as never; }, src);
  await tab(A.page, 'Nearby');
  await A.page.getByRole('button', { name: /QR file transfer/ }).click();
  const panel = A.page.getByRole('region', { name: 'QR file transfer' });
  await panel.getByRole('button', { name: 'Send a file' }).click();
  await panel.getByRole('button', { name: /Anyone who scans/ }).click();
  await panel.getByRole('button', { name: '10/s' }).click();
  const rx = new QrxReceiver();
  let done = false, lastFrame = -1;
  for (let n = 0; n < 600 && !done; n++) {
    const img = panel.locator('img.qr-frame');
    const [frame, src64] = await img.evaluate((e: HTMLImageElement) => [Number(e.dataset.frame), e.src] as const);
    if (frame === lastFrame) { await A.page.waitForTimeout(40); continue; }
    lastFrame = frame;
    const png = PNG.sync.read(Buffer.from(src64.split(',')[1]!, 'base64'));
    const text = jsQR(new Uint8ClampedArray(png.data), png.width, png.height)?.data;
    if (!text) continue;
    const r = rx.push(text);
    if (r === 'meta' && !rx.progress) { expect(rx.offer).toMatchObject({ name: 'diagram.bin', size: 9000, mode: 'public' }); expect(rx.offer?.from).toBeTruthy(); rx.accept(); }
    if (r === 'done') done = true;
  }
  expect(done).toBe(true);
  expect(Buffer.from(rx.result().bytes)).toEqual(bytes);
}, 180_000);
