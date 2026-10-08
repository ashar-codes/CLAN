// AIContext: permission-aware source selection. It never touches another module's tables: every candidate comes from
// that module's public API called as the agent principal (so membership, direct-chat participation, agent scopes and
// the Diary grant are all enforced by their owners). Recomputed on every request, so permission changes apply at once.
import type { Principal } from '../../core/permissions.ts';
import { userOf } from '../../core/permissions.ts';
import type { ContextBroker } from '../../core/context.ts';
import type { ResourceStore } from '../../core/resources.ts';
import type { Clans } from '../clans/index.ts';
import type { Courses } from '../courses/index.ts';
import type { Notes } from '../notes/index.ts';
import type { Files } from '../files/index.ts';
import type { Saved } from '../saved/index.ts';
import type { Chat } from '../chat/index.ts';
import type { Exams } from '../exams/index.ts';
import type { Tasks } from '../tasks/index.ts';
import type { Flashcards } from '../flashcards/index.ts';
import type { Study } from '../study/index.ts';
import { TOPIC_STATE_LABEL } from '@classroom/protocol';
import { extractFile, markdown, type Extracted } from './extract.ts';
import { may, type SourceKind } from './agents.ts';

export type Deps = { clans: Clans; courses: Courses; notes: Notes; files: Files; saved: Saved; chat: Chat; exams: Exams; tasks: Tasks; flashcards: Flashcards; study: Study; store: ResourceStore; broker: ContextBroker };
export type AIScope =
  | { kind: 'global' } | { kind: 'course'; courseId: string; topicId?: string | null } | { kind: 'lecture'; courseId: string; lectureId: string }
  | { kind: 'exam'; examId: string } | { kind: 'note'; noteId: string; courseId?: string | null; lectureId?: string | null } | { kind: 'resource'; refId: string }
  | { kind: 'saved'; savedId: string } | { kind: 'clan'; clanId: string; threadId?: string | null } | { kind: 'search'; hits: { module: string; entityId: string }[] };
/** Where a citation opens. */
export type OpenTarget = { module: 'notes'; id: string } | { module: 'files'; refId: string; page?: number | null } | { module: 'saved'; id: string }
  | { module: 'chat'; clanId: string; threadId: string; messageId: string } | { module: 'courses'; courseId: string } | { module: 'exams'; examId: string } | { module: 'diary'; day: string };
export type Candidate = { key: string; kind: SourceKind; group: string; label: string; version: string; open: OpenTarget; pinned?: boolean; paper?: boolean; load(): Promise<Extracted> | Extracted };
export type Include = Record<SourceKind, boolean>;
export const DEFAULT_INCLUDE: Include = { notes: true, resources: true, saved: true, classroom: true, chat: false, study: true, diary: false };
const GROUP: Record<SourceKind, string> = { notes: 'My notes', resources: 'Files', saved: 'Saved material', classroom: 'Classroom material', chat: 'Chat', study: 'Study data', diary: 'Diary' };

const text = (t: string): Extracted => (t.trim() ? markdown(t) : { status: 'no_text', sections: [] });
const day = (t: number) => new Date(t).toLocaleDateString('en-CA');

