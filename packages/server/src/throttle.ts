/**
 * Sliding-window failure counter with lockout. Used against join-code guessing.
 * ponytail: in-memory only; a teacher-app restart resets counters, which also rotates the join code.
 */
export class Throttle {
  private hits = new Map<string, { fails: number[]; lockedUntil: number }>();
  private maxFails: number; private windowMs: number; private lockMs: number; private now: () => number;
  constructor(maxFails: number, windowMs: number, lockMs: number, now = () => Date.now()) {
    this.maxFails = maxFails; this.windowMs = windowMs; this.lockMs = lockMs; this.now = now;
  }

  /** ms remaining in lockout, 0 if allowed. */
  lockedFor(key: string): number {
    const e = this.hits.get(key);
    return e ? Math.max(0, e.lockedUntil - this.now()) : 0;
  }

  fail(key: string): void {
    const t = this.now();
    const e = this.hits.get(key) ?? { fails: [], lockedUntil: 0 };
    e.fails = e.fails.filter((f) => t - f < this.windowMs);
    e.fails.push(t);
    if (e.fails.length >= this.maxFails) {
      e.lockedUntil = t + this.lockMs;
      e.fails = [];
    }
    this.hits.set(key, e);
    if (this.hits.size > 10_000) this.prune();
  }

  /** Undo the most recent failure for `key` (a pairing attempt that turned out to be legitimate). */
  forgive(key: string): void {
    this.hits.get(key)?.fails.pop();
  }

  private prune() {
    const t = this.now();
    for (const [k, e] of this.hits) if (e.lockedUntil < t && e.fails.every((f) => t - f >= this.windowMs)) this.hits.delete(k);
  }
}
