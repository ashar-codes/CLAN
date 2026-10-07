// Milestone 2.6: the exact generated mobile OPAQUE bridge page (official @serenity-kit/opaque 1.1.0 WASM) runs in a
// real, sandboxed browser engine and completes secure pairing + join against a real classroom server.
// This exercises the bundled artifact and the bridge protocol; it is Chromium (like Android WebView), not WKWebView.
import { _electron as electron } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { OPAQUE_BRIDGE_HTML } from '../../mobile/src/generated/opaqueBridgeHtml.ts';
import { bridgedOpaqueClient } from '@classroom/client/opaque-bridge';
import { pairAndJoin, seedSigner } from '@classroom/client';
import { pinnedTransport } from '@classroom/client/node';
import { startClassroomServer } from '../../../packages/server/src/index.ts';

const cleanup: (() => Promise<unknown>)[] = [];
afterAll(async () => { for (const f of cleanup) await f(); });

it('bundled bridge page pairs with the real server (correct code joins, wrong code refused, unknown ops rejected)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
  writeFileSync(join(dir, 'bridge.html'), OPAQUE_BRIDGE_HTML);
  const app = await electron.launch({ args: [join(import.meta.dirname, 'fixtures/bridge-host.cjs')], env: { ...process.env, BRIDGE_FILE: join(dir, 'bridge.html') } });
  cleanup.push(() => app.close());
  const page = await app.firstWindow();
  const outbox = () => page.evaluate(() => (window as unknown as { __bridgeOutbox?: string[] }).__bridgeOutbox?.splice(0) ?? []);
  await expect.poll(async () => (await page.evaluate(() => JSON.stringify((window as unknown as { __bridgeOutbox?: string[] }).__bridgeOutbox ?? [])))).toContain('ready');
  await outbox();
  const bridge = bridgedOpaqueClient((msg) => { void page.evaluate((m) => window.postMessage(m, '*'), msg); });
  const seen: string[] = [];
  const pump = setInterval(async () => { for (const m of await outbox().catch(() => [])) { seen.push(m); bridge.receive(m); } }, 10);
  cleanup.push(async () => clearInterval(pump));

  const s = await startClassroomServer({ title: 'Mobile class', host: '127.0.0.1', code: '482915' });
  cleanup.push(() => s.close());
  s.classroom.setPolicy('open');
  const device = seedSigner(crypto.getRandomValues(new Uint8Array(32)));
  const j = await pairAndJoin({ candidates: [{ url: s.bootstrapUrl, sid: s.classroom.id }], code: '482915', profile: { fullName: 'Phone User', rollNo: 'P-1', deviceName: 'Pixel' }, device, opaque: bridge.client, transportFor: pinnedTransport });
  expect(j.status).toBe('approved');
  expect(j.binding.spkiSha256).toBe(s.tls.spkiSha256);
  await expect(pairAndJoin({ candidates: [{ url: s.bootstrapUrl, sid: s.classroom.id }], code: '000000', profile: { fullName: 'Phone User', rollNo: 'P-1', deviceName: 'Pixel' }, device, opaque: bridge.client, transportFor: pinnedTransport })).rejects.toMatchObject({ code: 'bad_code' });

  // The page answers only the three typed operations.
  await page.evaluate(() => { window.postMessage(JSON.stringify({ id: 99, op: 'eval', code: 'alert(1)' }), '*'); window.postMessage('not json', '*'); window.postMessage(JSON.stringify({ id: 98, op: 'finishLogin', handle: 'nope', loginResponse: 'AAAA', password: '1' }), '*'); });
  await new Promise((r) => setTimeout(r, 300));
  const replies = seen.map((m) => JSON.parse(m));
  expect(replies).toEqual(expect.arrayContaining([{ id: 99, ok: false, error: 'unsupported operation' }, { id: 98, ok: false, error: 'unknown handle' }]));
  // No network APIs reachable from the page (CSP default-src 'none').
  const net = await page.evaluate(() => fetch('https://example.com').then(() => 'reached', () => 'blocked'));
  expect(net).toBe('blocked');
}, 60_000);
