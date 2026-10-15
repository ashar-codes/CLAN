// Real-network discovery matrix (docs/DISCOVERY_RELIABILITY_VERIFICATION.md). Opt-in: CLAN_DISCOVERY_MATRIX=1.
// Everything runs over this machine's real LAN interface: real multicast DNS-SD, real TCP/TLS, real clan-link/1,
// independent identities and databases per participant. Nothing uses loopback addresses or test-only shortcuts.
// Latencies are written to CLAN_DISCOVERY_RESULTS (JSON) for the verification document.
import { afterAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import * as opaque from '@serenity-kit/opaque';
import { createClassroomTls, lanAddresses, startClassroomServer, type RunningServer } from '@classroom/server';
import { browse } from '@classroom/server/discovery';
import { newEd25519, nodeSigner, pinnedTransport } from '@classroom/client/node';
import { pairAndJoin } from '@classroom/client';
import { startPeopleRuntime } from '../../../apps/desktop/src/main/people-runtime.ts';
import { device, profile, trustServer } from '../../server/test/helpers.ts';
import { setup } from './helpers.ts';

const lan = lanAddresses()[0]?.address;
const N = Number(process.env.CLAN_DISCOVERY_RUNS ?? 8);
const results: Record<string, number[]> = {};
const record = (k: string, ms: number) => { (results[k] ??= []).push(Math.round(ms)); };
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => {
  for (const s of stops.splice(0)) await s().catch(() => {});
  if (process.env.CLAN_DISCOVERY_RESULTS) writeFileSync(process.env.CLAN_DISCOVERY_RESULTS, JSON.stringify({ lan, runs: N, results }, null, 2));
});
const until = async (f: () => boolean, ms: number) => { const t = performance.now(); while (!f()) { if (performance.now() - t > ms) return -1; await new Promise((r) => setTimeout(r, 25)); } return performance.now() - t; };

/** A person exactly as a fresh install leaves them: onboarding name + device, default visibility (Everyone Nearby). */
async function person(name: string, base?: ReturnType<typeof setup>, signer = nodeSigner(newEd25519().privatePkcs8)) {
  const d = base ?? setup(), tls = await createClassroomTls(`m-${name}`, Date.now(), 1e10);
  d.app.people.setSigner(signer); d.app.people.adoptIdentity(name, `${name}-device`);
  const rt = await startPeopleRuntime({ people: d.app.people, signer, tls, dir: join(d.storageDir, 'people'), discover: true, endpoints: (port) => [`${lan}:${port}`], tickMs: 400 });
  let stopped = false; const stop = async () => { if (!stopped) { stopped = true; await rt.stop(); } };
  stops.push(stop);
  return { d, p: d.app.people, rt, key: signer.publicKey, signer, stop };
}
const me = () => { const d = device(); return { profile: profile(1, d), device: d }; };
const sees = (x: Awaited<ReturnType<typeof person>>, y: Awaited<ReturnType<typeof person>>) => x.rt.nearby().some((n) => n.key === y.key);

