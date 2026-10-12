import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ dir: '', decrypt: vi.fn(), encrypt: vi.fn((s: string) => Buffer.from(s)) }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir, isPackaged: true }, safeStorage: {
  isEncryptionAvailable: () => true, decryptString: state.decrypt, encryptString: state.encrypt,
} }));
import { Keystore, KeystoreUnavailable } from '../src/main/keystore.ts';
afterEach(() => { if (state.dir) rmSync(state.dir, { recursive: true, force: true }); vi.clearAllMocks(); });
it('preserves an existing identity byte for byte when OS decryption fails; never creates a replacement', () => {
  state.dir = mkdtempSync(join(tmpdir(), 'clan-key-qa-'));
  const store = new Keystore(), path = join(state.dir, 'keys', 'device.enc'), original = Buffer.from('disposable damaged ciphertext');
  writeFileSync(path, original); state.decrypt.mockImplementation(() => { throw new Error('Keychain unavailable'); });
  const create = vi.fn(() => 'replacement identity');
  expect(() => store.get('device', create)).toThrow(KeystoreUnavailable);
  expect(create).not.toHaveBeenCalled(); expect(state.encrypt).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(original); expect(readdirSync(join(state.dir, 'keys'))).toEqual(['device.enc']);
  expect(store.status.regenerated).toEqual([]);
  state.decrypt.mockReturnValue('restored identity');
  expect(store.get('device', create)).toBe('restored identity'); expect(create).not.toHaveBeenCalled();
});
