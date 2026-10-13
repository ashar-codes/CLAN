import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ sources: [] as { options: any; handlers: Map<string, (...args: any[]) => void>; expire: any; update: any; stop: any; destroy: any }[] }));
vi.mock('bonjour-service', () => ({ Bonjour: class {
  source: (typeof state.sources)[number];
  constructor(options: any) { this.source = { options, handlers: new Map(), expire: vi.fn(), update: vi.fn(), stop: vi.fn(), destroy: vi.fn() }; state.sources.push(this.source); }
  find() { const s = this.source; return { services: [], on: (event: string, fn: (...args: any[]) => void) => s.handlers.set(event, fn), expire: s.expire, update: s.update, stop: s.stop }; }
  destroy() { this.source.destroy(); }
} }));
import { browse, type DiscoveredClassroom } from '../src/discovery.ts';
afterEach(() => { vi.useRealTimers(); state.sources.length = 0; });
const base = { port: 12345, addresses: ['192.168.4.22'], txt: { v: '1', sid: 'qa-session', a: '192.168.4.22', title: 'Original', type: 'FRIENDS' } };
it('endpoint/TXT changes reach subscribers, expired hints are checked, and shutdown stops requery', () => {
  vi.useFakeTimers(); let current: DiscoveredClassroom[] = [];
  const stop = browse(list => current = list, ['192.168.4.22']), source = state.sources[0]!;
  source.handlers.get('up')!(base); expect(current[0]?.url).toBe('http://192.168.4.22:12345');
  source.handlers.get('srv-update')!({ ...base, port: 23456 }, base); expect(current[0]?.url).toBe('http://192.168.4.22:23456');
  source.handlers.get('txt-update')!({ ...base, port: 23456, txt: { ...base.txt, title: 'Changed' } }, base); expect(current[0]?.title).toBe('Changed');
  vi.advanceTimersByTime(3000); expect(source.expire).toHaveBeenCalledTimes(1); expect(source.update).toHaveBeenCalledTimes(1);
  source.handlers.get('down')!(base); expect(current).toHaveLength(0); stop(); vi.advanceTimersByTime(6000);
  expect(source.update).toHaveBeenCalledTimes(1); expect(source.destroy).toHaveBeenCalledTimes(1);
});
it('queries each selected interface, merges real hints, and retains a peer still seen through another interface', () => {
  let current: DiscoveredClassroom[] = [];
  const stop = browse(list => current = list, ['192.168.4.22', '10.1.2.3', '192.168.4.22']);
  expect(state.sources.map(s => s.options)).toEqual([{ bind: '0.0.0.0', interface: '192.168.4.22' }, { bind: '0.0.0.0', interface: '10.1.2.3' }]);
  const [first, second] = state.sources;
  first!.handlers.get('up')!(base);
  second!.handlers.get('up')!({ ...base, addresses: ['10.1.2.4'], txt: { ...base.txt, a: '10.1.2.4' } });
  expect(current).toHaveLength(1); expect(current[0]?.alt).toContain('http://10.1.2.4:12345');
  first!.handlers.get('down')!(base); expect(current).toHaveLength(1); expect(current[0]?.url).toBe('http://10.1.2.4:12345');
  second!.handlers.get('down')!(base); expect(current).toHaveLength(0);
  stop(); for (const source of state.sources) { expect(source.stop).toHaveBeenCalledOnce(); expect(source.destroy).toHaveBeenCalledOnce(); }
});
