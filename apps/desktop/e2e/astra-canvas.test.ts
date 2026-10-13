import { _electron as electron } from 'playwright-core';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { BOARD_CANVAS_HTML } from '../../mobile/src/generated/boardCanvasHtml';

it('mobile canvas renders thousands of strokes, preserves marks, culls and clears its preview', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'clan-canvas-'));
  writeFileSync(join(dir, 'board.html'), BOARD_CANVAS_HTML);
  const app = await electron.launch({ args: [join(import.meta.dirname, 'fixtures/bridge-host.cjs')], env: { ...process.env, BRIDGE_FILE: join(dir, 'board.html') } });
  try {
    const p = await app.firstWindow(); await p.waitForLoadState(); await p.bringToFront();
    const result = await p.evaluate(async () => {
      const send = async (frame: object) => { window.postMessage(JSON.stringify(frame), '*'); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); };
      const base = { vp: { x: 0, y: 0, z: 1 }, selected: null, erased: [], moving: null, draft: null };
      const objects = Array.from({ length: 5000 }, (_, i) => ({ id: String(i), kind: 'stroke', page: 0, x: (i % 100) * 30, y: Math.floor(i / 100) * 30, w: 0, h: 0, color: '#17233b', width: 3, z: i, points: [[0, 0], [20, 10], [25, 0]] }));
      await send({ ...base, objects });
      const cv = document.querySelector<HTMLCanvasElement>('#committed')!, preview = document.querySelector<HTMLCanvasElement>('#preview')!;
      const before = cv.toDataURL();
      const perf = (window as unknown as { __clanBoardPerf: { drawn: number; objects: number } }).__clanBoardPerf;
      await send({ ...base, draft: { ...objects[0], x: 50, y: 50 } });
      const unchanged = cv.toDataURL() === before;
      const hasPreview = preview.getContext('2d')!.getImageData(0, 0, preview.width, preview.height).data.some((n, i) => i % 4 === 3 && n > 0);
      await send(base);
      const cleared = !preview.getContext('2d')!.getImageData(0, 0, preview.width, preview.height).data.some((n, i) => i % 4 === 3 && n > 0);
      await send({ ...base, objects: [] });
      const erased = !cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data.some((n, i) => i % 4 === 3 && n > 0);
      await send({ ...base, upsert: [objects[1]] });
      const deltaAdded = cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data.some((n, i) => i % 4 === 3 && n > 0);
      await send({ ...base, remove: ['1'] });
      const deltaRemoved = !cv.getContext('2d')!.getImageData(0, 0, cv.width, cv.height).data.some((n, i) => i % 4 === 3 && n > 0);
      return { perf, unchanged, hasPreview, cleared, erased, deltaAdded, deltaRemoved, canvases: document.querySelectorAll('canvas').length };
    });
    expect(result.perf.objects).toBe(5000); expect(result.perf.drawn).toBeGreaterThan(0); expect(result.perf.drawn).toBeLessThan(5000);
    expect(result).toMatchObject({ unchanged: true, hasPreview: true, cleared: true, erased: true, deltaAdded: true, deltaRemoved: true, canvases: 2 });
  } finally { await app.close(); }
});
