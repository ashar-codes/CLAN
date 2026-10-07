// Regression: a browser that starts long after the host's startup announcements must still find it (the responder must
// answer queries). Before the fix the responder socket was bound to the unicast address and never saw multicast queries.
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { candidateInterfaces } from '../src/index.ts';
import { advertise, browse } from '../src/discovery.ts';

const lan = candidateInterfaces().find((i) => i.private);
describe.skipIf(!lan)('mDNS discovery', () => {
  it('answers queries from late browsers (not just startup announcements)', async () => {
    const sid = randomUUID();
    const stop = advertise({ host: lan!.address, port: 45000 + Math.floor(Math.random() * 1000), sid, title: 'Late browser', type: 'STUDY_GROUP' });
    await stop.ready;
    await new Promise((r) => setTimeout(r, 6000)); // well past the announcement window
    const t = Date.now();
    const found = await new Promise<number>((res, rej) => {
      const s = browse((l) => { if (l.some((x) => x.sid === sid)) { s(); res(Date.now() - t); } });
      setTimeout(() => { s(); rej(new Error('not found within 4 s')); }, 4000);
    });
    expect(found).toBeLessThan(4000);
    await stop();
  }, 20_000);
});
