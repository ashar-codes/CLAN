import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { downloadResource, partPaths } from '@classroom/client/node';
import type { ResourceView, TeacherResourceView } from '@classroom/protocol';
import type { RunningServer } from '../src/index.ts';
import { classWith, cuttingProxy, get, makeFile, socket, tmp } from './helpers.ts';

const servers: RunningServer[] = [];
const cleanups: (() => Promise<void>)[] = [];
async function setup(n = 1, opts = {}) {
  const r = await classWith(n, opts);
  servers.push(r.s);
  return r;
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((f) => f()));
  await Promise.all(servers.splice(0).map((s) => s.close()));
});
const content = (s: RunningServer, id: string) => `${s.url}/api/resources/${id}/content`;
const view = (r: ResourceView) => ({ id: r.id, name: r.name, size: r.size, sha256: r.sha256 });

describe('classroom files', () => {
  it('teacher adds a file; teacher and student see it with size + sha256', async () => {
    const { s, students: [a] } = await setup();
    const f = makeFile(300_000, 'Lecture-05.pdf');
    const r = await s.resources.importFile(f.path);
    expect(r).toMatchObject({ name: 'Lecture-05.pdf', size: f.size, sha256: f.sha256, status: 'ready', available: true, mime: 'application/pdf' });
    // Stored under an opaque id, not the name.
    expect(readdirSync(join(s.storage.root, 'resources'))).toEqual([r.id]);
    const list = await (await get(`${s.url}/api/resources`, a!.token)).json();
    expect(list.resources.map((x: ResourceView) => x.id)).toEqual([r.id]);
    const st = socket(s.url, a!.token);
    expect((await st.next('resources')).resources[0]).toMatchObject({ id: r.id, sha256: f.sha256 });
    st.close();
  });

  it('authorized download completes, verifies hash, leaves no partial', async () => {
    const { s, students: [a] } = await setup();
    const f = makeFile(2_000_000, 'Lab04.zip');
    const r = await s.resources.importFile(f.path);
    const dest = tmp();
    const states: string[] = [];
    const out = await downloadResource({ url: s.url, token: a!.token, resource: view(r), destDir: dest, onProgress: (p) => states.push(p.state) });
    expect(out.path).toBe(join(dest, 'Lab04.zip'));
    expect(readFileSync(out.path).equals(f.buf)).toBe(true);
    expect(existsSync(partPaths(dest, r.id).part)).toBe(false);
    expect(states.at(-1)).toBe('completed');
    expect(states).toContain('verifying');
  });

  it('serves headers: ETag, Repr-Digest, octet-stream, safe Content-Disposition', async () => {
    const { s, students: [a] } = await setup();
    const f = makeFile(1000, 'x.pdf');
    const r = await s.resources.importFile(f.path, 'evil"\r\nSet-Cookie: a=b\u202Etxt.exe');
    const res = await get(content(s, r.id), a!.token);
    await res.arrayBuffer();
    expect(res.headers.get('etag')).toBe(`"${f.sha256}"`);
    expect(res.headers.get('content-type')).toBe('application/octet-stream');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('set-cookie')).toBeNull();
    const cd = res.headers.get('content-disposition')!;
    expect(cd).not.toMatch(/[\r\n]/);
    expect(cd).toMatch(/^attachment; filename="[^"]*"; filename\*=UTF-8''/);
    expect(r.name).not.toContain('\u202E');
  });

  it('range requests: valid, suffix, If-Range mismatch, and malformed ranges', async () => {
    const { s, students: [a] } = await setup();
    const f = makeFile(1000);
    const r = await s.resources.importFile(f.path);
    const t = a!.token;
    let res = await get(content(s, r.id), t, { range: 'bytes=100-199' });
    expect(res.status).toBe(206);
    expect(res.headers.get('content-range')).toBe('bytes 100-199/1000');
    expect(Buffer.from(await res.arrayBuffer()).equals(f.buf.subarray(100, 200))).toBe(true);
    res = await get(content(s, r.id), t, { range: 'bytes=-10' });
    expect(Buffer.from(await res.arrayBuffer()).equals(f.buf.subarray(990))).toBe(true);
    res = await get(content(s, r.id), t, { range: 'bytes=900-5000' });
    expect(res.headers.get('content-range')).toBe('bytes 900-999/1000');
    await res.arrayBuffer();
    res = await get(content(s, r.id), t, { range: 'bytes=500-', 'if-range': '"stale"' });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
    for (const bad of ['bytes=abc', 'bytes=5-2', 'bytes=0-1,5-6', 'bytes=1000-', 'items=0-1', 'bytes=-0', 'bytes=-', 'bytes=99999999999999999999-']) {
      res = await get(content(s, r.id), t, { range: bad });
      expect(res.status, bad).toBe(416);
      expect(res.headers.get('content-range')).toBe('bytes */1000');
      await res.arrayBuffer();
    }
  });

  it('resumes a 100 MB download after the connection drops at 47 MB', async () => {
    const { s, students: [a] } = await setup();
    const f = makeFile(100 * 1024 * 1024, 'video.mp4');
    const r = await s.resources.importFile(f.path);
    const proxy = await cuttingProxy(s.url, 47 * 1024 * 1024);
    cleanups.push(proxy.close);
    const dest = tmp();
    await expect(downloadResource({ url: proxy.url, token: a!.token, resource: view(r), destDir: dest })).rejects.toThrow();
    expect(proxy.wasCut()).toBe(true);
    // Partial is never presented as the finished file.
    expect(existsSync(join(dest, 'video.mp4'))).toBe(false);
    const partial = readFileSync(partPaths(dest, r.id).part).length;
    // Bytes still in socket buffers at the drop are lost, so the partial sits somewhat below the 47 MB cut.
    expect(partial).toBeGreaterThan(20 * 1024 * 1024);
    expect(partial).toBeLessThanOrEqual(47 * 1024 * 1024);
    const out = await downloadResource({ url: proxy.url, token: a!.token, resource: view(r), destDir: dest });
    expect(out.resumedFrom).toBe(partial);
    expect(readFileSync(out.path).equals(f.buf)).toBe(true);
  }, 60_000);

  it('a corrupted partial fails verification, is discarded, and a retry succeeds', async () => {
    const { s, students: [a] } = await setup();
    const f = makeFile(500_000);
    const r = await s.resources.importFile(f.path);
    const dest = tmp();
    const p = partPaths(dest, r.id);
    mkdirSync(p.dir, { recursive: true });
    const bad = Buffer.from(f.buf.subarray(0, 200_000));
    bad[1234] = bad[1234]! ^ 0xff;
    writeFileSync(p.part, bad);
    writeFileSync(p.meta, JSON.stringify({ sha256: r.sha256, size: r.size }));
    await expect(downloadResource({ url: s.url, token: a!.token, resource: view(r), destDir: dest })).rejects.toMatchObject({ code: 'hash_mismatch' });
    expect(existsSync(p.part)).toBe(false);
    expect(readdirSync(dest).filter((x) => !x.startsWith('.'))).toEqual([]);
    const out = await downloadResource({ url: s.url, token: a!.token, resource: view(r), destDir: dest });
    expect(out.resumedFrom).toBe(0);
    expect(readFileSync(out.path).equals(f.buf)).toBe(true);
  });

  it('a partial for a different version of the file is discarded, not resumed', async () => {
    const { s, students: [a] } = await setup();
    const f = makeFile(100_000);
    const r = await s.resources.importFile(f.path);
    const dest = tmp();
    const p = partPaths(dest, r.id);
    mkdirSync(p.dir, { recursive: true });
    writeFileSync(p.part, Buffer.alloc(50_000, 7));
    writeFileSync(p.meta, JSON.stringify({ sha256: 'f'.repeat(64), size: r.size }));
    const out = await downloadResource({ url: s.url, token: a!.token, resource: view(r), destDir: dest });
    expect(out.resumedFrom).toBe(0);
    expect(readFileSync(out.path).equals(f.buf)).toBe(true);
  });

  it('duplicate file names stay distinct on the server and never overwrite on the student', async () => {
    const { s, students: [a] } = await setup();
    const f1 = makeFile(10, 'notes.txt'), f2 = makeFile(20, 'notes.txt');
    const r1 = await s.resources.importFile(f1.path), r2 = await s.resources.importFile(f2.path);
    expect(r1.id).not.toBe(r2.id);
    const dest = tmp();
    const o1 = await downloadResource({ url: s.url, token: a!.token, resource: view(r1), destDir: dest });
    const o2 = await downloadResource({ url: s.url, token: a!.token, resource: view(r2), destDir: dest });
    expect([o1.path, o2.path]).toEqual([join(dest, 'notes.txt'), join(dest, 'notes (1).txt')]);
    expect(readFileSync(o1.path).equals(f1.buf)).toBe(true);
  });

  it('a malicious server-provided name cannot escape the student download folder', async () => {
    const { s, students: [a] } = await setup();
    const f = makeFile(10);
    const r = await s.resources.importFile(f.path);
    const dest = tmp();
    for (const name of ['../../escape.txt', '/etc/passwd', 'C:\\Windows\\x.dll', '..', 'CON', 'a\u0000b']) {
      const out = await downloadResource({ url: s.url, token: a!.token, resource: { ...view(r), name }, destDir: dest });
      expect(out.path.startsWith(dest + '/')).toBe(true);
      expect(out.path.slice(dest.length + 1)).not.toMatch(/[/\\\u0000]/);
    }
    expect(existsSync(join(dest, '..', 'escape.txt'))).toBe(false);
  });

  it('hidden files are invisible to students; remove deletes the managed copy only', async () => {
    const { s, students: [a] } = await setup();
    const f = makeFile(1000);
    const r = await s.resources.importFile(f.path);
    const dest = tmp();
    const got = await downloadResource({ url: s.url, token: a!.token, resource: view(r), destDir: dest });
    s.resources.setAvailable(r.id, false);
    expect((await get(content(s, r.id), a!.token)).status).toBe(404);
    expect((await get(content(s, r.id), s.classroom.teacherToken)).status).toBe(200);
    expect((await (await get(`${s.url}/api/resources`, a!.token)).json()).resources).toEqual([]);
    await s.resources.remove(r.id);
    expect(existsSync(s.storage.resource(r.id))).toBe(false);
    expect((await get(content(s, r.id), s.classroom.teacherToken)).status).toBe(404);
    expect(existsSync(f.path)).toBe(true); // teacher's original untouched
    expect(existsSync(got.path)).toBe(true); // student's copy untouched
  });

  it('Send to Everyone queues every approved student and they report progress', async () => {
    const { s, students } = await setup(3);
    const f = makeFile(50_000, 'Lecture05.pdf');
    const r = await s.resources.importFile(f.path);
    const socks = students.map((x) => socket(s.url, x.token));
    const teacher = socket(s.url, s.classroom.teacherToken);
    await Promise.all([...socks, teacher].map((x) => x.next('hello')));
    teacher.send({ t: 'resource.push', resourceId: r.id });
    await Promise.all(socks.map((x) => x.next('resource.push', (m) => m.resourceId === r.id)));
    let v = (await teacher.next('resources', (m) => (m.resources as TeacherResourceView[])[0]?.counts.queued === 3)).resources[0] as TeacherResourceView;
    expect(v.pushed).toBe(true);
    // Students fetch over HTTP and report.
    await Promise.all(students.map(async (st, i) => {
      await downloadResource({ url: s.url, token: st.token, resource: view(r), destDir: tmp(), onProgress: (p) => socks[i]!.send({ t: 'transfer.state', resourceId: r.id, state: p.state, bytes: p.bytes }) });
    }));
    v = (await teacher.next('resources', (m) => (m.resources as TeacherResourceView[])[0]?.counts.completed === 3)).resources[0] as TeacherResourceView;
    expect(v.students.map((x) => x.state)).toEqual(['completed', 'completed', 'completed']);
    expect(v.students.every((x) => x.bytes === f.size)).toBe(true);
    [...socks, teacher].forEach((x) => x.close());
  });

  it('a student cannot report progress for another class or perform teacher file actions', async () => {
    const { s, students: [a] } = await setup();
    const r = await s.resources.importFile(makeFile(10).path);
    const st = socket(s.url, a!.token);
    await st.next('hello');
    for (const m of [{ t: 'resource.remove', resourceId: r.id }, { t: 'resource.push', resourceId: r.id }, { t: 'resource.available', resourceId: r.id, available: false }]) {
      st.send(m);
      expect((await st.next('error')).code).toBe('forbidden');
    }
    st.send({ t: 'transfer.state', resourceId: randomUUID(), state: 'completed', bytes: 5 }); // unknown resource: ignored
    const teacher = socket(s.url, s.classroom.teacherToken);
    await teacher.next('hello');
    teacher.send({ t: 'transfer.state', resourceId: r.id, state: 'completed', bytes: 5 });
    expect((await teacher.next('error')).code).toBe('forbidden');
    expect(s.resources.listForTeacher()[0]!.counts.not_started).toBe(1);
    st.close(); teacher.close();
  });
});

