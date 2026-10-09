// Compiles the iOS trust code (PinnedTrust.swift — the exact file the iOS module uses) for macOS and runs it against
// a real CLAN HTTPS server. Apple's Security framework is shared by macOS and iOS; this is not a device test.
import { describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createClassroomTls, startClassroomServer } from '../../../../../packages/server/src/index.ts';

const swiftc = (() => { try { execFileSync('swiftc', ['-version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

describe.skipIf(!swiftc || process.platform !== 'darwin')('iOS pinned trust (PinnedTrust.swift on Apple Security)', () => {
  it('accepts only the PAKE-authenticated CA + leaf pin', async () => {
    const bin = join(mkdtempSync(join(tmpdir(), 'swift-')), 'pinned-trust-check');
    const dir = new URL('..', import.meta.url).pathname.replace(/%20/g, ' ');
    await promisify(execFile)('swiftc', ['-O', '-o', bin, join(dir, 'ios/PinnedTrust.swift'), join(dir, 'tests/main.swift')]);
    const s = await startClassroomServer({ title: 'x', host: '127.0.0.1' });
    try {
      const other = await createClassroomTls('other');
      const run = async (ca: string, pin: string) => (await promisify(execFile)(bin, [`${s.url}/api/resources`, ca, pin])).stdout.trim();
      expect(await run(s.tls.certificate, s.tls.spkiSha256)).toBe('ok 401'); // TLS accepted; 401 = no token sent
      expect(await run(s.tls.certificate, other.spkiSha256)).toMatch(/^rejected/);
      expect(await run(other.certificate, s.tls.spkiSha256)).toMatch(/^rejected/);
      expect(await run(other.certificate, other.spkiSha256)).toMatch(/^rejected/);
      // first contact (device linking): no anchor, reports the leaf key it saw so the link proofs can bind to it
      expect((await promisify(execFile)(bin, [`${s.url}/api/resources`, 'first-contact'])).stdout.trim()).toBe(`ok 401 ${s.tls.spkiSha256}`);
    } finally { await s.close(); }
  }, 120_000);
});
