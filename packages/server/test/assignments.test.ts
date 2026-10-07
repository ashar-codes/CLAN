import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { initUpload, uploadStatus } from '@classroom/client';
import { downloadResource, sha256File, uploadSubmission } from '@classroom/client/node';
import { UPLOAD_CONTENT_TYPE, type AssignmentInput, type TeacherAssignmentView, type UploadInit } from '@classroom/protocol';
import { hashFile, startClassroomServer, type RunningServer } from '../src/index.ts';
import { classWith, cuttingProxy, makeFile, socket, tmp } from './helpers.ts';
import { trFor, trustServer, secureJoin } from './helpers.ts';

const servers: RunningServer[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((f) => f()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
async function setup(n = 1, opts = {}) {
  const r = await classWith(n, opts);
  servers.push(r.s);
  return r;
}
const asg = (over: Partial<AssignmentInput> = {}): AssignmentInput => ({ title: 'Assignment 04', instructions: 'Submit your lab', allowedExtensions: ['zip', 'pdf'], maxBytes: 10_000_000, ...over });
const init = (f: { size: number; sha256: string }, assignmentId: string, over: Partial<UploadInit> = {}): UploadInit =>
  ({ assignmentId, fileName: 'lab.zip', size: f.size, sha256: f.sha256, idempotencyKey: randomUUID(), ...over });
const put = (s: RunningServer, token: string, uploadId: string, offset: number, body: Buffer, ct = UPLOAD_CONTENT_TYPE) =>
  trFor(s.url).fetch(`${s.url}/api/uploads/${uploadId}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': ct, 'upload-offset': String(offset) }, body: new Uint8Array(body) });
const submissions = (s: RunningServer) => (s.classroom as unknown as { db: DatabaseSync }).db.prepare('SELECT * FROM submissions').all() as Record<string, unknown>[];

describe('assignments', () => {
  it('teacher publishes over WS; student sees it', async () => {
    const { s, students: [a] } = await setup();
    const teacher = socket(s.url, s.classroom.teacherToken);
    const st = socket(s.url, a!.token);
    await Promise.all([teacher.next('hello'), st.next('hello')]);
    teacher.send({ t: 'assignment.create', assignment: asg({ allowedExtensions: ['.ZIP', 'pdf'] }) });
    const m = await st.next('assignments', (x) => x.assignments.length === 1);
    expect(m.assignments[0]).toMatchObject({ title: 'Assignment 04', allowedExtensions: ['zip', 'pdf'], latest: null, closed: false });
    // Invalid input from the teacher is rejected, not stored.
    teacher.send({ t: 'assignment.create', assignment: { title: '', maxBytes: -1 } });
    expect((await teacher.next('error')).code).toBe('invalid');
    // Students cannot publish.
    st.send({ t: 'assignment.create', assignment: asg() });
    expect((await st.next('error')).code).toBe('forbidden');
    teacher.close(); st.close();
  });

  it('valid submission: streamed upload, server-time receipt, stored file matches, teacher sees it', async () => {
    const { s, students: [a] } = await setup();
    const A = s.assignments.create(asg());
    const f = makeFile(3_000_000, 'Lab04.zip');
    const before = Date.now();
    const receipt = await uploadSubmission({ transport: trFor(s.url), url: s.url, token: a!.token, assignmentId: A.id, path: f.path, idempotencyKey: randomUUID() });
    expect(receipt.payload).toMatchObject({ assignmentId: A.id, sessionId: s.classroom.id, memberId: a!.memberId, fileName: 'Lab04.zip', size: f.size, sha256: f.sha256, status: 'accepted', late: false, version: 1, fullName: 'Student 0', rollNo: 'FA23-CS-100' });
    expect(receipt.payload.submittedAt).toBeGreaterThanOrEqual(before);
    const stored = s.assignments.submissionPath(receipt.payload.submissionId);
    expect(stored.startsWith(resolve(s.storage.root, 'submissions') + '/')).toBe(true);
    expect(await hashFile(stored)).toBe(f.sha256);
    expect(readdirSync(join(s.storage.root, 'tmp'))).toEqual([]);
    const t = s.assignments.listForTeacher()[0]!;
    expect(t.counts).toMatchObject({ submitted: 1, missing: 0 });
    expect(t.students[0]).toMatchObject({ state: 'submitted', submissionId: receipt.payload.submissionId });
    expect(s.assignments.listForStudent(a!.memberId)[0]!.latest?.payload.submissionId).toBe(receipt.payload.submissionId);
  });

  it('dashboard counts: submitted, late, missing', async () => {
    const { s, students: [a, b, c] } = await setup(3);
    const onTime = s.assignments.create(asg());
    const f = makeFile(100, 'x.pdf');
    await uploadSubmission({ transport: trFor(s.url), url: s.url, token: a!.token, assignmentId: onTime.id, path: f.path, idempotencyKey: randomUUID() });
    const due = s.assignments.create(asg({ title: 'Past due', dueAt: Date.now() - 60_000 }));
    const late = await uploadSubmission({ transport: trFor(s.url), url: s.url, token: b!.token, assignmentId: due.id, path: f.path, idempotencyKey: randomUUID() });
    expect(late.payload.late).toBe(true); // computed by the server, not the client
    const [v1, v2] = s.assignments.listForTeacher() as TeacherAssignmentView[];
    expect(v1!.counts).toMatchObject({ submitted: 1, missing: 2, late: 0 });
    expect(v2!.counts).toMatchObject({ late: 1, missing: 2 });
    expect(v2!.students.find((x) => x.memberId === c!.memberId)!.state).toBe('missing');
  });

  it('rejects bad extension, oversize declaration, closed assignment, and teacher uploads', async () => {
    const { s, students: [a] } = await setup();
    const A = s.assignments.create(asg({ maxBytes: 1000 }));
    const f = makeFile(100);
    await expect(initUpload(trFor(s.url), s.url, a!.token, init(f, A.id, { fileName: 'virus.exe' }))).rejects.toMatchObject({ status: 415 });
    await expect(initUpload(trFor(s.url), s.url, a!.token, init(f, A.id, { fileName: 'lab.zip.exe' }))).rejects.toMatchObject({ status: 415 });
    await expect(initUpload(trFor(s.url), s.url, a!.token, init({ ...f, size: 1001 }, A.id))).rejects.toMatchObject({ status: 413 });
    await expect(initUpload(trFor(s.url), s.url, s.classroom.teacherToken, init(f, A.id))).rejects.toMatchObject({ status: 403 });
    s.assignments.close(A.id);
    await expect(initUpload(trFor(s.url), s.url, a!.token, init(f, A.id))).rejects.toMatchObject({ code: 'closed' });
    expect(() => s.assignments.create(asg({ maxBytes: 3 * 1024 ** 3 }))).toThrow(/Maximum allowed/);
  });

  it('declared size smaller than the bytes sent: rejected and nothing is accepted', async () => {
    const { s, students: [a] } = await setup();
    const A = s.assignments.create(asg());
    const f = makeFile(1000);
    const st = await initUpload(trFor(s.url), s.url, a!.token, init({ ...f, size: 500 }, A.id));
    const res = await put(s, a!.token, st.uploadId, 0, f.buf);
    expect(res.status).toBe(413);
    expect((await uploadStatus(trFor(s.url), s.url, a!.token, st.uploadId)).state).toBe('failed');
    expect(submissions(s)).toEqual([]);
    expect(readdirSync(join(s.storage.root, 'tmp'))).toEqual([]);
  });

  it('hash mismatch: nothing accepted, temp bytes discarded', async () => {
    const { s, students: [a] } = await setup();
    const A = s.assignments.create(asg());
    const f = makeFile(1000);
    const st = await initUpload(trFor(s.url), s.url, a!.token, init({ ...f, sha256: 'a'.repeat(64) }, A.id));
    const res = await put(s, a!.token, st.uploadId, 0, f.buf);
    expect(res.status).toBe(422);
    expect(submissions(s)).toEqual([]);
    expect(readdirSync(join(s.storage.root, 'submissions'))).toEqual([]);
    expect(readdirSync(join(s.storage.root, 'tmp'))).toEqual([]);
    expect(s.assignments.listForTeacher()[0]!.students[0]!.state).toBe('failed');
  });

  it('chunked upload: offsets must line up; offset 0 restarts', async () => {
    const { s, students: [a] } = await setup();
    const A = s.assignments.create(asg());
    const f = makeFile(1000);
    const st = await initUpload(trFor(s.url), s.url, a!.token, init(f, A.id));
    let res = await put(s, a!.token, st.uploadId, 0, f.buf.subarray(0, 400));
    expect((await res.json()).offset).toBe(400);
    res = await put(s, a!.token, st.uploadId, 100, f.buf.subarray(100));
    expect(res.status).toBe(409);
    expect((await res.json()).offset).toBe(400);
    res = await put(s, a!.token, st.uploadId, 0, f.buf.subarray(0, 10)); // restart
    expect((await res.json()).offset).toBe(10);
    res = await put(s, a!.token, st.uploadId, 10, f.buf.subarray(10));
    const done = await res.json();
    expect(done.state).toBe('complete');
    expect(done.receipt.payload.sha256).toBe(f.sha256);
    // Wrong content type is refused (bytes are never JSON/base64).
    res = await put(s, a!.token, st.uploadId, 0, f.buf, 'application/json');
    expect([400, 415]).toContain(res.status);
  });

  it('interrupted upload (connection cut mid-stream) resumes and is accepted once', async () => {
    const { s, students: [a] } = await setup();
    const A = s.assignments.create(asg({ maxBytes: 100_000_000 }));
    const f = makeFile(30 * 1024 * 1024, 'big.zip');
    const proxy = await cuttingProxy(s.url, 12 * 1024 * 1024, 'up');
    trustServer(s, proxy.url);
    cleanups.push(proxy.close);
    const offsets: number[] = [];
    const receipt = await uploadSubmission({ transport: trFor(proxy.url), url: proxy.url, token: a!.token, assignmentId: A.id, path: f.path, idempotencyKey: randomUUID(), onProgress: (sent) => offsets.push(sent) });
    expect(proxy.wasCut()).toBe(true);
    expect(receipt.payload.sha256).toBe(f.sha256);
    expect(submissions(s)).toHaveLength(1);
    // Second PUT started from a non-zero offset (resumed, not restarted).
    const restarts = offsets.filter((o, i) => i > 0 && o < offsets[i - 1]!);
    expect(restarts.every((o) => o > 0)).toBe(true);
    expect(restarts.length).toBeGreaterThan(0);
  }, 60_000);

  it('idempotency: response lost then retried -> same receipt, no duplicate', async () => {
    const { s, students: [a] } = await setup();
    const A = s.assignments.create(asg());
    const f = makeFile(5000);
    const key = randomUUID();
    const first = await uploadSubmission({ transport: trFor(s.url), url: s.url, token: a!.token, assignmentId: A.id, path: f.path, fileName: 'lab.zip', idempotencyKey: key });
    // The student never saw `first` (lost response) and retries everything.
    const again = await uploadSubmission({ transport: trFor(s.url), url: s.url, token: a!.token, assignmentId: A.id, path: f.path, fileName: 'lab.zip', idempotencyKey: key });
    expect(again).toEqual(first);
    const st = await initUpload(trFor(s.url), s.url, a!.token, init(f, A.id, { idempotencyKey: key }));
    expect(st.receipt?.payload.submissionId).toBe(first.payload.submissionId);
    expect(submissions(s)).toHaveLength(1);
    // Same key, different file: refused rather than silently mapped.
    await expect(initUpload(trFor(s.url), s.url, a!.token, init(makeFile(10), A.id, { idempotencyKey: key }))).rejects.toMatchObject({ status: 409, code: 'key_reused' });
    // Concurrent inits with one new key collapse to one upload.
    const k2 = randomUUID();
    const [x, y] = await Promise.all([initUpload(trFor(s.url), s.url, a!.token, init(f, A.id, { idempotencyKey: k2 })), initUpload(trFor(s.url), s.url, a!.token, init(f, A.id, { idempotencyKey: k2 }))]);
    expect(x.uploadId).toBe(y.uploadId);
  });

  it('intentional resubmission is a new version; nothing is overwritten', async () => {
    const { s, students: [a] } = await setup();
    const A = s.assignments.create(asg());
    const f1 = makeFile(100, 'v1.zip'), f2 = makeFile(200, 'v2.zip');
    const r1 = await uploadSubmission({ transport: trFor(s.url), url: s.url, token: a!.token, assignmentId: A.id, path: f1.path, idempotencyKey: randomUUID() });
    const r2 = await uploadSubmission({ transport: trFor(s.url), url: s.url, token: a!.token, assignmentId: A.id, path: f2.path, idempotencyKey: randomUUID() });
    expect([r1.payload.version, r2.payload.version]).toEqual([1, 2]);
    expect(await hashFile(s.assignments.submissionPath(r1.payload.submissionId))).toBe(f1.sha256);
    expect(await hashFile(s.assignments.submissionPath(r2.payload.submissionId))).toBe(f2.sha256);
    expect(s.assignments.listForStudent(a!.memberId)[0]!.latest!.payload.submissionId).toBe(r2.payload.submissionId);
  });

  it('a malicious file name is stored under a sanitized name inside the submission folder', async () => {
    const { s, students: [a] } = await setup();
    const A = s.assignments.create(asg({ allowedExtensions: [] }));
    const f = makeFile(10);
    for (const fileName of ['../../../../evil.sh', '/etc/cron.d/x', '..\\..\\boot.ini', 'CON', 'a\u0000.txt', '‮gnp.exe']) {
      const r = await uploadSubmission({ transport: trFor(s.url), url: s.url, token: a!.token, assignmentId: A.id, path: f.path, fileName, idempotencyKey: randomUUID() });
      const p = s.assignments.submissionPath(r.payload.submissionId);
      expect(p.startsWith(resolve(s.storage.root, 'submissions', s.classroom.id) + '/')).toBe(true);
      expect(r.payload.fileName).not.toMatch(/[/\\\u0000‮]/);
    }
    expect(existsSync(resolve(s.storage.root, '..', 'evil.sh'))).toBe(false);
  });

  it('excessive metadata is refused', async () => {
    const { s, students: [a] } = await setup();
    const A = s.assignments.create(asg());
    const f = makeFile(10);
    await expect(initUpload(trFor(s.url), s.url, a!.token, init(f, A.id, { fileName: 'x'.repeat(300) + '.zip' }))).rejects.toMatchObject({ status: 400 });
    const res = await trFor(s.url).fetch(`${s.url}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${a!.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...init(f, A.id), pad: 'x'.repeat(20_000) }) });
    expect(res.status).toBe(413);
  });

  it('caps unfinished uploads per student', async () => {
    const { s, students: [a] } = await setup(1, { limits: { maxPendingUploadsPerMember: 2 } });
    const A = s.assignments.create(asg());
    const f = makeFile(10);
    await initUpload(trFor(s.url), s.url, a!.token, init(f, A.id));
    await initUpload(trFor(s.url), s.url, a!.token, init(f, A.id));
    await expect(initUpload(trFor(s.url), s.url, a!.token, init(f, A.id))).rejects.toMatchObject({ status: 429 });
  });
});

