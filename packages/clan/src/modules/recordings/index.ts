// Study Tapes: a recording (one canonical Resource Store file, personal by default) plus its timeline of timestamped
// events — Important, Note, Screenshot (a Resource), Bookmark, marker — and links to a Course / Topic / Lecture / Study
// Session. Metadata only lives here; media bytes never enter SQLite. Without a transcript nothing claims the recording
// was "understood"; `transcript` stays null until a TranscriptionProvider exists and the student runs it.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Principal, type Scope } from '../../core/permissions.ts';
import type { SearchProvider } from '../../core/search.ts';
import type { Courses } from '../courses/index.ts';
import type { Files } from '../files/index.ts';
import type { Notes } from '../notes/index.ts';
import { rowProvider, type SyncProvider } from '../../core/syncrows.ts';

export const schema: ModuleSchema = {
  module: 'recordings', prefix: 'rec',
  migrations: [`
    CREATE TABLE rec_tapes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('recording','ready','recovered','failed')),
      ref_id TEXT, mime TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, duration_ms INTEGER, bytes INTEGER NOT NULL DEFAULT 0,
      course_id TEXT, topic_id TEXT, lecture_id TEXT, study_session_id TEXT,
      source TEXT NOT NULL CHECK (source IN ('screen','window','test')), mic INTEGER NOT NULL DEFAULT 0, system_audio INTEGER NOT NULL DEFAULT 0,
      others_consent INTEGER NOT NULL DEFAULT 0, end_reason TEXT, part_path TEXT, transcript TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX rec_tapes_owner ON rec_tapes(owner_id, started_at);
    CREATE INDEX rec_tapes_course ON rec_tapes(owner_id, course_id, lecture_id);
    CREATE TABLE rec_events (id TEXT PRIMARY KEY, tape_id TEXT NOT NULL REFERENCES rec_tapes(id), at_ms INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('important','note','screenshot','bookmark','marker')), text TEXT NOT NULL DEFAULT '',
      ref_id TEXT, note_id TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX rec_events_tape ON rec_events(tape_id, at_ms);
  `],
};

export const TapeChanged = defineEvent('TapeChanged', 1, z.object({ tapeId: z.string(), ownerId: z.string() }));
export const EVENT_KINDS = ['important', 'note', 'screenshot', 'bookmark', 'marker'] as const;
export type TapeEventKind = (typeof EVENT_KINDS)[number];
export type Tape = { id: string; title: string; status: 'recording' | 'ready' | 'recovered' | 'failed'; refId: string | null; mime: string | null; startedAt: number; endedAt: number | null;
  durationMs: number | null; bytes: number; courseId: string | null; topicId: string | null; lectureId: string | null; studySessionId: string | null;
  source: 'screen' | 'window' | 'test'; mic: boolean; systemAudio: boolean; othersConsent: boolean; endReason: string | null; hasTranscript: boolean };
export type TapeEvent = { id: string; tapeId: string; atMs: number; kind: TapeEventKind; text: string; refId: string | null; noteId: string | null };
type Raw = { id: string; owner_id: string; title: string; status: Tape['status']; ref_id: string | null; mime: string | null; started_at: number; ended_at: number | null; duration_ms: number | null; bytes: number;
  course_id: string | null; topic_id: string | null; lecture_id: string | null; study_session_id: string | null; source: Tape['source']; mic: number; system_audio: number; others_consent: number; end_reason: string | null; part_path: string | null; transcript: string | null; updated_at: number };
const toTape = (r: Raw): Tape => ({ id: r.id, title: r.title, status: r.status, refId: r.ref_id, mime: r.mime, startedAt: r.started_at, endedAt: r.ended_at, durationMs: r.duration_ms, bytes: r.bytes,
  courseId: r.course_id, topicId: r.topic_id, lectureId: r.lecture_id, studySessionId: r.study_session_id, source: r.source, mic: !!r.mic, systemAudio: !!r.system_audio, othersConsent: !!r.others_consent, endReason: r.end_reason, hasTranscript: !!r.transcript });