describe.runIf(process.env.CLAN_DISCOVERY_MATRIX === '1' && !!lan)(`discovery on ${lan}`, () => {
  it(`fresh ↔ fresh: mutual discovery, friend request without QR, authenticated (${N} runs)`, async () => {
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const a = await person(`A${i}`);
      // the second device starts later (it arrives on the network after the first one is already browsing)
      await new Promise((r) => setTimeout(r, i % 2 ? 1500 : 0));
      const b = await person(`B${i}`);
      const both = await until(() => sees(a, b) && sees(b, a), 20_000);
      expect(both, `run ${i}: mutual discovery`).toBeGreaterThanOrEqual(0);
      record('people.mutualDiscoveryMs', both); record('people.fromFirstStartMs', performance.now() - t0);
      expect(a.rt.nearby().find((n) => n.key === b.key)?.name).toBe(`B${i}`);
      const t1 = performance.now();
      a.p.sendFriendRequest(b.key); await a.rt.tick();
      expect(await until(() => b.p.contacts('requests').some((c) => c.key === a.key), 10_000)).toBeGreaterThanOrEqual(0);
      b.p.acceptFriend(a.key); await b.rt.tick();
      expect(await until(() => a.p.isFriend(b.key) && b.p.isFriend(a.key), 10_000)).toBeGreaterThanOrEqual(0);
      record('people.friendRequestToFriendsMs', performance.now() - t1);
      await a.stop(); await b.stop();
    }
  }, 600_000);

  it('Friends Only is not visible to strangers; Invisible disappears; blocked never sees; restart keeps identity; network change rediscovers', async () => {
    const a = await person('Visible'), b = await person('Watcher'), c = await person('Private');
    c.p.setVisibility('friends'); await c.rt.refreshDiscovery();
    expect(await until(() => sees(b, a), 20_000)).toBeGreaterThanOrEqual(0);
    await new Promise((r) => setTimeout(r, 6000)); // several advert/probe rounds
    expect(sees(b, c)).toBe(false); expect(sees(a, c)).toBe(false); // Friends Only: strangers never see a profile
    // blocking stops contact. (Discovery probes are anonymous by design, so while `a` is Everyone Nearby a blocked
    // person sees `a` like any stranger would; Friends Only / Invisible hide from everyone.)
    a.p.block(b.key);
    b.p.sendFriendRequest(a.key); await b.rt.tick(); await new Promise((r) => setTimeout(r, 3000)); await b.rt.tick();
    expect(a.p.contacts('requests').some((x) => x.key === b.key)).toBe(false);
    expect(b.p.contacts('requests').find((x) => x.key === a.key)?.relation).toBe('outgoing'); // never accepted
    a.p.unblock(b.key);
    // Invisible
    a.p.setVisibility('invisible'); await a.rt.refreshDiscovery();
    expect(await until(() => !sees(b, a), 25_000)).toBeGreaterThanOrEqual(0);
    a.p.setVisibility('everyone'); await a.rt.refreshDiscovery(); b.rt.networkChanged();
    record('people.reappearAfterVisibleMs', await until(() => sees(b, a), 20_000));
    expect(sees(b, a)).toBe(true);
    // restart without identity loss (same database and key)
    const key = a.key; await a.stop();
    const a2 = await person('Visible', a.d, a.signer);
    expect(a2.key).toBe(key);
    b.rt.networkChanged();
    const back = await until(() => b.rt.nearby().some((n) => n.key === key), 20_000);
    expect(back).toBeGreaterThanOrEqual(0); record('people.rediscoverAfterRestartMs', back);
    // a network change (interfaces re-read, browsers/adverts recreated) recovers discovery
    a2.rt.networkChanged(); b.rt.networkChanged();
    const t = await until(() => b.rt.nearby().some((n) => n.key === key), 20_000);
    expect(t).toBeGreaterThanOrEqual(0); record('people.rediscoverAfterNetworkChangeMs', t);
    expect(a2.rt.diagnostics().state.advertising).toBe(true);
    expect(b.rt.diagnostics().state.probesOk).toBeGreaterThan(0);
  }, 300_000);

  it(`live CLAN appears without QR (browser before and after host), code join + approval (${N} runs)`, async () => {
    await opaque.ready;
    for (let i = 0; i < N; i++) {
      let list: { sid: string; url: string; alt?: string[] }[] = [];
      const browserFirst = i % 2 === 0;
      let stopBrowse = browserFirst ? browse((l) => { list = l; }) : null;
      if (browserFirst) await new Promise((r) => setTimeout(r, 1000));
      const t0 = performance.now();
      const host: RunningServer = await startClassroomServer({ title: `Matrix ${i}`, host: lan!, code: '482915', advertise: true });
      stops.push(() => host.close()); trustServer(host);
      host.classroom.setPolicy('approval');
      stopBrowse ??= browse((l) => { list = l; });
      const seen = await until(() => list.some((c) => c.sid === host.classroom.id), 20_000);
      expect(seen, `run ${i}: CLAN appeared`).toBeGreaterThanOrEqual(0);
      record(browserFirst ? 'clan.appearBrowserFirstMs' : 'clan.appearHostFirstMs', performance.now() - t0);
      const t1 = performance.now();
      const joined = await pairAndJoin({ candidates: list, candidatesNow: () => list, discoveryWindowMs: 9000, ...me(), code: '482915', opaque: opaque.client, transportFor: pinnedTransport });
      record('clan.codeJoinMs', performance.now() - t1);
      expect(joined.status).toBe('pending'); // approval required
      const member = host.classroom.roster()[0]!;
      host.classroom.setStatus(member.id, 'approved');
      expect(host.classroom.status(member.id)).toBe('approved');
      // a wrong code is reported as a wrong code, not as "no CLAN"
      await expect(pairAndJoin({ candidates: list, candidatesNow: () => list, discoveryWindowMs: 3000, ...me(), code: '111111', opaque: opaque.client, transportFor: pinnedTransport })).rejects.toMatchObject({ code: 'bad_code' });
      stopBrowse(); await host.close();
    }
  }, 900_000);

  it('a network that blocks multicast: no CLAN is invented, the error says so, and the host address fallback works', async () => {
    await opaque.ready;
    const host = await startClassroomServer({ title: 'No multicast', host: lan!, code: '246810', advertise: false }); // nothing reaches browsers
    stops.push(() => host.close()); trustServer(host);
    let list: { sid: string; url: string }[] = [];
    const stop = browse((l) => { list = l; });
    await new Promise((r) => setTimeout(r, 4000));
    expect(list.some((c) => c.sid === host.classroom.id)).toBe(false);
    await expect(pairAndJoin({ candidates: [], candidatesNow: () => list, discoveryWindowMs: 1500, ...me(), code: '246810', opaque: opaque.client, transportFor: pinnedTransport })).rejects.toMatchObject({ code: 'none_found' });
    const t = performance.now();
    const joined = await pairAndJoin({ candidates: [{ url: host.bootstrapUrl }], ...me(), code: '246810', opaque: opaque.client, transportFor: pinnedTransport });
    record('clan.manualAddressJoinMs', performance.now() - t);
    expect(['approved', 'pending']).toContain(joined.status);
    stop();
  }, 120_000);
});