describe('assignment security', () => {
  it('cross-class: assignment and upload ids from another class are not found', async () => {
    const A = await setup(1), B = await setup(1);
    const ab = B.s.assignments.create(asg());
    const f = makeFile(10);
    await expect(initUpload(trFor(A.s.url), A.s.url, A.students[0]!.token, init(f, ab.id))).rejects.toMatchObject({ status: 404 });
    const up = await initUpload(trFor(B.s.url), B.s.url, B.students[0]!.token, init(f, ab.id));
    await expect(uploadStatus(trFor(A.s.url), A.s.url, A.students[0]!.token, up.uploadId)).rejects.toMatchObject({ status: 404 });
    expect((await put(A.s, A.students[0]!.token, up.uploadId, 0, f.buf)).status).toBe(404);
  });

  it("a student cannot read, write or overwrite another student's upload", async () => {
    const { s, students: [a, b] } = await setup(2);
    const A = s.assignments.create(asg());
    const f = makeFile(1000);
    const victim = await initUpload(trFor(s.url), s.url, a!.token, init(f, A.id));
    await put(s, a!.token, victim.uploadId, 0, f.buf.subarray(0, 500));
    await expect(uploadStatus(trFor(s.url), s.url, b!.token, victim.uploadId)).rejects.toMatchObject({ status: 404 });
    expect((await put(s, b!.token, victim.uploadId, 0, Buffer.alloc(1000))).status).toBe(404);
    expect((await uploadStatus(trFor(s.url), s.url, a!.token, victim.uploadId)).offset).toBe(500);
  });

  it('spoofed identity fields in the request are ignored; the token decides', async () => {
    const { s, students: [a, b] } = await setup(2);
    const A = s.assignments.create(asg());
    const f = makeFile(100);
    const body = { ...init(f, A.id), memberId: b!.memberId, deviceId: randomUUID(), fullName: 'Someone Else', submittedAt: 0 };
    const res = await trFor(s.url).fetch(`${s.url}/api/uploads`, { method: 'POST', headers: { authorization: `Bearer ${a!.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const st = await res.json();
    const done = await (await put(s, a!.token, st.uploadId, 0, f.buf)).json();
    expect(done.receipt.payload).toMatchObject({ memberId: a!.memberId, fullName: 'Student 0' });
    expect(done.receipt.payload.submittedAt).toBeGreaterThan(0);
  });

  it('removed and blocked students cannot submit or continue an upload', async () => {
    const { s, students: [a, b] } = await setup(2);
    const A = s.assignments.create(asg());
    const f = makeFile(1000);
    const up = await initUpload(trFor(s.url), s.url, a!.token, init(f, A.id));
    s.classroom.setStatus(a!.memberId, 'removed');
    expect((await put(s, a!.token, up.uploadId, 0, f.buf)).status).toBe(401);
    s.classroom.setStatus(b!.memberId, 'blocked');
    await expect(initUpload(trFor(s.url), s.url, b!.token, init(f, A.id))).rejects.toMatchObject({ status: 401 });
    expect(submissions(s)).toEqual([]);
  });
});

describe('persistence across teacher app restart', () => {
  it('resources, assignments, submissions and their bytes survive; temp uploads are swept', async () => {
    const dir = tmp('restart-');
    const dbPath = join(dir, 'teacher.db');
    const storageDir = join(dir, 'storage');
    const s1 = await startClassroomServer({ title: 'OS', host: '127.0.0.1', dbPath, storageDir });
    s1.classroom.setPolicy('open');
    trustServer(s1);
    const j = await secureJoin(s1, 1);
    const res = await s1.resources.importFile(makeFile(4000, 'Lecture.pdf').path);
    const A = s1.assignments.create(asg());
    const f = makeFile(2000, 'lab.zip');
    const receipt = await uploadSubmission({ transport: trFor(s1.url), url: s1.url, token: j.token, assignmentId: A.id, path: f.path, idempotencyKey: randomUUID() });
    const unfinished = await initUpload(trFor(s1.url), s1.url, j.token, init(f, A.id));
    await put(s1, j.token, unfinished.uploadId, 0, f.buf.subarray(0, 100));
    const stored = s1.assignments.submissionPath(receipt.payload.submissionId);
    await s1.close();

    const s2 = await startClassroomServer({ title: 'OS', host: '127.0.0.1', dbPath, storageDir });
    servers.push(s2);
    trustServer(s2);
    const db = new DatabaseSync(dbPath);
    expect(db.prepare('SELECT status, sha256 FROM resources WHERE id = ?').get(res.id)).toMatchObject({ status: 'ready', sha256: res.sha256 });
    expect(db.prepare('SELECT title FROM assignments WHERE id = ?').get(A.id)).toMatchObject({ title: 'Assignment 04' });
    expect(db.prepare('SELECT sha256 FROM submissions WHERE id = ?').get(receipt.payload.submissionId)).toMatchObject({ sha256: f.sha256 });
    expect(db.prepare('SELECT state FROM uploads WHERE id = ?').get(unfinished.uploadId)).toMatchObject({ state: 'failed' });
    expect(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(s1.classroom.id)).not.toMatchObject({ ended_at: null });
    db.close();
    expect(await hashFile(stored)).toBe(f.sha256);
    expect(await hashFile(s2.storage.resource(res.id))).toBe(res.sha256);
    expect(readdirSync(join(storageDir, 'tmp'))).toEqual([]);
    // The new session is a fresh class: old ids are not reachable through it.
    expect(s2.resources.listForTeacher()).toEqual([]);
    expect(() => s2.assignments.submissionPath(receipt.payload.submissionId)).toThrow();
  });
});

it('student download + submit round trip works through the same client used by desktop', async () => {
  const { s, students: [a] } = await setup();
  const r = await s.resources.importFile(makeFile(1234, 'brief.pdf').path);
  const got = await downloadResource({ transport: trFor(s.url), url: s.url, token: a!.token, resource: r, destDir: tmp() });
  const A = s.assignments.create(asg({ allowedExtensions: ['pdf'] }));
  const receipt = await uploadSubmission({ transport: trFor(s.url), url: s.url, token: a!.token, assignmentId: A.id, path: got.path, idempotencyKey: randomUUID() });
  expect(receipt.payload.sha256).toBe(await sha256File(got.path));
  expect(readFileSync(s.assignments.submissionPath(receipt.payload.submissionId)).length).toBe(1234);
});
