import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ handlers: new Map<string, (...args: any[]) => void>(), expire: vi.fn(), update: vi.fn(), stop: vi.fn(), destroy: vi.fn() }));
vi.mock('bonjour-service', () => ({ Bonjour: class { find() { return { on: (event: string, fn: (...args: any[]) => void) => state.handlers.set(event, fn), expire: state.expire, update: state.update, stop: state.stop }; } destroy = state.destroy; } }));
import { browsePeople } from '../src/people-server.ts';
afterEach(() => vi.useRealTimers());
it('refreshes People addresses and TXT, expires hints, and stops all requery work', () => {
  vi.useFakeTimers(); const found: any[] = [], lost: string[] = [];
  const stop = browsePeople(s => found.push(s), r => lost.push(r));
  const base = { port: 12345, addresses: ['192.168.4.22'], txt: { v: '1', r: 'random-id-123', t: '1234567890123456' } };
  state.handlers.get('up')!(base);
  state.handlers.get('srv-update')!({ ...base, port: 23456, addresses: ['192.168.5.22'] }, base);
  state.handlers.get('txt-update')!({ ...base, txt: { ...base.txt, r: 'new-random-123' } }, base);
  expect(found.map(s => [s.addr, s.port, s.r])).toEqual([['192.168.4.22',12345,'random-id-123'], ['192.168.5.22',23456,'random-id-123'], ['192.168.4.22',12345,'new-random-123']]);
  vi.advanceTimersByTime(4000); expect(state.expire).toHaveBeenCalledTimes(1);
  state.handlers.get('down')!(base); expect(lost).toEqual(['random-id-123']);
  stop(); vi.advanceTimersByTime(8000); expect(state.update).toHaveBeenCalledTimes(1); expect(state.destroy).toHaveBeenCalledTimes(1);
});
