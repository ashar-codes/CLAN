import { expect, it } from 'vitest';
import { b64u, type SecureLink } from '@classroom/protocol';
import { LinkSession, type LinkFiles } from '../src/modules/people/link.ts';
import type { People } from '../src/modules/people/index.ts';

it.each(['offset', 'oversize', 'later-invalid', 'wrong-type'])('rejects %s file replies before writing any part bytes', async (fault) => {
  let incoming: (b: Uint8Array) => void = () => {}, closed = false;
  let onClosed = () => {};
  const writes: Uint8Array[] = [];
  let answered = false;
  const link: SecureLink = {
    peerKey: 'peer', role: 'initiator', get closed() { return closed; },
    onMessage(cb) { incoming = cb; }, onClose(cb) { onClosed = cb; }, close() { closed = true; onClosed(); },
    send(raw) {
      const m = JSON.parse(new TextDecoder().decode(raw));
      if (m.t !== 'get') return;
      const r = { t: 'data', id: m.id, offset: fault === 'offset' ? 1 : 0,
        chunks: fault === 'oversize' ? [b64u.encode(new Uint8Array(9))] : fault === 'later-invalid' ? [b64u.encode(new Uint8Array(4)), {}] : [b64u.encode(new Uint8Array(8))] };
      if (fault === 'wrong-type') r.t = 'res';
      incoming(new TextEncoder().encode(JSON.stringify(r))); answered = true;
    },
  };
  const p = { profileFor: () => ({ profile: null }), due: () => [], pendingDownloads: () => [{ id: 'file', peerKey: 'peer', size: 8 }], progress: () => { throw new Error('Unexpected progress'); } } as unknown as People;
  const files: LinkFiles = { partPath: () => 'part', size: async () => 0, read: async () => new Uint8Array(), remove: async () => {}, append: async (_, b) => { writes.push(b); } };
  const session = new LinkSession(p, link, files, { myAddrs: () => [] });
  await session.flush();
  await new Promise((r) => setTimeout(r, 10));
  link.close();
  expect(answered).toBe(true);
  expect(writes).toEqual([]);
});
