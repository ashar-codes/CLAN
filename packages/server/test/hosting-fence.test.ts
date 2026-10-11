// Persistent hosting: the host server fences every authoritative write on the device's current hosting epoch.
import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { JOIN_POLICY, signHostStatement, type AuthorityRecord } from '@classroom/protocol';
import { startClassroomServer, type RunningServer, type ServerOptions } from '../src/index.ts';
import { device, secureJoin, socket, tmp, trFor, trustServer } from './helpers.ts';

const servers: RunningServer[] = [];
afterEach(async () => { await Promise.all(servers.splice(0).map((s) => s.close())); });

function authority(clanId: string) {
  const owner = device();
  const genesis: AuthorityRecord = signHostStatement(owner, { type: 'clan-host-authority' as const, v: 1 as const, clanId, ownerKey: owner.publicKey, epoch: 0, hostKey: owner.publicKey, prevHash: null, checkpointHash: null, delegation: null, ack: null, issuedAt: 1 });
  const state = { writable: true };
  return { state, genesis, assertWritable: () => { if (!state.writable) throw new Error('Hosting is paused for a handoff.'); } };
}
async function host(o: Partial<ServerOptions> & { clanId: string }) {
  const s = await startClassroomServer({ title: 'Fenced', host: '127.0.0.1', storageDir: tmp('fence-'), clan: { type: 'STUDY_GROUP', id: o.clanId, expiresAt: null }, ...o });
  servers.push(s); trustServer(s);
  return s;
}

describe('host-epoch fencing', () => {
  it('refuses to start a session for a CLAN this device does not currently host', async () => {
    const clanId = randomUUID(), a = authority(clanId);
    a.state.writable = false;
    await expect(startClassroomServer({ title: 'x', host: '127.0.0.1', storageDir: tmp('fence-'), clan: { type: 'STUDY_GROUP', id: clanId, expiresAt: null }, authority: a })).rejects.toThrow('paused');
  });

  it('fences joins, HTTP writes and WebSocket control messages; reads and ephemeral relays continue; genesis reaches members', async () => {
    const clanId = randomUUID(), a = authority(clanId);
    const s = await host({ clanId, authority: a });
    s.classroom.setPolicy(JOIN_POLICY.CODE_ONLY);
    const j = await secureJoin(s, 1);
    expect(j.status).toBe('approved');
    const w = socket(s.url, j.token); await w.opened;
    const hello = await w.next('hello');
    expect(hello.classroom.authority).toEqual(a.genesis); // inside the authenticated session only
    const h = socket(s.url, s.classroom.teacherToken); await h.opened; await h.next('hello');

    a.state.writable = false; // e.g. paused for a hand-over, or the delegation was revoked
    h.send({ t: 'class.lock', locked: true });
    expect(await h.next('error')).toMatchObject({ code: 'host_unavailable' });
    expect(s.classroom.info().locked).toBe(false);
    w.send({ t: 'hand.set', raised: true });
    expect(await w.next('error')).toMatchObject({ code: 'host_unavailable' });
    await expect(secureJoin(s, 2)).rejects.toThrow(/paused|503|host_unavailable/i);
    const leave = await trFor(s.url).fetch(`${s.url}/api/member/leave`, { method: 'POST', headers: { authorization: `Bearer ${j.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ clanId }) });
    expect(leave.status).toBe(503); // reported to the member as unconfirmed; retried against the current host
    expect((await trFor(s.url).fetch(`${s.url}/api/resources`, { headers: { authorization: `Bearer ${j.token}` } })).status).toBe(200); // reads continue
    w.send({ t: 'ping', n: 1 });
    expect(await w.next('pong')).toMatchObject({ n: 1 }); // liveness is not a durable write

    a.state.writable = true; // resumed before relinquishing
    h.send({ t: 'class.lock', locked: true });
    for (let i = 0; i < 50 && !s.classroom.info().locked; i++) await new Promise((r) => setTimeout(r, 10));
    expect(s.classroom.info().locked).toBe(true);
    w.close(); h.close();
  });

  it('legacy CLANs without an authority record are unchanged', async () => {
    const s = await host({ clanId: randomUUID() });
    s.classroom.setPolicy(JOIN_POLICY.CODE_ONLY);
    const j = await secureJoin(s, 1);
    const w = socket(s.url, j.token); await w.opened;
    expect((await w.next('hello')).classroom.authority).toBeUndefined();
    w.close();
  });
});
