import { afterAll, expect, it } from 'vitest';
import { join } from 'node:path';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { createClassroomTls, startLanDirectory } from '@classroom/server';
import { startPeopleRuntime } from '../src/main/people-runtime.ts';
import { setup } from '../../../packages/clan/test/helpers.ts';
const stops: (() => unknown)[] = [];
afterAll(async () => { for (const stop of stops.reverse()) await stop(); });
async function wait(f: () => boolean) { for(let i = 0; i < 200; i++) { if(f()) return; await new Promise(r => setTimeout(r, 50)); } expect(f()).toBe(true); }
it('directory hints become verified profiles, then authenticated friends and recipient receipts; disable removes hints', async () => {
  const a = setup(), b = setup(), sa = nodeSigner(newEd25519().privatePkcs8), sb = nodeSigner(newEd25519().privatePkcs8);
  const tls = await createClassroomTls('directory runtime fixture', Date.now(), 86400000);
  const dir = await startLanDirectory({ tls, host: '127.0.0.1', allowLoopback: true, allowedKeys: new Set([sa.publicKey, sb.publicKey]) }); stops.push(() => dir.close());
  const config = { url: `https://127.0.0.1:${dir.port}`, certificate: tls.certificate, spkiSha256: tls.spkiSha256 };
  const runtimes = [];
  for(const [d, signer, host] of [[a,sa,'127.0.0.1'],[b,sb,'127.0.0.1']] as const) {
    const rt = await startPeopleRuntime({ people:d.app.people, signer, tls: await createClassroomTls('peer fixture',Date.now(),86400000), dir:join(d.storageDir,'people'), bind:host, discover:false, allowLoopback:true, endpoints:port=>[`${host}:${port}`], tickMs:150 });
    d.app.people.updateProfile({name:host}); d.app.people.setVisibility('everyone'); rt.configureDirectory(config); runtimes.push(rt); stops.push(() => rt.stop());
  }
  const [ra,rb] = runtimes as [Awaited<ReturnType<typeof startPeopleRuntime>>,Awaited<ReturnType<typeof startPeopleRuntime>>];
  expect(() => ra.configureDirectory({ ...config, certificate: 'A'.repeat(64) })).toThrow();
  expect(ra.directory().config).toEqual(config); // failed enrollment cannot replace the working directory
  await new Promise(r => setTimeout(r, 200)); ra.networkChanged(); rb.networkChanged();
  await wait(() => ra.nearby().some(n => n.key === sb.publicKey));
  expect(ra.nearby()[0]).toMatchObject({network:'Internal Network',connection:'nearby'});
  a.app.people.sendFriendRequest(sb.publicKey); await ra.tick(); await wait(() => b.app.people.contacts('requests').length === 1);
  b.app.people.acceptFriend(sa.publicKey); await rb.tick(); await wait(() => a.app.people.isFriend(sb.publicKey));
  const message = a.app.people.sendText(a.app.people.conversations()[0]!.id,'directory path'); await ra.tick();
  await wait(() => a.app.people.message(message.id)?.state === 'delivered');
  expect(b.app.people.page(message.convId).filter(m => m.id === message.id)).toHaveLength(1);
  ra.configureDirectory(null); expect(ra.nearby()).toEqual([]);
  // Disabling discovery does not terminate a healthy authenticated connection.
  expect(ra.links.connected(sb.publicKey)).toBe(true);
}, 30000);

it('an invalid saved directory certificate cannot prevent direct networking startup', async () => {
  const d = setup(), signer = nodeSigner(newEd25519().privatePkcs8);
  const rt = await startPeopleRuntime({ people:d.app.people, signer, tls:await createClassroomTls('invalid directory fixture',Date.now(),86400000), dir:join(d.storageDir,'people'), bind:'127.0.0.1', discover:false, allowLoopback:true, endpoints:port=>[`127.0.0.1:${port}`], directory:{url:'https://127.0.0.1:7000',certificate:'A'.repeat(64),spkiSha256:'B'.repeat(44)} });
  stops.push(() => rt.stop());
  expect(rt.directory().config).toBeNull(); expect(rt.directory().status).toContain('invalid');
  expect(rt.port).toBeGreaterThan(0); expect(rt.linkPort).toBeGreaterThan(0);
},30000);