export function select(m: Deps, a: Principal & { kind: 'agent' }, scope: AIScope, inc: Include, reads: SourceKind[]): { candidates: Candidate[]; notes: string[]; diaryIncluded: boolean } {
  const u = userOf(a), me = { kind: 'user' as const, userId: u };
  const on = (k: SourceKind) => inc[k] && reads.includes(k);
  const out = new Map<string, Candidate>(); const notes: string[] = [];
  const add = (c: Candidate) => { const prev = out.get(c.key); if (!prev) out.set(c.key, c); else if (c.pinned) prev.pinned = true; };

  const note = (id: string, kind: SourceKind = 'notes', pinned = false) => {
    if (!on(kind) && !pinned) return; const n = m.notes.get(a, id); if (!n) return;
    const theirs = n.ownerId !== u;
    add({ key: `note:${n.id}`, kind: theirs ? 'classroom' : kind, group: theirs ? GROUP.classroom : GROUP[kind], label: theirs ? `Note: ${n.title}` : `My Note: ${n.title}`, version: String(n.updatedAt), open: { module: 'notes', id: n.id }, pinned, load: () => text(`${n.title}\n${n.body}`) });
  };
  const file = (refId: string, kind: SourceKind = 'resources', pinned = false, paper = false) => {
    if (!on(kind) && !pinned) return; const f = m.files.get(a, refId); if (!f) return;
    const o = m.store.object(f.objectId); if (!o) return;
    // One candidate per canonical object, however many places reference it.
    add({ key: `obj:${o.id}`, kind: f.scope.kind === 'clan' ? 'classroom' : kind, group: f.scope.kind === 'clan' ? GROUP.classroom : GROUP[kind], label: f.name, version: o.sha256, open: { module: 'files', refId }, pinned, paper, load: () => extractFile(o.location, f.name, f.mime || o.mime) });
  };
  const saved = (id: string, pinned = false) => {
    if (!on('saved') && !pinned) return; const s = m.saved.get(a, id); if (!s) return;
    // CLAN has only the link and what the student wrote — never the page or video itself.
    add({ key: `saved:${s.id}`, kind: 'saved', group: GROUP.saved, label: `Saved: ${s.title} (link only)`, version: `${s.createdAt}:${s.note.length}:${s.title}`, open: { module: 'saved', id: s.id }, pinned,
      load: () => text(`Saved link: ${s.title}\nSource: ${s.source}\nAddress: ${s.url}\n${s.note ? `My note about it: ${s.note}` : ''}\n(Only the link and this note are stored; the linked content itself is not available to CLAN.)`) });
  };
  const studyData = (courseId: string) => {
    if (!on('study') || !may(a, 'courses:read')) return;
    let c; try { c = m.courses.mine(me, courseId); } catch { return; }
    const topics = m.courses.topics(me, c.id), lectures = m.courses.lectures(me, c.id);
    const exams = may(a, 'exams:read') ? m.exams.list(a, { courseId: c.id }) : [], tasks = may(a, 'tasks:read') ? m.tasks.list(a, { courseId: c.id, open: true, limit: 50 }) : [];
    const sessions = m.study.recent(me, { courseId: c.id, limit: 50 }), due = may(a, 'flashcards:read') ? m.flashcards.dueCount(a, { courseId: c.id }) : 0;
    const body = [`# ${c.name}${c.code ? ` (${c.code})` : ''}`, c.instructor && `Instructor: ${c.instructor}`, c.term && `Term: ${c.term}`, c.schedule && `Schedule: ${c.schedule}`,
      '## Topics (in the student\'s order, with the student\'s own marks)', ...topics.map((t, i) => `${i + 1}. ${t.title} — marked: ${TOPIC_STATE_LABEL[t.state]}`),
      lectures.length ? '## Lectures' : '', ...lectures.map((l) => `- ${l.title}${l.at ? ` (${day(l.at)})` : ''} — ${l.status}`),
      exams.length ? '## Exams' : '', ...exams.map((e) => `- ${e.name} on ${day(e.at)} (${e.status}); topics in scope: ${e.topicIds.map((t) => topics.find((x) => x.id === t)?.title).filter(Boolean).join(', ') || 'none chosen'}`),
      tasks.length ? '## Open tasks' : '', ...tasks.map((t) => `- ${t.title}${t.dueAt ? ` (due ${day(t.dueAt)})` : ''}`),
      `## Study`, `Completed study sessions recorded: ${sessions.length}, ${Math.round(sessions.reduce((n, s) => n + ((s.endedAt ?? 0) - (s.startedAt ?? 0)), 0) / 60_000)} minutes. Flashcards due now: ${due}.`].filter(Boolean).join('\n');
    add({ key: `course:${c.id}`, kind: 'study', group: GROUP.study, label: `Study data: ${c.name}`, version: `${c.updatedAt}:${body.length}:${hash(body)}`, open: { module: 'courses', courseId: c.id }, load: () => text(body) });
  };
  const courseRefs = (courseId: string, o: { topicIds?: string[]; lectureId?: string } = {}) => {
    let links; try { links = m.courses.links(me, courseId); } catch { return; }
    for (const l of links) {
      if (l.missing) continue;
      if (o.lectureId && l.lectureId !== o.lectureId && !(l.topicId && o.topicIds?.includes(l.topicId))) continue;
      if (!o.lectureId && o.topicIds && l.topicId && !o.topicIds.includes(l.topicId)) continue;
      if (l.module === 'notes') note(l.entityId); else if (l.module === 'saved') saved(l.entityId); else file(l.entityId, 'resources', false, l.kind === 'past_paper');
    }
  };
  const classroom = (clanId: string | null) => {
    if (!clanId || !on('classroom')) return;
    for (const f of m.files.list(a, { kind: 'clan', clanId }).slice(0, 200)) file(f.refId, 'classroom');
    for (const n of m.notes.inClan(a, clanId).slice(0, 200)) note(n.id, 'classroom');
  };
  const chat = (clanId: string, threadId?: string | null, pinned = false) => {
    if (!(on('chat') || pinned) || !may(a, 'chat:read')) return;
    const clan = m.clans.get(clanId); if (!clan) return;
    for (const t of m.chat.localThreads(a, clanId)) { // only conversations this person may read (direct: participants only)
      if (threadId && t.id !== threadId) continue;
      for (const msg of m.chat.localPage(a, t.id, { limit: 200 })) {
        if (!msg.body || msg.removed) continue;
        add({ key: `chat:${msg.id}`, kind: 'chat', group: GROUP.chat, label: `${clan.name} · ${t.kind === 'direct' ? `direct with ${t.with?.name ?? 'someone'}` : msg.authorName} · message`, version: String(msg.editedAt ?? msg.createdAt),
          open: { module: 'chat', clanId, threadId: t.id, messageId: msg.id }, pinned, load: () => text(`${msg.authorName}: ${msg.body}`) });
      }
    }
  };

  switch (scope.kind) {
    case 'global':
      for (const n of m.notes.mine(a, 500)) note(n.id);
      for (const f of m.files.list(a, { kind: 'personal', ownerId: u }).slice(0, 300)) file(f.refId);
      for (const s of m.saved.items(a).slice(0, 300)) saved(s.id);
      for (const c of m.courses.list(me)) { studyData(c.id); courseRefs(c.id); classroom(c.clanId); }
      for (const c of m.clans.list(u)) { classroom(c.type === 'CLASSROOM' ? c.id : null); if (on('chat')) chat(c.id); }
      break;
    case 'course': {
      let c; try { c = m.courses.mine(me, scope.courseId); } catch { break; }
      studyData(c.id); courseRefs(c.id, scope.topicId ? { topicIds: [scope.topicId] } : {}); classroom(c.clanId); if (c.clanId) chat(c.clanId);
      break;
    }
    case 'lecture': {
      let l; try { l = m.courses.lectures(me, scope.courseId).find((x) => x.id === scope.lectureId); } catch { break; }
      if (!l) break;
      studyData(scope.courseId); courseRefs(scope.courseId, { lectureId: l.id, topicIds: l.topicIds });
      break;
    }
    case 'exam': {
      const e = may(a, 'exams:read') ? m.exams.get(a, scope.examId) : null;
      if (!e) { notes.push('That exam is not available.'); break; }
      studyData(e.courseId); courseRefs(e.courseId, e.topicIds.length ? { topicIds: e.topicIds } : {});
      for (const r of e.refs) { if (r.module === 'notes') note(r.entityId); else if (r.module === 'saved') saved(r.entityId); else file(r.entityId); }
      break;
    }
    case 'note': {
      note(scope.noteId, 'notes', true);
      if (scope.courseId) { if (scope.lectureId) { const l = m.courses.lectures(me, scope.courseId).find((x) => x.id === scope.lectureId); courseRefs(scope.courseId, { lectureId: scope.lectureId, topicIds: l?.topicIds ?? [] }); } else courseRefs(scope.courseId); }
      break;
    }
    case 'resource': file(scope.refId, 'resources', true); break;
    case 'saved': saved(scope.savedId, true); break;
    case 'clan':
      if (!m.clans.isActiveMember(scope.clanId, u)) { notes.push('You are not a member of that CLAN.'); break; }
      chat(scope.clanId, scope.threadId, !!scope.threadId); classroom(scope.clanId);
      if (on('notes')) for (const n of m.notes.inClan(a, scope.clanId).slice(0, 100)) note(n.id, 'notes');
      break;
    case 'search':
      for (const h of scope.hits.slice(0, 30)) {
        if (h.module === 'notes') note(h.entityId); else if (h.module === 'saved') saved(h.entityId); else if (h.module === 'courses') studyData(h.entityId);
        else if (h.module === 'chat' && on('chat')) { const r = m.chat.concernsLocal(h.entityId); if (r && r.me && userOf(a) === u) chat(r.thread.clanId, r.thread.id); }
      }
      break;
  }

  // Diary: only with the explicit, unexpired grant (checked by the broker) AND only when the student included it here.
  let diaryIncluded = false;
  if (inc.diary) {
    if (!reads.includes('diary')) notes.push('This assistant never reads your Diary.');
    else {
      const r = m.broker.request(a, { module: 'diary', limit: 7 });
      if (r.status === 'DENIED') notes.push('Diary not included: you have not allowed AI to read it (Me › Privacy).');
      else { diaryIncluded = true; for (const d of r.items) add({ key: `diary:${d.entityId}`, kind: 'diary', group: GROUP.diary, label: `Diary · ${d.title}`, version: hash(d.excerpt), open: { module: 'diary', day: d.title }, load: () => text(d.excerpt) }); }
    }
  }
  return { candidates: [...out.values()], notes, diaryIncluded };
}

export function groups(cands: Candidate[], inc: Include, reads: SourceKind[], diaryAllowed: boolean) {
  return (Object.keys(GROUP) as SourceKind[]).filter((k) => reads.includes(k)).map((k) => ({
    kind: k, label: GROUP[k], included: inc[k] && (k !== 'diary' || diaryAllowed), count: cands.filter((c) => c.kind === k).length,
    available: k !== 'diary' || diaryAllowed, examples: cands.filter((c) => c.kind === k).slice(0, 4).map((c) => c.label),
  }));
}
export const hash = (s: string) => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return (h >>> 0).toString(36); };
