import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ dir: '', decrypt: vi.fn(), encrypt: vi.fn((s: string) => Buffer.from(s)) }));
vi.mock('electron', () => ({ app: { getPath: () => state.dir, isPackaged: true }, safeStorage: {
  isEncryptionAvailable: () => true, decryptString: state.decrypt, encryptString: state.encrypt,
} }));
import { Keystore, KeystoreUnavailable, waitForWindowsKeyMetadata } from '../src/main/keystore.ts';
afterEach(() => { if (state.dir) rmSync(state.dir, { recursive: true, force: true }); vi.clearAllMocks(); });
it('preserves an existing identity byte for byte when OS decryption fails; never creates a replacement', async () => {
  state.dir = mkdtempSync(join(tmpdir(), 'clan-key-qa-'));
  writeFileSync(join(state.dir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.alloc(32)]).toString('base64') } }));
  const store = new Keystore(), path = join(state.dir, 'keys', 'device.enc'), original = Buffer.from('disposable damaged ciphertext');
  await store.ready();
  writeFileSync(path, original); state.decrypt.mockImplementation(() => { throw new Error('Keychain unavailable'); });
  const create = vi.fn(() => 'replacement identity');
  expect(() => store.get('device', create)).toThrow(KeystoreUnavailable);
  expect(create).not.toHaveBeenCalled(); expect(state.encrypt).not.toHaveBeenCalled();
  expect(readFileSync(path)).toEqual(original); expect(readdirSync(join(state.dir, 'keys'))).toEqual(['device.enc']);
  expect(store.status.regenerated).toEqual([]);
  state.decrypt.mockReturnValue('restored identity');
  expect(store.get('device', create)).toBe('restored identity'); expect(create).not.toHaveBeenCalled();
});

it('waits for Windows wrapped-key persistence without changing its contents', async () => {
  state.dir = mkdtempSync(join(tmpdir(), 'clan-key-qa-'));
  const path = join(state.dir, 'Local State'), bytes = JSON.stringify({ os_crypt: { encrypted_key: Buffer.concat([Buffer.from('DPAPI'), Buffer.alloc(32)]).toString('base64') } });
  const waiting = waitForWindowsKeyMetadata(path, 1000);
  writeFileSync(path, bytes);
  await waiting;
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(readdirSync(state.dir)).toEqual(['Local State']);
});

it('missing or malformed Windows metadata fails closed without creating anything', async () => {
  state.dir = mkdtempSync(join(tmpdir(), 'clan-key-qa-'));
  const path = join(state.dir, 'Local State');
  await expect(waitForWindowsKeyMetadata(path, 1)).rejects.toThrow(KeystoreUnavailable);
  expect(readdirSync(state.dir)).toEqual([]);
  writeFileSync(path, '{"os_crypt":{"encrypted_key":"not protected"}}');
  await expect(waitForWindowsKeyMetadata(path, 1)).rejects.toThrow(KeystoreUnavailable);
  expect(readFileSync(path, 'utf8')).toBe('{"os_crypt":{"encrypted_key":"not protected"}}');
});
