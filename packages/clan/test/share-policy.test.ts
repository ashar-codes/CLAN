// Classroom sharing is host-authorized; verified bytes remain private until teacher approval.
import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { openDb, startClassroomServer, type RunningServer } from '@classroom/server';
import type { ShareUploadStatus } from '@classroom/protocol';
import { device, secureJoin, socket, tmp, trustServer, trFor } from '../../server/test/helpers.ts';
import { openClan } from '../src/index.ts';

const servers: RunningServer[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); });
async function setup(type: 'CLASSROOM' | 'STUDY_GROUP' = 'CLASSROOM') {
  const db = openDb(':memory:'), storageDir = tmp('share-policy-');
  const core = openClan(db, { storageDir });
  const clanId = core.clans.create({ type, name: 'Sharing', createdBy: core.me }).id;
  const s = await startClassroomServer({ title: 'Sharing', host: '127.0.0.1', db, storageDir, chat: core.chat, clan: { type, id: clanId } });
  servers.push(s); trustServer(s); s.classroom.setPolicy('open');
  const a = await secureJoin(s, 1, device());
  const bytes = Buffer.from('verified classroom document');
  const req = { fileName: 'notes.txt', size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), to: 'clan', idempotencyKey: randomUUID() };
  const upload = async () => { const u = await s.shares.init(a.memberId, req); return s.shares.append(a.memberId, u.uploadId, 0, Readable.from(bytes)); };
  return { s, a, bytes, req, upload };
}
describe('Classroom student sharing policy', () => {
  it('defaults to teacher-only; a student cannot grant permission through WSS', async () => {
    const { s, a, req } = await setup();
    await expect(s.shares.init(a.memberId, req)).rejects.toThrow(/cannot share/i);
    const w = socket(s.url, a.token); await w.opened; await w.next('hello');
    w.send({ t: 'class.filePolicy', policy: 'everyone' });
    expect((await w.next('error')).code).toBe('forbidden');
    expect(s.classroom.info().fileSharingPolicy).toBe('teacher');
  });
  it('everyone publishes verified bytes; other CLAN types keep existing permissions', async () => {
    const { s, upload } = await setup(); s.classroom.setFilePolicy('everyone');
    expect((await upload()).resource?.status).toBe('ready');
    const group = await setup('STUDY_GROUP');
    expect((await group.upload()).resource?.status).toBe('ready');
    expect(() => group.s.classroom.setFilePolicy('teacher')).toThrow(/Classroom/i);
  });
  it('quarantines approval shares, rejects member moderation, and approves exactly once', async () => {
    const { s, a, upload } = await setup(); s.classroom.setFilePolicy('approval');
    const u = await upload(); expect(u).toMatchObject({ state: 'complete', approval: 'pending', resource: null });
    expect(s.resources.listForTeacher()).toHaveLength(0);
    expect(s.resources.listForStudent({ role: 'student', memberId: a.memberId })).toHaveLength(0);
    expect(s.shares.pending({ role: 'teacher' })).toHaveLength(1);
    expect(() => s.shares.pending({ role: 'student', memberId: a.memberId })).toThrow(/host/i);
    await expect(s.shares.decide({ role: 'student', memberId: a.memberId }, u.uploadId, true)).rejects.toThrow(/host/i);
    const approved = await s.shares.decide({ role: 'teacher' }, u.uploadId, true);
    const repeated = await s.shares.decide({ role: 'teacher' }, u.uploadId, true);
    expect(repeated.resource?.id).toBe(approved.resource?.id);
    expect((await s.shares.status(a.memberId, u.uploadId)).approval).toBe('approved');
    expect(s.resources.listForTeacher()).toHaveLength(1);
  });
  it('rechecks removal and policy changes before publishing; rejected bytes stay unpublished', async () => {
    const { s, a, upload } = await setup(); s.classroom.setFilePolicy('approval');
    const u = await upload(); s.classroom.setStatus(a.memberId, 'removed');
    await expect(s.shares.decide({ role: 'teacher' }, u.uploadId, true)).rejects.toThrow(/approved/i);
    await s.shares.decide({ role: 'teacher' }, u.uploadId, false);
    expect(s.resources.listForTeacher()).toHaveLength(0);
    const other = await setup(); other.s.classroom.setFilePolicy('everyone');
    const started = await other.s.shares.init(other.a.memberId, other.req);
    other.s.classroom.setFilePolicy('approval');
    const held: ShareUploadStatus = await other.s.shares.append(other.a.memberId, started.uploadId, 0, Readable.from(other.bytes));
    expect(held.resource).toBeNull();
    expect(held.approval).toBe('pending');
  });
  it('a corrupt file and an unknown approval ID never create a visible resource', async () => {
    const { s, a, req } = await setup(); s.classroom.setFilePolicy('approval');
    const u = await s.shares.init(a.memberId, req);
    await expect(s.shares.append(a.memberId, u.uploadId, 0, Readable.from(Buffer.alloc(req.size)))).rejects.toThrow(/checksum/i);
    await expect(s.shares.decide({ role: 'teacher' }, randomUUID(), true)).rejects.toThrow(/upload/i);
    expect(s.resources.listForTeacher()).toHaveLength(0);
  });
  it('checks actual HTTP moderation credentials and session scope', async () => {
    const { s, a, upload } = await setup(); s.classroom.setFilePolicy('approval');
    const u = await upload(), t = trFor(s.url);
    const request = (path: string, token: string, accept?: boolean) => t.fetch(s.url + path, { method: accept === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(accept === undefined ? {} : { body: JSON.stringify({ accept }) }) });
    expect((await request('/api/shares/pending', a.token)).status).toBe(403);
    expect((await request(`/api/shares/${u.uploadId}/review`, a.token, true)).status).toBe(403);
    expect((await request(`/api/shares/${u.uploadId}/review`, 'untrusted-token-123456', true)).status).toBe(401);
    expect((await request('/api/shares/pending', s.classroom.teacherToken)).status).toBe(200);
    const other = await setup();
    await expect(other.s.shares.decide({ role: 'teacher' }, u.uploadId, true)).rejects.toThrow(/upload/i);
    expect((await request(`/api/shares/${u.uploadId}/review`, s.classroom.teacherToken, true)).status).toBe(200);
  });
  it('fences a sender removed during the asynchronous import before the file becomes ready', async () => {
    const { s, a, upload } = await setup(); s.classroom.setFilePolicy('everyone');
    let removed = false;
    s.resources.on('progress', () => { if (!removed) { removed = true; s.classroom.setStatus(a.memberId, 'removed'); } });
    await expect(upload()).rejects.toThrow(/approved/i);
    expect(removed).toBe(true);
    expect(s.resources.listForStudent({ role: 'student', memberId: a.memberId })).toHaveLength(0);
    expect(s.resources.listForTeacher().every((r) => r.status !== 'ready')).toBe(true);
  });
});
