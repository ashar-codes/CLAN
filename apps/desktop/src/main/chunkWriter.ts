// Ordered, append-only writer for recording chunks (no Electron; unit-tested). Chunks are written strictly in arrival
// order, never buffered beyond the queue; the first write error stops accepting data and keeps what was written.
import { open, type FileHandle } from 'node:fs/promises';

export const LOW_DISK = 2 * 1024 ** 3, CRITICAL_DISK = 512 * 1024 ** 2;
/** What the disk watch does at a given amount of free space. */
export const diskLevel = (free: number): 'ok' | 'low' | 'critical' => (free < CRITICAL_DISK ? 'critical' : free < LOW_DISK ? 'low' : 'ok');

type Sink = Pick<FileHandle, 'write' | 'close'>;
export class ChunkWriter {
  bytes = 0; failed: string | null = null; pending = 0;
  private queue: Promise<void> = Promise.resolve();
  private sink: Sink; private onFail: (reason: string) => void;
  private constructor(sink: Sink, onFail: (reason: string) => void) { this.sink = sink; this.onFail = onFail; }
  static async open(path: string, onFail: (reason: string) => void = () => {}, sink?: Sink) { return new ChunkWriter(sink ?? await open(path, 'a'), onFail); }
  /** Returns the failure reason if the writer already stopped (the caller then stops recording). */
  append(buf: Uint8Array): string | null {
    if (this.failed) return this.failed;
    this.pending++;
    this.queue = this.queue.then(async () => {
      try { if (!this.failed) { await this.sink.write(buf); this.bytes += buf.length; } }
      catch (e) { this.failed = `write_failed: ${(e as Error).message}`; this.onFail(this.failed); }
      finally { this.pending--; }
    });
    return null;
  }
  /** Waits for every queued chunk, then closes. */
  async close() { await this.queue; await this.sink.close(); }
}
