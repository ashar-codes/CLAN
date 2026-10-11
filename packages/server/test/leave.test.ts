import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { startClassroomServer, type RunningServer } from '../src/server.ts';
import { keyFingerprint } from '@classroom/protocol';
import { device, secureJoin, socket, tmp, trustServer, trFor } from './helpers.ts';

const servers: RunningServer[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
async function host() {
  const s = await startClassroomServer({ title: 'Leave test', host: '127.0.0.1', storageDir: tmp('leave-'), clan: { type: 'STUDY_GROUP', id: randomUUID() } });
  servers.push(s); trustServer(s); s.classroom.setPolicy('open'); return s;
}
const leave = (s: RunningServer, token: string, body: unknown = { clanId: s.classroom.clan.id }) =>
  trFor(s.url).fetch(s.url + '/api/member/leave', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('authenticated member leave', () => {
  it('revokes only the caller, disconnects WSS and refuses old token/reconnect', async () => {
    const s = await host(), da = device(), a = await secureJoin(s, 1, da), b = await secureJoin(s, 2, device());
    const w = socket(s.url, a.token); await w.opened; await w.next('hello');
    expect((await leave(s, a.token)).status).toBe(200);
    expect((await w.closed()).code).toBe(4003);
    expect(s.classroom.authenticate(a.token)).toBeNull();
    expect(s.classroom.status(b.memberId)).toBe('approved');
    expect(s.classroom.authenticate(b.token)).not.toBeNull();
    expect(() => s.classroom.reconnect(keyFingerprint(da.publicKey))).toThrow();
    expect((await leave(s, a.token)).status).toBe(401); // a lost acknowledgement cannot restore authority
  });
  it('rejects wrong CLAN and caller-selected member IDs without changing either member', async () => {
    const s = await host(), a = await secureJoin(s, 1, device()), b = await secureJoin(s, 2, device());
    expect((await leave(s, a.token, { clanId: randomUUID() })).status).toBe(403);
    expect((await leave(s, a.token, { clanId: s.classroom.clan.id, memberId: b.memberId })).status).toBe(400);
    expect(s.classroom.status(a.memberId)).toBe('approved'); expect(s.classroom.status(b.memberId)).toBe('approved');
  });
  it('rejects host, pending member and missing credentials', async () => {
    const s = await host(); s.classroom.setPolicy('approval'); const a = await secureJoin(s, 1, device());
    expect((await leave(s, s.classroom.teacherToken)).status).toBe(403);
    expect((await leave(s, a.token)).status).toBe(403);
    expect((await leave(s, 'invalid')).status).toBe(401);
    expect(s.classroom.status(a.memberId)).toBe('pending');
  });
});
