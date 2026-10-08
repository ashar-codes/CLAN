// Phone Guide (pure): Ask CLAN over this phone's own study data, with the same grounded prompting, citation parsing and
// proposal rules as desktop (@classroom/protocol ai.ts). Sources are built locally and bounded; nothing leaves the phone
// except the selected passages sent to the provider the student configured. Drafted cards stay drafts until accepted.
import { FlashcardDrafts, groundedMessages, parseGrounded, parseJson, structuredMessages, validCites, TOPIC_STATE_LABEL, type AIProvider, type GroundedAnswer, type PromptSource } from '@classroom/protocol';
import { S, type StudyState } from './model';

export type PhoneScope = { kind: 'global' } | { kind: 'course'; courseId: string } | { kind: 'exam'; examId: string };
export type PhoneCitation = { n: number; label: string; excerpt: string };
const day = (t: number) => new Date(t).toLocaleDateString('en-CA');

/** Candidate passages from the phone's study data in scope (course structure with the student's marks, exams, tasks, cards, linked items). */
export function phoneSources(s: StudyState, scope: PhoneScope): { label: string; text: string }[] {
  const courseIds = scope.kind === 'course' ? [scope.courseId] : scope.kind === 'exam' ? [s.exams.find((e) => e.id === scope.examId)?.courseId].filter(Boolean) as string[] : s.courses.map((c) => c.id);
  const out: { label: string; text: string }[] = [];
  for (const id of courseIds) {
    const c = s.courses.find((x) => x.id === id); if (!c) continue;
    out.push({ label: `Study data: ${c.name}`, text: [`${c.name}${c.code ? ` (${c.code})` : ''}`, ...S.topics(s, id).map((t, i) => `${i + 1}. ${t.title} — marked: ${TOPIC_STATE_LABEL[t.state]}`)].join('\n') });
    for (const e of s.exams.filter((x) => x.courseId === id)) out.push({ label: `Exam: ${e.name}`, text: `${e.name} on ${day(e.at)} (${e.status}). Topics in scope: ${e.topicIds.map((t) => s.topics.find((x) => x.id === t)?.title).filter(Boolean).join(', ') || 'none'}.` });
    for (const t of s.tasks.filter((x) => x.courseId === id && (x.status === 'todo' || x.status === 'in_progress'))) out.push({ label: `Task: ${t.title}`, text: `${t.title}${t.dueAt ? ` due ${day(t.dueAt)}` : ''}` });
    for (const d of s.decks.filter((x) => x.courseId === id)) for (const k of s.cards.filter((x) => x.deckId === d.id).slice(0, 50)) out.push({ label: `Card: ${d.name}`, text: `${k.front} — ${k.back}` });
    for (const l of s.links.filter((x) => x.courseId === id)) out.push({ label: l.module === 'file' ? `File: ${l.title}` : `Saved: ${l.title} (link only)`, text: l.title });
  }
  return out;
}
/** Lexical selection, bounded (no model involved; works offline). */
export function selectPassages(cands: { label: string; text: string }[], query: string, max = 10): PromptSource[] {
  const q = new Set((query.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map((w) => w.replace(/(?:es|s)$/, '')));
  const score = (t: string) => (t.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter((w) => q.has(w.replace(/(?:es|s)$/, ''))).length;
  const ranked = cands.map((c) => ({ c, s: score(`${c.label} ${c.text}`) })).sort((a, b) => b.s - a.s);
  const chosen = (q.size ? ranked.filter((r) => r.s > 0) : ranked).slice(0, max);
  let budget = 8000;
  return chosen.flatMap(({ c }, i) => { const text = c.text.slice(0, Math.max(0, Math.min(1500, budget))); budget -= text.length; return text ? [{ n: i + 1, label: c.label, text }] : []; });
}

export async function ask(provider: AIProvider, s: StudyState, scope: PhoneScope, question: string, o: { signal?: AbortSignal; onDelta?(t: string): void } = {}): Promise<{ answer: GroundedAnswer; citations: PhoneCitation[] }> {
  const sources = selectPassages(phoneSources(s, scope), question);
  if (!sources.length) return { answer: { material: [], general: null, notFound: true, unsupported: [] }, citations: [] };
  const r = await provider.generate({ messages: groundedMessages({ task: "ask — Answer the student's question from their sources.", question, sources, allowGeneral: false }), signal: o.signal, onDelta: o.onDelta });
  const answer = parseGrounded(r.text, sources.map((x) => x.n), false);
  const used = new Set(answer.material.flatMap((m) => m.cites));
  return { answer, citations: sources.filter((x) => used.has(x.n)).map((x) => ({ n: x.n, label: x.label, excerpt: x.text.slice(0, 200) })) };
}

/** Draft cards from the course's phone data; returned as drafts only. */
export async function draftCards(provider: AIProvider, s: StudyState, courseId: string, signal?: AbortSignal) {
  const sources = selectPassages(phoneSources(s, { kind: 'course', courseId }), '', 12), valid = new Set(sources.map((x) => x.n));
  if (!sources.length) return [];
  const r = await provider.generate({ json: true, signal, messages: structuredMessages({ task: 'flashcards — Draft flashcards (front = question, back = answer).', schema: '{"cards":[{"front":string,"back":string,"cites":number[]}]}', sources, input: 'Up to 10 cards.' }) });
  return parseJson(r.text, FlashcardDrafts).cards.map((c) => ({ ...c, cites: validCites(c.cites, valid) })).filter((c) => c.cites.length)
    .map((c) => ({ front: c.front, back: c.back, from: sources[c.cites[0]! - 1]!.label }));
}
