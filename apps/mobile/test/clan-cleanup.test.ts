// Filesystem contract tests use a disposable in-memory Expo adapter; native execution is a separate gate.
import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ files: new Map<string, Uint8Array>(), fenced: new Set<string>(), sequence: 0 }));
vi.mock('expo-crypto', () => ({ randomUUID: () => `test-${++state.sequence}` }));
vi.mock('../src/native', () => ({ pinnedNativeTransport: vi.fn() }));
vi.mock('../src/core/clan', () => ({ phoneClan: () => ({ clans: { cleanup: (id: string) => state.fenced.has(id) } }) }));
vi.mock('expo-file-system', () => {
  const path = (...parts: (string | { uri: string })[]) => parts.map((p) => (typeof p === 'string' ? p : p.uri).replace(/\/+$/, '')).join('/');
  class Directory {
    uri: string; constructor(...parts: (string | { uri: string })[]) { this.uri = path(...parts); }
    get exists() { return true; } create() {}
  }
  class File {
    uri: string; constructor(...parts: (string | { uri: string })[]) { this.uri = path(...parts); }
    get exists() { return state.files.has(this.uri); }
    get parentDirectory() { return new Directory(this.uri.slice(0, this.uri.lastIndexOf('/'))); }
    write(s: string) { state.files.set(this.uri, new TextEncoder().encode(s)); }
    textSync() { return new TextDecoder().decode(state.files.get(this.uri)); }
    delete() { state.files.delete(this.uri); }
    moveSync(to: File) { state.files.set(to.uri, state.files.get(this.uri)!); state.files.delete(this.uri); this.uri = to.uri; }
    open() { let offset = 0; const bytes = state.files.get(this.uri)!; return { readBytes(n: number) { const chunk = bytes.slice(offset, offset + n); offset += chunk.length; return chunk; }, close() {} }; }
  }
  return { Directory, File, Paths: { document: 'file:///private' } };
});
const { outbox, discardClanOutbox } = await import('../src/chat-outbox.ts');
const { removeSessionCopies, sha256File } = await import('../src/transfers.ts');
const root = 'file:///private/Classroom LAN';
const session = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const resource = '33333333-3333-4333-8333-333333333333';
const put = (uri: string, data: unknown) => state.files.set(uri, new TextEncoder().encode(typeof data === 'string' ? data : JSON.stringify(data)));
beforeEach(() => { state.files.clear(); state.fenced.clear(); });
it('discards only the removed CLAN Outbox and fences new/late operations', () => {
  const m = { t: 'chat.send' as const, id: 'one', thread: { kind: 'group' as const }, body: 'Hi' };
  outbox.add('a', m); outbox.add('b', { ...m, id: 'two' });
  state.fenced.add('a'); expect(outbox.list('a')).toEqual([]); expect(() => outbox.add('a', m)).toThrow();
  discardClanOutbox('a'); expect(outbox.list('b')).toHaveLength(1); expect(state.files.has('file:///private/CLAN/chat-outbox.json')).toBe(true);
});
it('retains corrupt Outbox bytes rather than silently dropping another conversation', () => {
  put('file:///private/CLAN/chat-outbox.json', '{broken'); expect(() => discardClanOutbox('a')).toThrow();
  expect(new TextDecoder().decode(state.files.get('file:///private/CLAN/chat-outbox.json'))).toBe('{broken');
});
it('removes verified scoped copies and owned partials; preserves personal, other-session and legacy bytes; retry is safe', async () => {
  const uri = `${root}/Group/a.txt`, personal = 'file:///private/personal.txt';
  put(uri, 'owned'); put(personal, 'personal'); put(`${root}/Group/.partial/${resource}.part`, 'partial'); put(`${root}/Group/.partial/legacy.part`, 'legacy');
  put(`${root}/downloads.json`, { [`${session}:${resource}`]: { uri, sha256: sha256File(uri) }, [`${other}:${resource}`]: { uri: personal, sha256: sha256File(personal) } });
  put(`${root}/download-copies.json`, { [`${session}:${resource}`]: { sessionId: session, resourceId: resource, classTitle: 'Group' } });
  expect(await removeSessionCopies([session])).toEqual({ removed: 1, retained: 0 });
  expect(state.files.has(uri)).toBe(false); expect(state.files.has(personal)).toBe(true); expect(state.files.has(`${root}/Group/.partial/legacy.part`)).toBe(true);
  expect(state.files.has(`${root}/download-copies.json`)).toBe(true); expect(await removeSessionCopies([session])).toEqual({ removed: 0, retained: 0 });
});
it('retains shared, modified and exported files', async () => {
  const shared = `${root}/Group/shared.txt`, edited = `${root}/Group/edited.txt`, external = 'file:///exports/a.txt';
  for (const uri of [shared, edited, external]) put(uri, 'keep');
  put(`${root}/downloads.json`, { [`${session}:shared`]: { uri: shared, sha256: sha256File(shared) }, [`${other}:shared`]: { uri: shared, sha256: sha256File(shared) }, [`${session}:edited`]: { uri: edited, sha256: '0'.repeat(64) }, [`${session}:external`]: { uri: external, sha256: sha256File(external) } });
  expect(await removeSessionCopies([session])).toEqual({ removed: 0, retained: 3 });
  for (const uri of [shared, edited, external]) expect(state.files.has(uri)).toBe(true);
});
it('fails closed on corrupt ownership metadata before removing any download', async () => {
  const uri = `${root}/a.txt`; put(uri, 'keep'); put(`${root}/downloads.json`, { [`${session}:${resource}`]: { uri, sha256: sha256File(uri) } }); put(`${root}/download-copies.json`, '{broken');
  await expect(removeSessionCopies([session])).rejects.toThrow(); expect(state.files.has(uri)).toBe(true);
});
