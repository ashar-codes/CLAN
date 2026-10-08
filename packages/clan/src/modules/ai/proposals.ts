// AIProposal: suggestions that change nothing until the student accepts them. Payloads are typed per kind and validated
// on creation AND again on acceptance (with the student's edits), then applied through the owning module's public API
// as the student — the AI layer has no write path of its own into academic data.
import { randomUUID } from 'node:crypto';
import { ProposalPayload, PROPOSAL_KINDS, type Citation, type ProposalKind } from '@classroom/protocol';
import { tx, type Db } from '../../core/db.ts';
import type { Principal } from '../../core/permissions.ts';
import type { Courses } from '../courses/index.ts';
import type { Exams } from '../exams/index.ts';
import type { Flashcards } from '../flashcards/index.ts';
import type { Notes } from '../notes/index.ts';
import type { Reminders } from '../reminders/index.ts';
import type { Study } from '../study/index.ts';
import type { Tasks } from '../tasks/index.ts';
import { AGENTS } from './agents.ts';

export type ProposalView = { id: string; agent: string; kind: ProposalKind; payload: unknown; sources: Citation[]; explanation: string; status: 'pending' | 'accepted' | 'dismissed' | 'expired'; createdAt: number; expiresAt: number; result: unknown };
type Row = { id: string; owner_id: string; agent: string; kind: ProposalKind; payload: string; sources: string; explanation: string; status: ProposalView['status']; created_at: number; expires_at: number; result: string | null };
type M = { courses: Courses; exams: Exams; flashcards: Flashcards; notes: Notes; reminders: Reminders; study: Study; tasks: Tasks };
const TTL = 14 * 86_400_000;

export class Proposals {
  private db: Db; private m: M; private now: () => number;
  constructor(db: Db, m: M, now = () => Date.now()) { this.db = db; this.m = m; this.now = now; }

