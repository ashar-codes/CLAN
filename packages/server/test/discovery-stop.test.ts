import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ destroy: vi.fn(), unpublish: vi.fn() }));
vi.mock('bonjour-service', () => ({ Bonjour: class {
  publish() { return new EventEmitter(); }
  unpublishAll(cb: () => void) { state.unpublish(cb); }
  destroy() { state.destroy(); }
} }));
import { advertise } from '../src/discovery.ts';
it('closes discovery once when a removed interface never acknowledges goodbye; repeated stop is idempotent', async () => {
  vi.useFakeTimers();
  try {
    const stop = advertise({ host: '192.168.1.20', port: 45000, sid: 'qa-stop', title: 'Disposable', type: 'STUDY_GROUP' });
    const first = stop(), second = stop();
    expect(first).toBe(second); expect(state.destroy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1500); await first;
    expect(state.destroy).toHaveBeenCalledTimes(1); expect(state.unpublish).toHaveBeenCalledTimes(1);
  } finally { vi.useRealTimers(); }
});
