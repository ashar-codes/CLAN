// Study Tape write path: long recordings stream to disk in order without memory growing with length; a disk failure
// stops cleanly and keeps what was written; the disk watch thresholds.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChunkWriter, CRITICAL_DISK, diskLevel, LOW_DISK } from '../src/main/chunkWriter.ts';

describe('ChunkWriter', () => {
  it('streams a long recording (≈2 h of 1 s chunks) to disk in order, with flat memory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cw-'));
    try {
      const w = await ChunkWriter.open(join(dir, 't.webm.part'));
      const chunk = (i: number) => { const b = new Uint8Array(16 * 1024); b.fill(i % 251); new DataView(b.buffer).setUint32(0, i); return b; };
      global.gc?.(); const h0 = process.memoryUsage().heapUsed;
      for (let i = 0; i < 7200; i++) { expect(w.append(chunk(i))).toBeNull(); if (i % 100 === 99) while (w.pending > 8) await new Promise((r) => setTimeout(r, 1)); }
      await w.close();
      const growthMB = (process.memoryUsage().heapUsed - h0) / 1e6;
      expect(w.bytes).toBe(7200 * 16 * 1024);
      expect(statSync(join(dir, 't.webm.part')).size).toBe(w.bytes);
      const file = readFileSync(join(dir, 't.webm.part'));
      for (const i of [0, 1, 3599, 7199]) expect(file.readUInt32BE(i * 16 * 1024)).toBe(i); // strictly in order
      expect(growthMB).toBeLessThan(40); // 112 MB written; memory does not grow with it
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('a write failure (disk full) stops accepting data, reports once, keeps what was written', async () => {
    const written: number[] = []; let n = 0, reported: string[] = [];
    const sink = { write: async (b: Uint8Array) => { if (++n > 3) throw new Error('ENOSPC: no space left on device'); written.push(b.length); return { bytesWritten: b.length, buffer: b } as never; }, close: async () => {} };
    const w = await ChunkWriter.open('unused', (r) => reported.push(r), sink as never);
    for (let i = 0; i < 6; i++) w.append(new Uint8Array(10));
    await w.close();
    expect(w.bytes).toBe(30);
    expect(w.failed).toMatch(/ENOSPC/);
    expect(reported).toHaveLength(1);
    expect(w.append(new Uint8Array(10))).toMatch(/write_failed/); // the recorder stops on this
    expect(written).toEqual([10, 10, 10]);
  });

  it('disk watch: warn under 2 GB, stop and save under 512 MB', () => {
    expect(diskLevel(10 * 1024 ** 3)).toBe('ok');
    expect(diskLevel(LOW_DISK - 1)).toBe('low');
    expect(diskLevel(CRITICAL_DISK - 1)).toBe('critical');
  });
});