  /** Only an agent allowed to propose `kind` can; the payload must validate. Nothing else happens. */
  create(ownerId: string, agentId: string, kind: ProposalKind, payload: unknown, sources: Citation[], explanation: string): ProposalView {
    const agent = AGENTS.find((a) => a.id === agentId);
    if (!PROPOSAL_KINDS.includes(kind)) throw new Error('Unknown proposal kind.');
    if (!agent || !agent.proposals.includes(kind)) throw new Error(`${agent?.name ?? 'This assistant'} may not propose that.`);
    const data = ProposalPayload[kind].parse(payload);
    const id = randomUUID(), t = this.now();
    this.db.prepare('INSERT INTO ai_proposals (id, owner_id, agent, kind, payload, sources, explanation, status, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, ownerId, agentId, kind, JSON.stringify(data), JSON.stringify(sources.slice(0, 40)), explanation.slice(0, 2000), 'pending', t, t + TTL);
    return this.get({ kind: 'user', userId: ownerId }, id)!;
  }
  get(p: Principal, id: string) { const r = this.db.prepare('SELECT * FROM ai_proposals WHERE id = ? AND owner_id = ?').get(id, p.kind === 'user' ? p.userId : '') as Row | undefined; return r ? this.view(r) : null; }
  list(p: Principal, status: ProposalView['status'] | 'all' = 'pending') {
    if (p.kind !== 'user') return [];
    this.db.prepare("UPDATE ai_proposals SET status = 'expired' WHERE owner_id = ? AND status = 'pending' AND expires_at < ?").run(p.userId, this.now());
    return (this.db.prepare(`SELECT * FROM ai_proposals WHERE owner_id = ? ${status === 'all' ? '' : 'AND status = ?'} ORDER BY created_at DESC LIMIT 100`).all(...[p.userId, ...(status === 'all' ? [] : [status])]) as Row[]).map((r) => this.view(r));
  }
  dismiss(p: Principal, id: string) { this.must(p, id); this.db.prepare("UPDATE ai_proposals SET status = 'dismissed', decided_at = ? WHERE id = ? AND status = 'pending'").run(this.now(), id); }

  /**
   * The student accepts (optionally edited). Re-validated against the kind's schema, then applied by the owning modules
   * as the student, all-or-nothing. Agents can never accept.
   */
  accept(p: Principal, id: string, edited?: unknown) {
    if (p.kind !== 'user') throw new Error('Only you can accept a suggestion.');
    const r = this.must(p, id);
    if (r.status !== 'pending') throw new Error(r.status === 'expired' ? 'This suggestion expired.' : 'This suggestion was already handled.');
    if (r.expires_at < this.now()) { this.db.prepare("UPDATE ai_proposals SET status = 'expired' WHERE id = ?").run(id); throw new Error('This suggestion expired.'); }
    const kind = r.kind;
    const data = ProposalPayload[kind].parse(edited ?? JSON.parse(r.payload)) as never;
    const result = tx(this.db, () => {
      const out = this.apply(p, kind, data);
      this.db.prepare("UPDATE ai_proposals SET status = 'accepted', decided_at = ?, payload = ?, result = ? WHERE id = ?").run(this.now(), JSON.stringify(data), JSON.stringify(out), id);
      return out;
    });
    return { ...this.get(p, id)!, result };
  }

  private apply(p: Principal & { kind: 'user' }, kind: ProposalKind, d: never): unknown {
    const m = this.m;
    switch (kind) {
      case 'CREATE_FLASHCARDS': {
        const x = d as { deckId: string | null; deckName: string; courseId: string | null; topicId: string | null; examId: string | null; cards: { front: string; back: string; source: { module: 'notes' | 'files' | 'saved'; id: string } | null; from: string }[] };
        const deckId = x.deckId ?? m.flashcards.createDeck(p, { name: x.deckName || 'Drafted cards', courseId: x.courseId, topicId: x.topicId, examId: x.examId }).id;
        return { deckId, cards: x.cards.map((c) => m.flashcards.addCard(p, deckId, { front: c.front, back: c.back, note: c.from ? `Drafted with CLAN from ${c.from}` : 'Drafted with CLAN', ...(c.source ? { ref: c.source } : {}) }).id) };
      }
      case 'CREATE_TASKS': return { tasks: (d as { tasks: { title: string; courseId: string | null; topicId: string | null; dueAt: number | null; checklist: string[] }[] }).tasks.map((t) => m.tasks.create(p, t).id) };
      case 'CREATE_REMINDERS': return { reminders: (d as { reminders: { text: string; dueAt: number; target: { module: string; id: string } | null }[] }).reminders.map((r) => m.reminders.create(p, { text: r.text, dueAt: r.dueAt, ...(r.target ? { target: r.target } : {}) }).id) };
      case 'CREATE_STUDY_PLAN': {
        const x = d as { courseId: string | null; sessions: { at: number; minutes: number; topicId: string | null; goal: string }[] };
        return { sessions: x.sessions.map((s) => m.study.plan(p, { courseId: x.courseId, topicId: s.topicId, goal: s.goal, at: s.at, minutes: s.minutes }).id) };
      }
      case 'APPEND_NOTE': {
        const x = d as { mode: 'append' | 'insert' | 'new'; noteId: string | null; title: string; text: string; at: number | null };
        if (x.mode === 'new' || !x.noteId) return { noteId: m.notes.create(p, { title: x.title || 'From CLAN', body: x.text }).id };
        const n = m.notes.get(p, x.noteId); if (!n) throw new Error('Note not found.');
        const body = x.mode === 'append' ? `${n.body.replace(/\s+$/, '')}\n\n${x.text}` : `${n.body.slice(0, x.at ?? n.body.length)}${x.text}${n.body.slice(x.at ?? n.body.length)}`;
        m.notes.update(p, n.id, { body }); return { noteId: n.id };
      }
      case 'UPDATE_TOPIC_CONFIDENCE': { const x = d as { topicId: string; state: 'not_started' | 'learning' | 'review' | 'confident' }; m.courses.setConfidence(p, x.topicId, x.state); return { topicId: x.topicId }; }
      case 'ADD_EXAM_SCOPE': {
        const x = d as { examId: string; topicIds: string[] };
        const e = m.exams.get(p, x.examId); if (!e) throw new Error('Exam not found.');
        return { topicIds: m.exams.update(p, e.id, { topicIds: [...new Set([...e.topicIds, ...x.topicIds])] }).topicIds };
      }
    }
  }
  private must(p: Principal, id: string) { const r = this.db.prepare('SELECT * FROM ai_proposals WHERE id = ? AND owner_id = ?').get(id, p.kind === 'user' ? p.userId : '') as Row | undefined; if (!r) throw new Error('Suggestion not found.'); return r; }
  private view(r: Row): ProposalView { return { id: r.id, agent: r.agent, kind: r.kind, payload: JSON.parse(r.payload), sources: JSON.parse(r.sources), explanation: r.explanation, status: r.status, createdAt: r.created_at, expiresAt: r.expires_at, result: r.result ? JSON.parse(r.result) : null }; }
}