describe('file authorization', () => {
  it('rejects missing, garbage, pending, removed, blocked and expired tokens', async () => {
    const { s, students: [a, b, c] } = await setup(3);
    const r = await s.resources.importFile(makeFile(10).path);
    const url = content(s, r.id);
    expect((await get(url, null)).status).toBe(401);
    expect((await get(url, 'x'.repeat(43))).status).toBe(401);
    expect((await get(url, 'not a token at all')).status).toBe(401);
    s.classroom.setPolicy('approval');
    const { joinByCode } = await import('@classroom/client');
    const pending = await joinByCode([{ url: s.url }], s.classroom.code, (await import('./helpers.ts')).profile(9));
    expect((await get(url, pending.token)).status).toBe(403);
    s.classroom.setStatus(a!.memberId, 'removed');
    expect((await get(url, a!.token)).status).toBe(401);
    s.classroom.setStatus(b!.memberId, 'blocked');
    expect((await get(url, b!.token)).status).toBe(401);
    // Expire c's token.
    const db = (s.classroom as unknown as { db: import('node:sqlite').DatabaseSync }).db;
    db.prepare('UPDATE members SET token_expires = 0 WHERE id = ?').run(c!.memberId);
    expect((await get(url, c!.token)).status).toBe(401);
  });

  it('cross-class: a resource id from class B is not found in class A, and A tokens fail at B', async () => {
    const A = await setup(1), B = await setup(1);
    const rb = await B.s.resources.importFile(makeFile(10).path);
    const ra = await A.s.resources.importFile(makeFile(10).path);
    const bodyA = await (await get(content(A.s, rb.id), A.students[0]!.token)).text();
    const missing = await (await get(content(A.s, randomUUID()), A.students[0]!.token)).text();
    expect(bodyA).toBe(missing); // identical: no enumeration oracle
    expect((await get(content(B.s, rb.id), A.students[0]!.token)).status).toBe(401);
    expect((await get(content(B.s, ra.id), B.s.classroom.teacherToken)).status).toBe(404);
  });

  it('path traversal and non-id paths in the URL never reach the filesystem', async () => {
    const { s, students: [a] } = await setup();
    await s.resources.importFile(makeFile(10).path);
    for (const p of ['..%2F..%2F..%2Fetc%2Fpasswd', '..', '%2e%2e', 'resources', encodeURIComponent(s.storage.root + '/resources/x'), 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa%00']) {
      const res = await get(`${s.url}/api/resources/${p}/content`, a!.token);
      expect([400, 404], p).toContain(res.status);
      const body = await res.text();
      expect(body).not.toMatch(/root:|\/Users\/|classroom-storage/);
    }
  });
});

describe('file resource limits', () => {
  it('rate-limits content requests per student', async () => {
    const { s, students: [a] } = await setup(1, { limits: { downloadRequestsPerMinute: 3 } });
    const r = await s.resources.importFile(makeFile(10).path);
    const codes = [];
    for (let i = 0; i < 5; i++) { const res = await get(content(s, r.id), a!.token); await res.arrayBuffer(); codes.push(res.status); }
    expect(codes).toEqual([200, 200, 200, 429, 429]);
  });

  it('caps concurrent downloads per student; a stalled reader is cut by the idle watchdog', async () => {
    const { s, students: [a, b] } = await setup(2, { limits: { maxDownloadsPerMember: 1, transferIdleMs: 400 } });
    const r = await s.resources.importFile(makeFile(20 * 1024 * 1024).path);
    const stalled = await get(content(s, r.id), a!.token); // never read: backpressure stalls it
    expect(stalled.status).toBe(200);
    expect((await get(content(s, r.id), a!.token)).status).toBe(429);
    const other = await get(content(s, r.id), b!.token); // a slow student doesn't block others
    expect(other.status).toBe(200);
    expect((await other.arrayBuffer()).byteLength).toBe(20 * 1024 * 1024);
    await new Promise((res) => setTimeout(res, 6000));
    expect(s.resources.stats(0).activeDownloads).toBe(0);
    const again = await get(content(s, r.id), a!.token);
    expect(again.status).toBe(200);
    await again.body?.cancel();
  }, 20_000);

  it('refuses to import when the disk would drop below the reserve', async () => {
    const { s } = await setup(0, { limits: { diskReserveBytes: Number.MAX_SAFE_INTEGER } });
    await expect(s.resources.importFile(makeFile(10).path)).rejects.toMatchObject({ code: 'disk_full' });
    expect(readdirSync(join(s.storage.root, 'tmp'))).toEqual([]);
  });

  it('import rejects directories', async () => {
    const { s } = await setup(0);
    await expect(s.resources.importFile(tmp())).rejects.toMatchObject({ code: 'not_a_file' });
  });
});

describe('cross-session isolation on one teacher database (realistic: last week\'s ids)', () => {
  it('resources, assignments and uploads from another session on the same DB are unreachable', async () => {
    const { openDb } = await import('../src/index.ts');
    const { initUpload, uploadStatus } = await import('@classroom/client');
    const { randomUUID } = await import('node:crypto');
    const db = openDb(':memory:');
    const storageDir = tmp();
    const old = await classWith(1, { db, storageDir });
    const now = await classWith(1, { db, storageDir });
    servers.push(old.s, now.s);
    const r = await old.s.resources.importFile(makeFile(10).path);
    const A = old.s.assignments.create({ title: 'Old', maxBytes: 1000 });
    const f = makeFile(10);
    const up = await initUpload(old.s.url, old.students[0]!.token, { assignmentId: A.id, fileName: 'a.txt', size: 10, sha256: f.sha256, idempotencyKey: randomUUID() });
    const t = now.students[0]!.token;
    expect((await get(content(now.s, r.id), t)).status).toBe(404);
    expect((await get(content(now.s, r.id), now.s.classroom.teacherToken)).status).toBe(404);
    expect(now.s.resources.listForTeacher()).toEqual([]);
    await expect(initUpload(now.s.url, t, { assignmentId: A.id, fileName: 'a.txt', size: 10, sha256: f.sha256, idempotencyKey: randomUUID() })).rejects.toMatchObject({ status: 404 });
    await expect(uploadStatus(now.s.url, t, up.uploadId)).rejects.toMatchObject({ status: 404 });
    expect(now.s.assignments.listForTeacher()).toEqual([]);
    expect(() => now.s.assignments.close(A.id)).toThrow();
    await expect(now.s.resources.remove(r.id)).rejects.toMatchObject({ status: 404 });
    // Old session's token is useless at the new session.
    expect((await get(content(now.s, r.id), old.students[0]!.token)).status).toBe(401);
  });
});