export const clock = (ms: number) => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 3600) ? `${Math.floor(s / 3600)}:` : ''}${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
const LABEL: Record<TapeEventKind, string> = { important: 'Important', note: 'Note', screenshot: 'Screenshot', bookmark: 'Bookmark', marker: 'Marker' };

export class Recordings {
  private db: Db; private bus: EventBus; private m: { courses: Courses; files: Files; notes: Notes }; private now: () => number;
  constructor(db: Db, bus: EventBus, m: { courses: Courses; files: Files; notes: Notes }, now = () => Date.now()) { this.db = db; this.bus = bus; this.m = m; this.now = now; }

  /** Personal sync: Study Tape metadata and timeline (the video is a file and follows the file settings). A tape still
   *  recording stays on its device; where its partial file lives is device-local. */
  syncProviders(): SyncProvider[] {
    return [rowProvider(this.db, { kind: 'tape', policy: 'lww', table: 'rec_tapes', owner: 'owner_id', where: "status <> 'recording'", exclude: ['part_path'],
      children: [{ table: 'rec_events', fk: 'tape_id', key: 'id', order: 'at_ms, id' }] })];
  }
  private owner(p: Principal) { if (p.kind !== 'user') throw new Error('Only you can record.'); return p.userId; }
  private raw(p: Principal, id: string) { return this.db.prepare('SELECT * FROM rec_tapes WHERE id = ? AND owner_id = ?').get(id, userOf(p)) as Raw | undefined; }
  private must(p: Principal, id: string) { const r = this.raw(p, id); if (!r) throw new Error('Study Tape not found.'); return r; }
  private touch(id: string, owner: string) { this.db.prepare('UPDATE rec_tapes SET updated_at = ? WHERE id = ?').run(this.now(), id); this.bus.publish(TapeChanged, 'recordings', { tapeId: id, ownerId: owner }); }
  /** Agents (AI) never read tapes directly; AI uses the Context layer with the student's explicit inclusion. */
  get(p: Principal, id: string) { if (p.kind === 'agent' && !p.scopes.includes('recordings:read')) return null; const r = this.raw(p, id); return r ? toTape(r) : null; }

  /** Starts a tape (explicit user action only). `othersConsent`: the student confirmed others may be captured. */
  start(p: Principal, o: { title: string; source: Tape['source']; mic?: boolean; systemAudio?: boolean; othersConsent?: boolean; partPath: string; courseId?: string | null; lectureId?: string | null; topicId?: string | null; studySessionId?: string | null }): Tape {
    const u = this.owner(p), id = randomUUID(), t = this.now();
    if (this.db.prepare("SELECT 1 FROM rec_tapes WHERE owner_id = ? AND status = 'recording'").get(u)) throw new Error('A recording is already running.');
    this.checkLinks(p, o);
    this.db.prepare(`INSERT INTO rec_tapes (id, owner_id, title, status, started_at, source, mic, system_audio, others_consent, part_path, course_id, topic_id, lecture_id, study_session_id, created_at, updated_at)
      VALUES (?, ?, ?, 'recording', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, u, z.string().trim().min(1).max(160).parse(o.title), t, o.source, o.mic ? 1 : 0, o.systemAudio ? 1 : 0, o.othersConsent ? 1 : 0, o.partPath,
        o.courseId ?? null, o.topicId ?? null, o.lectureId ?? null, o.studySessionId ?? null, t, t);
    this.touch(id, u);
    return this.get(p, id)!;
  }
  active(p: Principal) { const r = this.db.prepare("SELECT * FROM rec_tapes WHERE owner_id = ? AND status = 'recording' LIMIT 1").get(userOf(p)) as Raw | undefined; return r ? toTape(r) : null; }
  progress(p: Principal, id: string, bytes: number) { this.db.prepare("UPDATE rec_tapes SET bytes = ? WHERE id = ? AND owner_id = ? AND status = 'recording'").run(Math.max(0, Math.floor(bytes)), id, userOf(p)); }

  /** Finalized media (already moved into the Resource Store as a personal file) → ready. */
  async finish(p: Principal, id: string, o: { path: string; mime: string; durationMs: number; endReason: string; recovered?: boolean }) {
    const u = this.owner(p), r = this.must(p, id);
    const file = await this.m.files.ingest(p, o.path, `${r.title.replace(/[\\/:*?"<>|]+/g, ' ').slice(0, 100)}.${o.mime.includes('mp4') ? 'mp4' : 'webm'}`, { kind: 'personal', ownerId: u }, o.mime);
    this.db.prepare('UPDATE rec_tapes SET status = ?, ref_id = ?, mime = ?, ended_at = ?, duration_ms = ?, bytes = ?, end_reason = ?, part_path = NULL WHERE id = ?')
      .run(o.recovered ? 'recovered' : 'ready', file.refId, o.mime, r.started_at + o.durationMs, Math.max(0, Math.round(o.durationMs)), file.size, o.endReason.slice(0, 200), id);
    this.touch(id, u);
    return this.get(p, id)!;
  }
  /** Nothing usable was written (e.g. capture failed at once). The tape stays, marked failed, with its timeline. */
  fail(p: Principal, id: string, reason: string) { const u = this.owner(p); this.must(p, id); this.db.prepare("UPDATE rec_tapes SET status = 'failed', end_reason = ?, ended_at = coalesce(ended_at, ?), part_path = NULL WHERE id = ?").run(reason.slice(0, 200), this.now(), id); this.touch(id, u); }
  /** Tapes left `recording` by a crash: the host app finalizes their partial files (or fails them). */
  interrupted(p: Principal) { return (this.db.prepare("SELECT * FROM rec_tapes WHERE owner_id = ? AND status = 'recording'").all(userOf(p)) as Raw[]).map((r) => ({ ...toTape(r), partPath: r.part_path })); }

  /** A timestamped event; screenshots carry a Resource ref (a personal file). */
  mark(p: Principal, tapeId: string, o: { kind: TapeEventKind; atMs: number; text?: string; refId?: string | null }): TapeEvent {
    const u = this.owner(p), r = this.must(p, tapeId);
    if (o.refId && !this.m.files.get(p, o.refId)) throw new Error('Screenshot not found.');
    const max = r.status === 'recording' ? this.now() - r.started_at + 5_000 : (r.duration_ms ?? 0) + 1_000;
    const at = z.number().int().min(0).max(Math.max(0, max)).parse(Math.round(o.atMs));
    const id = randomUUID();
    this.db.prepare('INSERT INTO rec_events (id, tape_id, at_ms, kind, text, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, tapeId, at, z.enum(EVENT_KINDS).parse(o.kind), z.string().max(4000).parse(o.text ?? ''), o.refId ?? null, this.now());
    this.touch(tapeId, u);
    return this.events(p, tapeId).find((e) => e.id === id)!;
  }
  editEvent(p: Principal, eventId: string, text: string) { this.owner(p); const e = this.event(p, eventId); this.db.prepare('UPDATE rec_events SET text = ? WHERE id = ?').run(z.string().max(4000).parse(text), e.id); this.touch(e.tapeId, userOf(p)); }
  removeEvent(p: Principal, eventId: string) { this.owner(p); const e = this.event(p, eventId); this.db.prepare('DELETE FROM rec_events WHERE id = ?').run(e.id); this.touch(e.tapeId, userOf(p)); }
  private event(p: Principal, eventId: string) {
    const e = this.db.prepare('SELECT e.* FROM rec_events e JOIN rec_tapes t ON t.id = e.tape_id WHERE e.id = ? AND t.owner_id = ?').get(eventId, userOf(p)) as { id: string; tape_id: string; at_ms: number; text: string; kind: string } | undefined;
    if (!e) throw new Error('Event not found.');
    return { id: e.id, tapeId: e.tape_id, atMs: e.at_ms, text: e.text, kind: e.kind };
  }
  events(p: Principal, tapeId: string): TapeEvent[] {
    if (!this.get(p, tapeId)) return [];
    return (this.db.prepare('SELECT id, tape_id tapeId, at_ms atMs, kind, text, ref_id refId, note_id noteId FROM rec_events WHERE tape_id = ? ORDER BY at_ms, created_at').all(tapeId) as TapeEvent[]);
  }
  /** Explicit: turns a timeline note into a full Notes-module note that references the tape and timestamp. */
  toNote(p: Principal, eventId: string) {
    const e = this.event(p, eventId), t = this.must(p, e.tapeId);
    const n = this.m.notes.create(p, { title: `${t.title} · ${clock(e.atMs)}`, body: `${e.text}\n\n— from Study Tape “${t.title}” at ${clock(e.atMs)} (clan://tape/${t.id}?t=${e.atMs})` });
    this.db.prepare('UPDATE rec_events SET note_id = ? WHERE id = ?').run(n.id, e.id);
    if (t.course_id) try { this.m.courses.link(p, t.course_id, { module: 'notes', entityId: n.id, topicId: t.topic_id, lectureId: t.lecture_id }); } catch { /* course gone */ }
    return n;
  }

  private checkLinks(p: Principal, o: { courseId?: string | null; lectureId?: string | null; topicId?: string | null }) {
    if (!o.courseId) { if (o.lectureId || o.topicId) throw new Error('Pick a course first.'); return; }
    this.m.courses.mine(p, o.courseId);
    if (o.topicId && this.m.courses.topic(p, o.topicId).courseId !== o.courseId) throw new Error('Topic of another course.');
    if (o.lectureId && !this.m.courses.lectures(p, o.courseId).some((l) => l.id === o.lectureId)) throw new Error('Lecture of another course.');
  }
  /** Course / Topic / Lecture link: references only; the media is never copied. */
  link(p: Principal, id: string, o: { courseId: string | null; topicId?: string | null; lectureId?: string | null }) {
    const u = this.owner(p); this.must(p, id); this.checkLinks(p, o);
    this.db.prepare('UPDATE rec_tapes SET course_id = ?, topic_id = ?, lecture_id = ? WHERE id = ?').run(o.courseId, o.topicId ?? null, o.lectureId ?? null, id);
    this.touch(id, u);
    return this.get(p, id)!;
  }
  rename(p: Principal, id: string, title: string) { const u = this.owner(p); this.must(p, id); this.db.prepare('UPDATE rec_tapes SET title = ? WHERE id = ?').run(z.string().trim().min(1).max(160).parse(title), id); this.touch(id, u); }
  list(p: Principal, o: { courseId?: string; lectureId?: string; limit?: number } = {}): Tape[] {
    if (p.kind === 'agent' && !p.scopes.includes('recordings:read')) return [];
    return (this.db.prepare(`SELECT * FROM rec_tapes WHERE owner_id = ? ${o.courseId ? 'AND course_id = ?' : ''} ${o.lectureId ? 'AND lecture_id = ?' : ''} ORDER BY started_at DESC LIMIT ?`)
      .all(...[userOf(p), ...(o.courseId ? [o.courseId] : []), ...(o.lectureId ? [o.lectureId] : []), o.limit ?? 100]) as Raw[]).map(toTape);
  }
  hasFileReference(id: string) {return !!this.db.prepare('SELECT 1 FROM rec_tapes WHERE ref_id=? UNION ALL SELECT 1 FROM rec_events WHERE ref_id=? LIMIT 1').get(id,id);}
  /** Deletes the tape and its timeline; the media/screenshot refs are removed from Personal Space (bytes freed when unreferenced). */
  remove(p: Principal, id: string) {
    this.owner(p);
    const r = this.must(p, id);
    if(r.status==='recording')throw new Error('Stop the recording before deleting it.');
    const refs = [r.ref_id, ...(this.db.prepare('SELECT ref_id r FROM rec_events WHERE tape_id = ? AND ref_id IS NOT NULL').all(id) as { r: string }[]).map((x) => x.r)].filter(Boolean) as string[];
    tx(this.db, () => { this.db.prepare('DELETE FROM rec_events WHERE tape_id = ?').run(id); this.db.prepare('DELETE FROM rec_tapes WHERE id = ?').run(id); });
    return refs;
  }
  /** Text the AI Context layer may use (timeline only; no transcript exists yet). */
  timelineText(p: Principal, id: string) {
    const t = this.get(p, id); if (!t) return null;
    const ev = this.events(p, id).filter((e) => e.text || e.kind !== 'screenshot');
    return `Study Tape: ${t.title} (${clock(t.durationMs ?? 0)} long). No transcript exists; only the student's own timeline entries:\n${ev.map((e) => `${clock(e.atMs)} ${LABEL[e.kind]}${e.text ? `: ${e.text}` : ''}`).join('\n')}`;
  }

  /** Search: tape titles and every timeline entry (as `tapeId:atMs`, so a hit opens the tape at that moment). Never media. */
  searchProvider(): SearchProvider {
    const scope = (owner: string): Scope[] => [{ kind: 'personal', ownerId: owner }];
    const one = (key: string) => {
      const [tapeId = "", at] = key.split(":");
      const t = this.db.prepare('SELECT * FROM rec_tapes WHERE id = ?').get(tapeId) as Raw | undefined;
      if (!t) return null;
      if (at === undefined) return { entityId: key, title: `Study Tape: ${t.title}`, body: '', updatedAt: t.updated_at, scopes: scope(t.owner_id) };
      const e = this.db.prepare('SELECT * FROM rec_events WHERE tape_id = ? AND at_ms = ? ORDER BY created_at LIMIT 1').get(tapeId, Number(at)) as { kind: TapeEventKind; text: string; at_ms: number } | undefined;
      return e ? { entityId: key, title: `${t.title} · ${clock(e.at_ms)} ${LABEL[e.kind]}`, body: e.text, updatedAt: t.updated_at, scopes: scope(t.owner_id) } : null;
    };
    const keysOf = (tapeId: string) => [tapeId, ...(this.db.prepare('SELECT DISTINCT at_ms a FROM rec_events WHERE tape_id = ?').all(tapeId) as { a: number }[]).map((x) => `${tapeId}:${x.a}`)];
    return {
      module: 'recordings', one,
      // a tape change re-indexes the tape document; event documents are re-read on rebuild (and by id below)
      events: [{ def: TapeChanged as never, entityId: (e: never) => (e as { tapeId: string }).tapeId }],
      all: () => (this.db.prepare('SELECT id FROM rec_tapes').all() as { id: string }[]).flatMap((r) => keysOf(r.id)).map(one).filter((d) => !!d),
    };
  }
  /** Keys of a tape's event documents (the host composes re-indexing of events on change). */
  eventKeys(tapeId: string) { return (this.db.prepare('SELECT DISTINCT at_ms a FROM rec_events WHERE tape_id = ?').all(tapeId) as { a: number }[]).map((x) => `${tapeId}:${x.a}`); }
}
