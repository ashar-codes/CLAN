import { beforeEach, expect, it, vi } from 'vitest';
const native = vi.hoisted(() => ({ listen: vi.fn(), stop: vi.fn(), advertise: vi.fn(), browse: vi.fn(), bump: vi.fn() }));
vi.mock('react-native', () => ({ AppState: { currentState: 'active' }, Platform: { OS: 'android' }, PermissionsAndroid: {} }));
vi.mock('expo-notifications', () => ({}));
vi.mock('expo-crypto', () => ({ getRandomBytes: (n: number) => new Uint8Array(n).fill(1) }));
vi.mock('expo-file-system', () => ({ Directory: class { exists = true; }, File: class { exists = false; write() {} }, FileMode: {}, Paths: { document: '/disposable' } }));
vi.mock('../src/people/directory', () => ({ initializeDirectory: vi.fn(), refreshDirectory: vi.fn() }));
vi.mock('../src/core/clan', () => ({ phoneClan: () => ({ people: { visibility: () => 'friends', presenceTagFor: () => '', contacts: () => [] } }) }));
vi.mock('../src/ui/kit', () => ({ bump: native.bump }));
vi.mock('../modules/peer-link', () => ({ capabilities: () => null, listen: native.listen, stopListening: native.stop, nativeLinkTransport: {}, PeerLink: { browse: native.browse, advertise: native.advertise, stopAdvertise: vi.fn(), stopBrowse: vi.fn(), p2pStop: vi.fn(), awareStop: vi.fn(), availabilityStop: vi.fn(), availabilityRunning: () => false } }));
import { nearby } from '../src/people/nearby';
beforeEach(() => { nearby.stop(); vi.clearAllMocks(); nearby.cm = { accept: vi.fn(), connected: () => false } as never; });
it('coalesces concurrent listener startup and prevents stopped initialization from resurrecting discovery', async () => {
  let ready!: (port: number) => void; native.listen.mockImplementationOnce(() => new Promise<number>(r => ready = r));
  const first = nearby.start(), second = nearby.start(); expect(second).toBe(first); expect(native.listen).toHaveBeenCalledTimes(1);
  nearby.stop(); ready(12345); await first;
  expect(nearby.port).toBe(0); expect(native.advertise).not.toHaveBeenCalled(); expect(native.browse).not.toHaveBeenCalled();
});
it('starts after the stopped generation settles and clears truthful listener status on stop', async () => {
  native.listen.mockResolvedValueOnce(23456); await nearby.start(); expect(nearby.port).toBe(23456);
  expect(native.advertise).toHaveBeenCalledTimes(1); expect(native.browse).toHaveBeenCalledTimes(1);
  nearby.stop(); expect(nearby.port).toBe(0);
});
