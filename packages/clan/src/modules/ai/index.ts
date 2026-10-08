// CLAN Intelligence: Ask CLAN / Ask this document / note actions / Compare My Notes / Quiz Me / draft flashcards /
// Prepare Lecture / past-paper analysis / Exam Coach — over the student's own permitted material.
// Boundaries: AIProvider (protocol/ai.ts; the host injects one or none) · AIContext (context.ts) · Retrieval
// (retrieval.ts) · AIProposal (proposals.ts) · AIConversation (here). No product module calls a provider, and this
// module never writes another module's data except through an accepted proposal.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  AI_SETUP, AI_UNAVAILABLE, AIError, CompareOut, FlashcardDrafts, LectureOut, PaperTopicsOut, PlanOut, QuizOut, TOPIC_STATE_LABEL,
  groundedMessages, parseGrounded, parseJson, structuredMessages, validCites,
  type AIMessage, type AIProvider, type Citation, type GroundedAnswer, type PromptSource, type ProposalKind,
} from '@classroom/protocol';
import type { Db, ModuleSchema } from '../../core/db.ts';
import { userOf, type Permissions, type Principal } from '../../core/permissions.ts';
import type { Reminders } from '../reminders/index.ts';
import { agentFor, principalFor, AGENTS, type Action, type AgentDefinition, type SourceKind } from './agents.ts';
import { select, groups, DEFAULT_INCLUDE, type AIScope, type Candidate, type Deps, type Include, type OpenTarget } from './context.ts';
import { KnowledgeIndex, fuse, type Passage } from './retrieval.ts';
import { Proposals, type ProposalView } from './proposals.ts';

export const schema: ModuleSchema = {
  module: 'ai', prefix: 'ai',
  migrations: [`
    CREATE TABLE ai_settings (user_id TEXT PRIMARY KEY, json TEXT NOT NULL);
    -- knowledge index (projection; rebuildable): one row per canonical content version
    CREATE TABLE ai_sources (key TEXT PRIMARY KEY, kind TEXT NOT NULL, version TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
      chars INTEGER NOT NULL DEFAULT 0, chunks INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER NOT NULL, used_at INTEGER NOT NULL);
    CREATE INDEX ai_sources_used ON ai_sources(used_at);
    CREATE TABLE ai_chunks (id INTEGER PRIMARY KEY, source_key TEXT NOT NULL, ord INTEGER NOT NULL, page INTEGER, section TEXT,
      start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL);
    CREATE INDEX ai_chunks_source ON ai_chunks(source_key, ord);
    CREATE VIRTUAL TABLE ai_fts USING fts5(text, content='ai_chunks', content_rowid='id', tokenize='porter unicode61');
    CREATE TABLE ai_vectors (chunk_id INTEGER NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (chunk_id, model));
    -- conversations, proposals and analysis results (owned here; academic data stays in its modules)
    CREATE TABLE ai_conversations (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX ai_conversations_owner ON ai_conversations(owner_id, updated_at);
    CREATE TABLE ai_turns (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES ai_conversations(id), role TEXT NOT NULL CHECK (role IN ('user','assistant')), text TEXT NOT NULL, data TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX ai_turns_conv ON ai_turns(conversation_id, created_at);
    CREATE TABLE ai_proposals (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, agent TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, sources TEXT NOT NULL,
      explanation TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('pending','accepted','dismissed','expired')), created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, decided_at INTEGER, result TEXT);
    CREATE INDEX ai_proposals_owner ON ai_proposals(owner_id, status, created_at);
    CREATE TABLE ai_quizzes (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope TEXT NOT NULL, questions TEXT NOT NULL, citations TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE ai_quiz_attempts (id TEXT PRIMARY KEY, quiz_id TEXT NOT NULL REFERENCES ai_quizzes(id), owner_id TEXT NOT NULL, answers TEXT NOT NULL, score INTEGER NOT NULL, total INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE ai_paper_questions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source_key TEXT NOT NULL, version TEXT NOT NULL, ref_id TEXT NOT NULL, n INTEGER NOT NULL, page INTEGER,
      start INTEGER NOT NULL, end INTEGER NOT NULL, suggested_topic TEXT, confidence TEXT, method TEXT, topic_id TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX ai_paper_questions_src ON ai_paper_questions(owner_id, source_key, n);
    CREATE TABLE ai_usage (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, at INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, action TEXT NOT NULL,
      input_tokens INTEGER, output_tokens INTEGER, sources INTEGER NOT NULL, ms INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE INDEX ai_usage_owner ON ai_usage(owner_id, at);
  `],
};

export type ProviderSettings = { kind: 'none' | 'openai-compatible' | 'local'; label: string; baseUrl: string; model: string; embeddingModel: string | null };
export type AISettings = { provider: ProviderSettings; generalKnowledge: boolean; useEmbeddings: boolean; include: Partial<Record<AIScope['kind'], Partial<Include>>> };
const SettingsIn = z.object({
  provider: z.object({ kind: z.enum(['none', 'openai-compatible', 'local']), label: z.string().trim().max(80).default(''), baseUrl: z.string().trim().max(300).default(''), model: z.string().trim().max(120).default(''), embeddingModel: z.string().trim().max(120).nullable().default(null) }),
  generalKnowledge: z.boolean(), useEmbeddings: z.boolean(), include: z.record(z.string(), z.record(z.string(), z.boolean())).default({}),
}).partial();
const DEFAULT_SETTINGS: AISettings = { provider: { kind: 'none', label: '', baseUrl: '', model: '', embeddingModel: null }, generalKnowledge: false, useEmbeddings: false, include: {} };

export type AIRequest = {
  action: Action; scope: AIScope; include?: Partial<Include>; question?: string; selection?: string; agent?: string;
  conversationId?: string | null; count?: number; deckId?: string | null;
};
export type SourceUse = { key: string; label: string; group: string; open: OpenTarget; status: string; reason: string | null };
export type Preview = { agent: Pick<AgentDefinition, 'id' | 'name' | 'cannot'>; groups: ReturnType<typeof groups>; include: Include; notes: string[]; diaryIncluded: boolean; sources: number };
export type RunResult = {
  status: 'ok' | 'unavailable' | 'error' | 'cancelled' | 'empty';
  action: Action; message: string | null; errorCode?: string;
  answer?: GroundedAnswer; citations: Citation[];
  /** Retrieved passages: always available offline, even without a model. */
  passages: Citation[];
  data?: unknown; proposals: ProposalView[]; conversationId: string | null;
  used: SourceUse[]; diaryIncluded: boolean; notes: string[];
  provider: { label: string; model: string; local: boolean } | null; usage: { inputTokens: number | null; outputTokens: number | null } | null; ms: number;
};
type Run = { signal?: AbortSignal; onDelta?(t: string): void };

const TEXT_ACTIONS: Action[] = ['ask', 'askDocument', 'explain', 'summarize', 'simplify', 'chatSummary'];
const TASK: Record<Action, string> = {
  ask: "ask — Answer the student's question from their sources.", askDocument: 'document — Answer about this one document; cite the page.',
  explain: 'explain — Explain the selected text or concept clearly for a student.', summarize: 'summarize — Summarize the material concisely.',
  simplify: 'simplify — Rewrite the selection in simpler words without changing its meaning.', chatSummary: 'chatSummary — Summarize the discussion; say who raised what.',
  questions: 'quiz — Turn the material into review questions.', quiz: 'quiz — Write a short quiz (mcq, short, tf) from the sources.', flashcards: 'flashcards — Draft flashcards (front = question, back = answer).',
  compare: "compare — Compare the student's NOTE with the course material.", prepareLecture: 'prepareLecture — Prepare a learning package for this lecture.',
  pastPaper: 'paperTopics — Map each exam question to the most likely topic.', examPlan: 'plan — Propose a study plan for the exam using only the listed topics.',
};
const BUDGET = { chunks: 12, chars: 14_000, perSource: 4, pinnedPerSource: 10 };
const DAY = 86_400_000;

export class AI {
  readonly index: KnowledgeIndex; readonly proposals: Proposals;
  private db: Db; private m: Deps & { reminders: Reminders }; private perms: Permissions; private now: () => number;
  private makeProvider: (s: ProviderSettings) => AIProvider | null;
  constructor(db: Db, m: Deps & { reminders: Reminders }, perms: Permissions, makeProvider: (s: ProviderSettings) => AIProvider | null, now = () => Date.now()) {
    this.db = db; this.m = m; this.perms = perms; this.now = now; this.makeProvider = makeProvider;
    this.index = new KnowledgeIndex(db, now);
    this.proposals = new Proposals(db, m, now);
  }
  agents() { return AGENTS; }

  // ---- settings (no secrets here: credentials live in the host's secure storage) ----
  settings(p: Principal): AISettings {
    const r = this.db.prepare('SELECT json FROM ai_settings WHERE user_id = ?').get(userOf(p)) as { json: string } | undefined;
    return r ? { ...DEFAULT_SETTINGS, ...JSON.parse(r.json) } : DEFAULT_SETTINGS;
  }
  setSettings(p: Principal, patch: unknown): AISettings {
    if (p.kind !== 'user') throw new Error('Only you can change AI settings.');
    const s = { ...this.settings(p), ...SettingsIn.parse(patch) } as AISettings;
    if (s.provider.kind === 'openai-compatible' && s.provider.baseUrl && !/^https?:\/\//.test(s.provider.baseUrl)) throw new Error('The provider address must start with http:// or https://.');
    this.db.prepare('INSERT INTO ai_settings (user_id, json) VALUES (?, ?) ON CONFLICT (user_id) DO UPDATE SET json = excluded.json').run(p.userId, JSON.stringify(s));
    return s;
  }
  provider(p: Principal): AIProvider | null { const s = this.settings(p).provider; return s.kind === 'none' ? null : this.makeProvider(s); }
  status(p: Principal) {
    const pr = this.provider(p);
    return { provider: pr ? { label: pr.label, model: pr.model, local: pr.caps.local } : null, message: pr ? null : AI_SETUP, diaryGranted: this.perms.hasGrant(userOf(p), 'ai', 'diary'), index: this.index.size() };
  }

  // ---- context preview ----
  private includeFor(p: Principal, scope: AIScope, req?: Partial<Include>): Include {
    const remembered = this.settings(p).include[scope.kind] ?? {};
    return { ...DEFAULT_INCLUDE, ...remembered, ...(req ?? {}) } as Include;
  }
  /** What CLAN would use for this request (no indexing, no model call). Remembers explicit choices per place — never Diary. */
  preview(p: Principal, req: Pick<AIRequest, 'action' | 'scope' | 'include' | 'agent'>): Preview {
    const u = this.user(p), agent = agentFor(req.action, req.agent), inc = this.includeFor(p, req.scope, req.include);
    if (req.include) this.remember(p, req.scope, req.include);
    const a = principalFor(agent, u, inc), diaryAllowed = this.perms.hasGrant(u, 'ai', 'diary') && agent.reads.includes('diary');
    const sel = select(this.m, a, req.scope, inc, agent.reads);
    return { agent: { id: agent.id, name: agent.name, cannot: agent.cannot }, groups: groups(sel.candidates, inc, agent.reads, diaryAllowed), include: inc, notes: sel.notes, diaryIncluded: sel.diaryIncluded, sources: sel.candidates.length };
  }
  private remember(p: Principal, scope: AIScope, inc: Partial<Include>) {
    const s = this.settings(p), keep = { ...inc }; delete keep.diary; // Diary is chosen per request, never remembered on
    this.setSettings(p, { include: { ...s.include, [scope.kind]: { ...(s.include[scope.kind] ?? {}), ...keep } } });
  }
  private user(p: Principal) { if (p.kind !== 'user') throw new Error('AI requests are made by you.'); return p.userId; }

  // ---- retrieval ----
  private async gather(p: Principal, req: AIRequest, opt: Run) {
    const u = this.user(p), agent = agentFor(req.action, req.agent), inc = this.includeFor(p, req.scope, req.include);
    if (req.include) this.remember(p, req.scope, req.include);
    const a = principalFor(agent, u, inc);
    const sel = select(this.m, a, req.scope, inc, agent.reads);
    const st = await this.index.ensure(sel.candidates);
    if (opt.signal?.aborted) throw new AIError('cancelled', 'Cancelled.');
    const usable = sel.candidates.filter((c) => st.get(c.key)?.status === 'ok');
    return { u, agent, a, sel, st, usable };
  }
  private async retrieve(p: Principal, cands: Candidate[], query: string, whole: boolean, opt: Run, limit = BUDGET.chunks, fallback = true) {
    const keys = cands.map((c) => c.key), pinned = cands.filter((c) => c.pinned).map((c) => c.key);
    let found = this.index.lexical(query, keys, 60);
    const s = this.settings(p), pr = this.provider(p);
    if (s.useEmbeddings && pr?.embed && query.trim()) {
      try {
        const model = pr.model;
        const missing = this.index.vectorsMissing(found.map((x) => x.chunkId), model).slice(0, 64);
        if (missing.length) (await pr.embed(missing.map((x) => x.text), opt.signal)).forEach((v, i) => this.index.putVector(missing[i]!.id, model, v));
        const [qv] = await pr.embed([query], opt.signal);
        if (qv) found = fuse([found, this.index.semantic(qv, keys, model)]);
      } catch { /* semantic retrieval is optional; lexical stays */ }
    }
    if (whole || (fallback && !found.length)) found = [...this.index.leading(pinned.length ? pinned : keys.slice(0, 8), pinned.length ? 6 : 2), ...found];
    const out: Passage[] = [], per = new Map<string, number>(), seen = new Set<number>(); let chars = 0;
    for (const x of found) {
      const cap = pinned.includes(x.key) ? BUDGET.pinnedPerSource : BUDGET.perSource;
      if (seen.has(x.chunkId) || (per.get(x.key) ?? 0) >= cap || chars + x.text.length > BUDGET.chars) continue;
      seen.add(x.chunkId); per.set(x.key, (per.get(x.key) ?? 0) + 1); chars += x.text.length; out.push(x);
      if (out.length >= limit) break;
    }
    return out;
  }
  private cite(n: number, x: Passage, c: Candidate | undefined): Citation {
    const label = `${c?.label ?? 'Source'}${x.page ? ` · page ${x.page}` : ''}${x.section ? ` · ${x.section}` : ''}`;
    const open: OpenTarget | undefined = c?.open && c.open.module === 'files' ? { ...c.open, page: x.page } : c?.open;
    return { n, label, module: open?.module ?? 'unknown', open: open ?? null, page: x.page, section: x.section, excerpt: x.text.slice(0, 280) };
  }

  // ---- the one entry point for generation ----
  async run(p: Principal, req: AIRequest, opt: Run = {}): Promise<RunResult> {
    const t0 = this.now();
    const base = (o: Partial<RunResult>): RunResult => ({ status: 'ok', action: req.action, message: null, citations: [], passages: [], proposals: [], conversationId: null, used: [], diaryIncluded: false, notes: [], provider: null, usage: null, ms: this.now() - t0, ...o });
    let g;
    try { g = await this.gather(p, req, opt); } catch (e) { if (e instanceof AIError && e.code === 'cancelled') return base({ status: 'cancelled', message: 'Cancelled.' }); throw e; }
    const { u, agent, sel, st, usable } = g;
    const used = sel.candidates.map((c) => ({ key: c.key, label: c.label, group: c.group, open: c.open, status: st.get(c.key)?.status ?? 'pending', reason: st.get(c.key)?.reason ?? null }));
    const common = { used, diaryIncluded: sel.diaryIncluded, notes: sel.notes };
    if (req.action === 'pastPaper') throw new Error('Use analyzePaper for past papers.');

    // Compare: the note is the input, the material is everything else.
    const noteCand = req.action === 'compare' ? sel.candidates.find((c) => c.pinned && c.key.startsWith('note:')) : undefined;
    const material = noteCand ? usable.filter((c) => c.key !== noteCand.key) : usable;
    if (req.action === 'compare' && !noteCand) return base({ ...common, status: 'error', message: 'Pick one of your notes to compare.' });
    if (req.action === 'prepareLecture' && !material.some((c) => c.kind !== 'study')) return base({ ...common, status: 'empty', message: 'No material is linked to this lecture yet. Link notes or files to it first. (No recording or transcript exists for it.)' });
    const unreadable = sel.candidates.filter((c) => c.pinned && st.get(c.key)?.status !== 'ok' && req.action !== 'compare');
    if (unreadable.length) return base({ ...common, status: 'empty', message: st.get(unreadable[0]!.key)?.reason ?? 'There is no readable text in this source.' });

    const query = [req.question, req.selection].filter(Boolean).join(' ') || this.defaultQuery(p, req);
    const whole = ['summarize', 'chatSummary', 'flashcards', 'quiz', 'questions', 'prepareLecture', 'compare'].includes(req.action) || (req.action === 'askDocument' && !req.question);
    const passages = await this.retrieve(p, material, query, whole, opt, req.action === 'chatSummary' ? 30 : BUDGET.chunks);
    const byKey = new Map(sel.candidates.map((c) => [c.key, c]));
    const cites = passages.map((x, i) => this.cite(i + 1, x, byKey.get(x.key)));
    const sources: PromptSource[] = passages.map((x, i) => ({ n: i + 1, label: cites[i]!.label, text: x.text }));
    const valid = new Set(sources.map((s) => s.n));

    const provider = this.provider(p);
    if (!provider) return base({ ...common, status: 'unavailable', message: AI_SETUP, passages: cites });
    const pinfo = { label: provider.label, model: provider.model, local: provider.caps.local };
    if (!sources.length && req.action !== 'examPlan') return base({ ...common, status: 'empty', provider: pinfo, message: 'Nothing in the selected sources matches. Try including more sources or rephrasing.' });

    const settings = this.settings(p);
    const allowGeneral = settings.generalKnowledge && ['ask', 'explain', 'simplify'].includes(req.action);
    const gen = async (messages: AIMessage[], json: boolean, stream: boolean) => provider.generate({ messages, json, maxTokens: json ? 3000 : 1500, signal: opt.signal, ...(stream && opt.onDelta ? { onDelta: opt.onDelta } : {}) });
    const record = (status: string, usage: RunResult['usage']) => this.db.prepare('INSERT INTO ai_usage (id, owner_id, at, provider, model, action, input_tokens, output_tokens, sources, ms, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), u, this.now(), provider.label, provider.model, req.action, usage?.inputTokens ?? null, usage?.outputTokens ?? null, sources.length, this.now() - t0, status);
    const structured = async <T>(messages: AIMessage[], schema: z.ZodType<T>) => {
      let r = await gen(messages, true, false);
      try { return { value: parseJson(r.text, schema), usage: r.usage }; } catch {
        r = await gen([...messages, { role: 'assistant', content: r.text.slice(0, 4000) }, { role: 'user', content: 'That was not valid JSON for the schema. Reply with the JSON object only.' }], true, false);
        return { value: parseJson(r.text, schema), usage: r.usage };
      }
    };

    try {
      if (TEXT_ACTIONS.includes(req.action)) {
        const history = req.conversationId ? this.turns(p, req.conversationId).slice(-4).map((t) => `${t.role === 'user' ? 'Student' : 'CLAN'}: ${t.text.slice(0, 600)}`).join('\n') : '';
        const question = req.question || (req.selection ? `“${req.selection.slice(0, 3000)}”` : req.action === 'summarize' || req.action === 'chatSummary' ? 'Summarize.' : 'Explain.');
        const r = await gen(groundedMessages({ task: TASK[req.action], question, sources, allowGeneral, extra: history ? `Earlier in this conversation (for context only):\n${history}` : undefined }), false, true);
        if (opt.signal?.aborted) throw new AIError('cancelled', 'Cancelled.');
        const answer = parseGrounded(r.text, [...valid], allowGeneral);
        const usedN = new Set(answer.material.flatMap((x) => x.cites));
        const conversationId = this.saveTurn(u, req, question, answer, cites.filter((c) => usedN.has(c.n)));
        record('ok', r.usage);
        return base({ ...common, answer, citations: cites.filter((c) => usedN.has(c.n)), passages: cites, conversationId, provider: pinfo, usage: r.usage,
          message: answer.notFound ? 'Your selected CLAN material does not cover this.' : null });
      }
      if (req.action === 'flashcards') {
        const r = await structured(structuredMessages({ task: TASK.flashcards, schema: '{"cards":[{"front":string,"back":string,"cites":number[]}]}', sources, input: req.question || `Up to ${Math.min(req.count ?? 12, 30)} cards.` }), FlashcardDrafts);
        if (opt.signal?.aborted) throw new AIError('cancelled', 'Cancelled.');
        const kept = r.value.cards.map((c) => ({ ...c, cites: validCites(c.cites, valid) })).filter((c) => c.cites.length);
        record('ok', r.usage);
        if (!kept.length) return base({ ...common, status: 'empty', provider: pinfo, usage: r.usage, passages: cites, message: 'No cards could be drafted that your material supports.' });
        const ctx = this.scopeIds(p, req.scope);
        const cards = kept.map((c) => { const src = byKey.get(passages[c.cites[0]! - 1]!.key); return { front: c.front, back: c.back, source: srcRef(src), from: cites[c.cites[0]! - 1]!.label }; });
        const prop = this.proposals.create(u, agent.id, 'CREATE_FLASHCARDS', { deckId: req.deckId ?? null, deckName: ctx.name ? `${ctx.name} · drafted` : 'Drafted cards', courseId: ctx.courseId, topicId: ctx.topicId, examId: ctx.examId, cards },
          cites.filter((x) => kept.some((c) => c.cites.includes(x.n))), `${cards.length} draft cards from your material. Review, edit or delete before they join a deck.`);
        return base({ ...common, data: { drafts: kept.map((c, i) => ({ ...cards[i]!, cites: c.cites })), dropped: r.value.cards.length - kept.length }, proposals: [prop], citations: cites, passages: cites, provider: pinfo, usage: r.usage });
      }
      if (req.action === 'quiz' || req.action === 'questions') {
        const r = await structured(structuredMessages({ task: TASK[req.action], schema: '{"questions":[{"type":"mcq"|"short"|"tf","question":string,"options":string[],"answer":string,"explanation":string,"topic":string,"cites":number[]}]}', sources, input: req.question || `Up to ${Math.min(req.count ?? 5, 15)} questions.` }), QuizOut);
        if (opt.signal?.aborted) throw new AIError('cancelled', 'Cancelled.');
        const qs = r.value.questions.map((q) => ({ ...q, cites: validCites(q.cites, valid) })).filter((q) => q.cites.length && (q.type !== 'mcq' || q.options.includes(q.answer)));
        record('ok', r.usage);
        if (!qs.length) return base({ ...common, status: 'empty', provider: pinfo, usage: r.usage, passages: cites, message: 'No questions could be written that your material supports.' });
        const id = randomUUID();
        this.db.prepare('INSERT INTO ai_quizzes (id, owner_id, scope, questions, citations, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, u, JSON.stringify(req.scope), JSON.stringify(qs), JSON.stringify(cites), this.now());
        return base({ ...common, data: { quizId: id, questions: qs.map((q, i) => ({ i, type: q.type, question: q.question, options: q.type === 'tf' ? ['True', 'False'] : q.options, topic: q.topic, cites: q.cites })) }, citations: cites, passages: cites, provider: pinfo, usage: r.usage });
      }
      if (req.action === 'compare') {
        const n = this.m.notes.get({ kind: 'user', userId: u }, noteCand!.key.slice(5))!;
        const r = await structured(structuredMessages({ task: TASK.compare, schema: '{"covered":[{"topic":string,"cites":number[]}],"missing":[{"concept":string,"detail":string,"cites":number[]}],"conflicts":[{"noteSays":string,"sourceSays":string,"cites":number[]}],"review":[{"section":string,"reason":string}]}', sources,
          input: `NOTE:\n${n.body.slice(0, 12_000)}\nEND NOTE\nCompare the NOTE with the sources: what the sources cover that the note misses, what the note covers, and anything in the note that conflicts with a source. Cite the source for every missing or conflicting item.` }), CompareOut);
        if (opt.signal?.aborted) throw new AIError('cancelled', 'Cancelled.');
        const fix = <T extends { cites: number[] }>(xs: T[]) => xs.map((x) => ({ ...x, cites: validCites(x.cites, valid) }));
        const missing = fix(r.value.missing), conflicts = fix(r.value.conflicts), covered = fix(r.value.covered);
        const result = { note: { id: n.id, title: n.title }, covered: covered.filter((x) => x.cites.length), missing: missing.filter((x) => x.cites.length), conflicts: conflicts.filter((x) => x.cites.length), review: r.value.review,
          unsupported: [...missing, ...conflicts].filter((x) => !x.cites.length).length };
        record('ok', r.usage);
        const proposals: ProposalView[] = [];
        const label = (c: number[]) => c.map((k) => cites[k - 1]!.label).join('; ');
        if (result.missing.length) {
          proposals.push(this.proposals.create(u, agent.id, 'APPEND_NOTE', { mode: 'append', noteId: n.id, text: `## Suggested additions (from CLAN — check before keeping)\n${result.missing.map((x) => `- **${x.concept}**${x.detail ? `: ${x.detail}` : ''} _(${label(x.cites)})_`).join('\n')}` },
            cites.filter((c) => result.missing.some((x) => x.cites.includes(c.n))), 'Adds a section listing what your sources cover and your note does not.'));
          proposals.push(this.proposals.create(u, agent.id, 'CREATE_TASKS', { tasks: [{ title: `Fill gaps in “${n.title}”`, checklist: result.missing.map((x) => x.concept.slice(0, 200)) }] },
            cites.filter((c) => result.missing.some((x) => x.cites.includes(c.n))), 'A checklist of the missing concepts.'));
        }
        return base({ ...common, data: result, proposals, citations: cites, passages: cites, provider: pinfo, usage: r.usage });
      }
      if (req.action === 'prepareLecture') {
        const r = await structured(structuredMessages({ task: TASK.prepareLecture, schema: '{"summary":[{"text":string,"cites":number[]}],"concepts":[{"term":string,"explanation":string,"cites":number[]}],"definitions":[{"term":string,"definition":string,"cites":number[]}],"details":[{"text":string,"cites":number[]}],"questions":[{"question":string,"cites":number[]}],"flashcards":[{"front":string,"back":string,"cites":number[]}],"checklist":string[]}', sources, input: 'Use only the sources. There is no recording or transcript.' }), LectureOut);
        if (opt.signal?.aborted) throw new AIError('cancelled', 'Cancelled.');
        const k = <T extends { cites: number[] }>(xs: T[]) => xs.map((x) => ({ ...x, cites: validCites(x.cites, valid) })).filter((x) => x.cites.length);
        const v = { summary: k(r.value.summary), concepts: k(r.value.concepts), definitions: k(r.value.definitions), details: k(r.value.details), questions: k(r.value.questions), flashcards: k(r.value.flashcards), checklist: r.value.checklist };
        record('ok', r.usage);
        const lec = req.scope.kind === 'lecture' ? this.m.courses.lectures({ kind: 'user', userId: u }, req.scope.courseId).find((l) => l.id === (req.scope as { lectureId: string }).lectureId) : null;
        const lab = (c: number[]) => ` _(${c.map((x) => cites[x - 1]!.label).join('; ')})_`;
        const md = [`# ${lec?.title ?? 'Lecture'} — prepared by CLAN (draft)`, `_Generated from ${new Set(passages.map((x) => x.key)).size} linked item(s). No recording or transcript exists for this lecture._`,
          v.summary.length ? '## Summary' : '', ...v.summary.map((x) => `${x.text}${lab(x.cites)}`), v.concepts.length ? '## Key concepts' : '', ...v.concepts.map((x) => `- **${x.term}**: ${x.explanation}${lab(x.cites)}`),
          v.definitions.length ? '## Definitions' : '', ...v.definitions.map((x) => `- **${x.term}**: ${x.definition}${lab(x.cites)}`), v.details.length ? '## Important details' : '', ...v.details.map((x) => `- ${x.text}${lab(x.cites)}`),
          v.questions.length ? '## Possible questions' : '', ...v.questions.map((x) => `- ${x.question}`)].filter(Boolean).join('\n\n');
        const ids = this.scopeIds(p, req.scope);
        const proposals: ProposalView[] = [];
        if (v.summary.length || v.concepts.length) proposals.push(this.proposals.create(u, agent.id, 'APPEND_NOTE', { mode: 'new', noteId: null, title: `${lec?.title ?? 'Lecture'} — prepared`, text: md }, cites, 'A new note with the summary, concepts, definitions, details and questions.'));
        if (v.flashcards.length) proposals.push(this.proposals.create(u, agent.id, 'CREATE_FLASHCARDS', { deckId: null, deckName: `${lec?.title ?? 'Lecture'} · drafted`, courseId: ids.courseId, topicId: null, examId: null, cards: v.flashcards.map((c) => ({ front: c.front, back: c.back, source: srcRef(byKey.get(passages[c.cites[0]! - 1]!.key)), from: cites[c.cites[0]! - 1]!.label })) }, cites, `${v.flashcards.length} draft flashcards.`));
        if (v.checklist.length) proposals.push(this.proposals.create(u, agent.id, 'CREATE_TASKS', { tasks: [{ title: `Revise ${lec?.title ?? 'lecture'}`, courseId: ids.courseId, checklist: v.checklist }] }, cites, 'A revision checklist task.'));
        return base({ ...common, data: { ...v, markdown: md, transcript: false }, proposals, citations: cites, passages: cites, provider: pinfo, usage: r.usage });
      }
      if (req.action === 'examPlan') return await this.examPlan(p, req, { agent, cites, sources, structured, record, base: (o) => base({ ...common, provider: pinfo, passages: cites, ...o }), signal: opt.signal });
      throw new Error('Unknown action.');
    } catch (e) {
      const err = e instanceof AIError ? e : null;
      if (!err) throw e;
      record(err.code, null);
      if (err.code === 'cancelled') return base({ ...common, status: 'cancelled', message: 'Cancelled. Nothing was saved.', provider: pinfo, passages: cites });
      return base({ ...common, status: err.code === 'offline' ? 'unavailable' : 'error', errorCode: err.code, provider: pinfo, passages: cites,
        message: err.code === 'offline' ? `${AI_UNAVAILABLE}. Your material is still searchable below.` : err.message });
    }
  }

  private defaultQuery(p: Principal, req: AIRequest) {
    const me = { kind: 'user' as const, userId: this.user(p) };
    try {
      if (req.scope.kind === 'lecture') { const s = req.scope; const l = this.m.courses.lectures(me, s.courseId).find((x) => x.id === s.lectureId); const t = this.m.courses.topics(me, s.courseId).filter((x) => l?.topicIds.includes(x.id)); return [l?.title, ...t.map((x) => x.title)].join(' '); }
      if (req.scope.kind === 'exam') { const e = this.m.exams.get(me, req.scope.examId); return e ? this.m.courses.topics(me, e.courseId).filter((t) => e.topicIds.includes(t.id)).map((t) => t.title).join(' ') : ''; }
      if (req.scope.kind === 'course') return this.m.courses.topics(me, req.scope.courseId).map((t) => t.title).join(' ');
    } catch { /* fall through */ }
    return '';
  }
  private scopeIds(p: Principal, s: AIScope): { courseId: string | null; topicId: string | null; examId: string | null; name: string } {
    const me = { kind: 'user' as const, userId: this.user(p) };
    try {
      if (s.kind === 'course') return { courseId: s.courseId, topicId: s.topicId ?? null, examId: null, name: this.m.courses.mine(me, s.courseId).name };
      if (s.kind === 'lecture') return { courseId: s.courseId, topicId: null, examId: null, name: this.m.courses.mine(me, s.courseId).name };
      if (s.kind === 'exam') { const e = this.m.exams.get(me, s.examId); return { courseId: e?.courseId ?? null, topicId: null, examId: e?.id ?? null, name: e?.name ?? '' }; }
      if (s.kind === 'note' && s.courseId) return { courseId: s.courseId, topicId: null, examId: null, name: this.m.courses.mine(me, s.courseId).name };
    } catch { /* no course context */ }
    return { courseId: null, topicId: null, examId: null, name: '' };
  }

  // ---- Exam Coach ----
  /** Gaps from explicit data only (your marks, sessions, cards, confirmed past-paper questions). No model involved. */
  examGaps(p: Principal, examId: string) {
    const u = this.user(p), me = { kind: 'user' as const, userId: u };
    const prep = this.m.exams.prep(me, examId);
    const sessions = this.m.study.recent(me, { courseId: prep.exam.courseId, limit: 200 });
    const paper = this.db.prepare('SELECT topic_id t, count(*) n FROM ai_paper_questions WHERE owner_id = ? AND topic_id IS NOT NULL GROUP BY topic_id').all(u) as { t: string; n: number }[];
    return prep.topics.map((t) => {
      const reasons: string[] = [];
      if (t.state !== 'confident') reasons.push(`You marked it “${TOPIC_STATE_LABEL[t.state]}”.`);
      if (!sessions.some((s) => s.topicId === t.id)) reasons.push('No study session recorded for it.');
      const q = paper.find((x) => x.t === t.id)?.n ?? 0; if (q) reasons.push(`${q} past-paper question${q === 1 ? '' : 's'} you assigned to it.`);
      return { topicId: t.id, title: t.title, state: t.state, reasons, gap: t.state !== 'confident' };
    }).sort((a, b) => Number(b.gap) - Number(a.gap) || b.reasons.length - a.reasons.length);
  }
  private async examPlan(p: Principal, req: AIRequest, x: { agent: AgentDefinition; cites: Citation[]; sources: PromptSource[]; structured: <T>(m: AIMessage[], s: z.ZodType<T>) => Promise<{ value: T; usage: RunResult['usage'] }>; record(s: string, u: RunResult['usage']): void; base(o: Partial<RunResult>): RunResult; signal?: AbortSignal }) {
    if (req.scope.kind !== 'exam') throw new Error('Exam Coach plans need an exam.');
    const u = this.user(p), me = { kind: 'user' as const, userId: u };
    const prep = this.m.exams.prep(me, req.scope.examId);
    const topics = prep.topics.length ? prep.topics : this.m.courses.topics(me, prep.exam.courseId);
    if (!topics.length) return x.base({ status: 'empty', message: 'Add topics to this exam’s scope first.' });
    const now = this.now(), today = ymd(now);
    if (prep.exam.at - now < DAY) return x.base({ status: 'empty', message: 'The exam is less than a day away; there is no time left to plan.' });
    const gaps = this.examGaps(p, prep.exam.id);
    const input = [`TODAY ${today}`, `EXAM ${ymd(prep.exam.at)} ${prep.exam.name}`, ...topics.map((t) => `TOPIC ${t.id} | ${t.title.replace(/\|/g, '/')} | ${t.state}`),
      ...gaps.filter((g) => g.reasons.length).map((g) => `GAP ${g.topicId}: ${g.reasons.join(' ')}`), `Plan days after TODAY and before the EXAM. Use only TOPIC ids above. Prefer topics not marked confident.`].join('\n');
    const r = await x.structured(structuredMessages({ task: TASK.examPlan, schema: '{"days":[{"date":"YYYY-MM-DD","items":[{"topicId":string,"minutes":number,"cards":number}]}],"rationale":string}', sources: x.sources, input }), PlanOut);
    if (x.signal?.aborted) throw new AIError('cancelled', 'Cancelled.');
    x.record('ok', r.usage);
    const ok = new Map(topics.map((t) => [t.id, t.title]));
    const sessions = r.value.days.flatMap((d) => {
      const at0 = new Date(`${d.date}T18:00:00`).getTime();
      if (!(at0 > now) || at0 >= prep.exam.at) return [];
      return d.items.filter((i) => ok.has(i.topicId)).map((i, k) => ({ at: at0 + k * 3_600_000, minutes: i.minutes, topicId: i.topicId, goal: `${ok.get(i.topicId)} · ${i.minutes} min${i.cards ? ` · ${i.cards} flashcards` : ''}` }));
    }).slice(0, 60);
    if (!sessions.length) return x.base({ status: 'empty', usage: r.usage, message: 'The suggested plan did not fit your exam dates and topics, so nothing is proposed.' });
    const prop = this.proposals.create(u, x.agent.id, 'CREATE_STUDY_PLAN', { examId: prep.exam.id, courseId: prep.exam.courseId, sessions }, x.cites, r.value.rationale || 'A study plan from your exam scope and your own marks.');
    return x.base({ data: { days: [...new Set(sessions.map((s) => ymd(s.at)))].map((d) => ({ date: d, items: sessions.filter((s) => ymd(s.at) === d) })), rationale: r.value.rationale, gaps }, proposals: [prop], citations: x.cites, usage: r.usage });
  }

  // ---- Quiz Me ----
  /** Grades locally. Weak topics produce *suggested* mark changes (proposals) — never automatic. */
  answerQuiz(p: Principal, quizId: string, answers: { i: number; answer: string; selfCorrect?: boolean }[]) {
    const u = this.user(p);
    const q = this.db.prepare('SELECT * FROM ai_quizzes WHERE id = ? AND owner_id = ?').get(quizId, u) as { questions: string; citations: string; scope: string } | undefined;
    if (!q) throw new Error('Quiz not found.');
    const qs = JSON.parse(q.questions) as z.infer<typeof QuizOut>['questions'], cites = JSON.parse(q.citations) as Citation[], scope = JSON.parse(q.scope) as AIScope;
    const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim();
    const results = qs.map((x, i) => {
      const a = answers.find((y) => y.i === i);
      const correct = !a ? false : x.type === 'short' ? (a.selfCorrect ?? overlap(norm(a.answer), norm(x.answer)) >= 0.6) : norm(a.answer) === norm(x.answer);
      return { i, correct, given: a?.answer ?? '', expected: x.answer, explanation: x.explanation, topic: x.topic, citations: cites.filter((c) => x.cites.includes(c.n)), selfMarked: x.type === 'short' && a?.selfCorrect !== undefined };
    });
    const score = results.filter((r) => r.correct).length;
    this.db.prepare('INSERT INTO ai_quiz_attempts (id, quiz_id, owner_id, answers, score, total, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), quizId, u, JSON.stringify(answers), score, qs.length, this.now());
    const ids = this.scopeIds(p, scope), me = { kind: 'user' as const, userId: u };
    const topics = ids.courseId ? this.m.courses.topics(me, ids.courseId) : [];
    const weak = new Map<string, { title: string; wrong: number; total: number }>();
    for (const r of results) {
      const t = topics.find((x) => r.topic && sameTopic(x.title, r.topic));
      if (!t) continue;
      const e = weak.get(t.id) ?? { title: t.title, wrong: 0, total: 0 }; e.total++; if (!r.correct) e.wrong++; weak.set(t.id, e);
    }
    const suggestions = [...weak.entries()].filter(([, w]) => w.wrong > 0).map(([topicId, w]) => {
      const t = topics.find((x) => x.id === topicId)!;
      const prop = t.state === 'review' ? null : this.proposals.create(u, 'quiz-master', 'UPDATE_TOPIC_CONFIDENCE', { topicId, state: 'review' }, [], `${w.wrong} of ${w.total} quiz answers on ${w.title} were wrong. Your mark stays “${TOPIC_STATE_LABEL[t.state]}” unless you change it.`);
      return { topicId, title: w.title, message: `${w.title} may need review`, current: t.state, proposal: prop };
    });
    return { score, total: qs.length, results, suggestions };
  }

  // ---- Past papers ----
  /** Finds numbered questions in a past paper's text layer; suggests topics (AI if available, else word match). Changes nothing. */
  async analyzePaper(p: Principal, refId: string, o: { examId?: string | null; signal?: AbortSignal; fresh?: boolean } = {}) {
    const u = this.user(p), me = { kind: 'user' as const, userId: u };
    const agent = agentFor('pastPaper'), inc = { ...DEFAULT_INCLUDE, resources: true, classroom: true, study: true };
    const a = principalFor(agent, u, inc);
    const cand = select(this.m, a, { kind: 'resource', refId }, inc, agent.reads).candidates.find((c) => c.pinned);
    if (!cand) return { status: 'denied' as const, reason: 'That file is not available to you.', questions: [] };
    const st = (await this.index.ensure([cand])).get(cand.key)!;
    if (st.status !== 'ok') return { status: 'unsupported' as const, reason: st.reason ?? 'There is no readable text in this file.', questions: [] };
    const exam = o.examId ? this.m.exams.get(me, o.examId) : null;
    const courseId = exam?.courseId ?? this.m.courses.coursesOf(me, 'files', refId)[0] ?? null;
    const topics = courseId ? this.m.courses.topics(me, courseId) : [];
    const have = this.db.prepare('SELECT count(*) n FROM ai_paper_questions WHERE owner_id = ? AND source_key = ? AND version = ?').get(u, cand.key, cand.version) as { n: number };
    if (!have.n || o.fresh) {
      const qs: { n: number; page: number | null; start: number; end: number; text: string }[] = [];
      for (const pg of this.index.pages(cand.key)) {
        const re = /(?:^|\n)\s*(?:Q(?:uestion)?\.?\s*(\d{1,2})|(\d{1,2})[.)])[.:)]?\s+(?=\S)/g; let mm: RegExpExecArray | null; const starts: { n: number; at: number; i: number }[] = [];
        while ((mm = re.exec(pg.text))) starts.push({ n: Number(mm[1] ?? mm[2]), at: mm.index, i: mm.index + mm[0].length });
        // a question runs until the next question marker (or the page end), bounded
        starts.forEach((s, k) => { const end = Math.min(k + 1 < starts.length ? starts[k + 1]!.at : pg.text.length, s.i + 800); const t = pg.text.slice(s.i, end).trim(); if (t.length >= 8) qs.push({ n: s.n, page: pg.page, start: s.i, end, text: t }); });
      }
      let sug = new Map<number, { topicId: string | null; confidence: string; method: string }>();
      const pr = this.provider(p);
      if (pr && qs.length && topics.length) {
        try {
          const r = await pr.generate({ json: true, maxTokens: 2000, signal: o.signal, messages: structuredMessages({ task: TASK.pastPaper, schema: '{"assignments":[{"q":number,"topicId":string|null,"confidence":"high"|"medium"|"low"}]}', sources: [],
            input: [...topics.map((t) => `TOPIC ${t.id} | ${t.title.replace(/\|/g, '/')} |`), ...qs.map((q, i) => `Q${i + 1}: ${q.text.replace(/\s+/g, ' ').slice(0, 400)}`)].join('\n') }) });
          const v = parseJson(r.text, PaperTopicsOut), ok = new Set(topics.map((t) => t.id));
          sug = new Map(v.assignments.filter((x) => x.q >= 1 && x.q <= qs.length).map((x) => [x.q - 1, { topicId: x.topicId && ok.has(x.topicId) ? x.topicId : null, confidence: x.confidence, method: 'ai' }]));
        } catch { /* fall back to word match */ }
      }
      this.db.prepare('DELETE FROM ai_paper_questions WHERE owner_id = ? AND source_key = ?').run(u, cand.key);
      const ins = this.db.prepare('INSERT INTO ai_paper_questions (id, owner_id, source_key, version, ref_id, n, page, start, end, suggested_topic, confidence, method, topic_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)');
      qs.forEach((q, i) => {
        const s = sug.get(i) ?? wordMatch(q.text, topics);
        ins.run(randomUUID(), u, cand.key, cand.version, refId, q.n, q.page, q.start, q.end, s.topicId, s.confidence, s.topicId ? s.method : null, this.now());
      });
    }
    return { status: 'ok' as const, reason: null, label: cand.label, topics: topics.map((t) => ({ id: t.id, title: t.title })), questions: this.paperQuestions(p, cand.key) };
  }
  paperQuestions(p: Principal, sourceKey: string) {
    const u = this.user(p);
    const rows = this.db.prepare('SELECT * FROM ai_paper_questions WHERE owner_id = ? AND source_key = ? ORDER BY page, n').all(u, sourceKey) as { id: string; n: number; page: number | null; start: number; end: number; suggested_topic: string | null; confidence: string | null; method: string | null; topic_id: string | null; ref_id: string }[];
    const pages = new Map(this.index.pages(sourceKey).map((x) => [x.page, x.text]));
    const name = select(this.m, principalFor(agentFor('pastPaper'), u, { ...DEFAULT_INCLUDE }), { kind: 'resource', refId: rows[0]?.ref_id ?? '' }, { ...DEFAULT_INCLUDE }, ['resources', 'classroom']).candidates[0]?.label ?? 'Past paper';
    return rows.map((r) => ({ id: r.id, n: r.n, page: r.page, text: (pages.get(r.page) ?? '').slice(r.start, r.end).trim(), suggestedTopicId: r.suggested_topic, confidence: r.confidence, method: r.method, topicId: r.topic_id,
      cite: `${name} · Q${r.n}${r.page ? ` · page ${r.page}` : ''}`, refId: r.ref_id }));
  }
  /** The student's own decision about a question's topic. */
  confirmPaperTopic(p: Principal, questionId: string, topicId: string | null) {
    const u = this.user(p);
    if (topicId) this.m.courses.topic({ kind: 'user', userId: u }, topicId); // must be the student's topic
    if (!this.db.prepare('UPDATE ai_paper_questions SET topic_id = ? WHERE id = ? AND owner_id = ?').run(topicId, questionId, u).changes) throw new Error('Question not found.');
  }
  /** Confirmed question topics not yet in the exam's scope → one ADD_EXAM_SCOPE proposal. */
  proposeScopeFromPaper(p: Principal, refId: string, examId: string) {
    const u = this.user(p), e = this.m.exams.get({ kind: 'user', userId: u }, examId);
    if (!e) throw new Error('Exam not found.');
    const ids = [...new Set((this.db.prepare('SELECT topic_id t FROM ai_paper_questions WHERE owner_id = ? AND ref_id = ? AND topic_id IS NOT NULL').all(u, refId) as { t: string }[]).map((r) => r.t))].filter((t) => !e.topicIds.includes(t));
    if (!ids.length) return null;
    return this.proposals.create(u, 'paper-analyst', 'ADD_EXAM_SCOPE', { examId, topicIds: ids }, [], `Adds ${ids.length} topic${ids.length === 1 ? '' : 's'} you assigned to past-paper questions to “${e.name}”.`);
  }

  // ---- conversations (local only) ----
  private saveTurn(u: string, req: AIRequest, question: string, answer: GroundedAnswer, cites: Citation[]) {
    let id = req.conversationId ?? null;
    if (id && !this.db.prepare('SELECT 1 FROM ai_conversations WHERE id = ? AND owner_id = ?').get(id, u)) id = null;
    const t = this.now();
    if (!id) { id = randomUUID(); this.db.prepare('INSERT INTO ai_conversations (id, owner_id, scope, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, u, JSON.stringify(req.scope), question.slice(0, 120), t, t); }
    else this.db.prepare('UPDATE ai_conversations SET updated_at = ? WHERE id = ?').run(t, id);
    const ins = this.db.prepare('INSERT INTO ai_turns (id, conversation_id, role, text, data, created_at) VALUES (?, ?, ?, ?, ?, ?)');
    ins.run(randomUUID(), id, 'user', question.slice(0, 4000), null, t);
    ins.run(randomUUID(), id, 'assistant', answer.material.map((x) => x.text).join('\n\n') || (answer.notFound ? 'Not found in the selected material.' : ''), JSON.stringify({ answer, cites }), t + 1);
    return id;
  }
  conversations(p: Principal) { return this.db.prepare('SELECT id, title, scope, updated_at updatedAt FROM ai_conversations WHERE owner_id = ? ORDER BY updated_at DESC LIMIT 50').all(this.user(p)) as { id: string; title: string; scope: string; updatedAt: number }[]; }
  turns(p: Principal, conversationId: string) {
    return (this.db.prepare('SELECT t.role, t.text, t.data, t.created_at at FROM ai_turns t JOIN ai_conversations c ON c.id = t.conversation_id WHERE c.id = ? AND c.owner_id = ? ORDER BY t.created_at LIMIT 200').all(conversationId, this.user(p)) as { role: 'user' | 'assistant'; text: string; data: string | null; at: number }[])
      .map((r) => ({ role: r.role, text: r.text, data: r.data ? JSON.parse(r.data) : null, at: r.at }));
  }
  deleteHistory(p: Principal) { const u = this.user(p); this.db.prepare('DELETE FROM ai_turns WHERE conversation_id IN (SELECT id FROM ai_conversations WHERE owner_id = ?)').run(u); this.db.prepare('DELETE FROM ai_conversations WHERE owner_id = ?').run(u); }
  usage(p: Principal, since = this.now() - 30 * DAY) { return this.db.prepare('SELECT provider, model, count(*) requests, sum(input_tokens) inputTokens, sum(output_tokens) outputTokens FROM ai_usage WHERE owner_id = ? AND at >= ? GROUP BY provider, model').all(this.user(p), since) as { provider: string; model: string; requests: number; inputTokens: number | null; outputTokens: number | null }[]; }
  /** Local retrieval only (works with no provider and offline): passages the person may read, with citations. */
  async search(p: Principal, query: string, scope: AIScope = { kind: 'global' }, include?: Partial<Include>) {
    const g = await this.gather(p, { action: 'ask', scope, include }, {});
    const by = new Map(g.sel.candidates.map((c) => [c.key, c]));
    return (await this.retrieve(p, g.usable, query, false, {}, BUDGET.chunks, false)).map((x, i) => this.cite(i + 1, x, by.get(x.key)));
  }
}

const srcRef = (c: Candidate | undefined): { module: 'notes' | 'files' | 'saved'; id: string } | null =>
  !c ? null : c.open.module === 'notes' ? { module: 'notes', id: c.open.id } : c.open.module === 'files' ? { module: 'files', id: c.open.refId } : c.open.module === 'saved' ? { module: 'saved', id: c.open.id } : null;
const stems = (t: string) => new Set((t.toLowerCase().match(/[\p{L}][\p{L}\p{N}-]{3,}/gu) ?? []).map((w) => w.replace(/(?:es|s)$/, '')));
/** Same topic if the titles share a meaningful word stem ("Deadlocks" ~ "A deadlock"). */
const sameTopic = (a: string, b: string) => { const x = stems(a); return [...stems(b)].some((w) => x.has(w)); };
const ymd = (t: number) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const overlap = (a: string, b: string) => { const bw = new Set(b.split(' ').filter((w) => w.length > 3)); if (!bw.size) return a === b ? 1 : 0; return [...bw].filter((w) => a.includes(w)).length / bw.size; };
function wordMatch(q: string, topics: { id: string; title: string }[]) {
  const qw = stems(q);
  let best: { id: string; n: number } | null = null;
  for (const t of topics) { const n = [...stems(t.title)].filter((w) => qw.has(w)).length; if (n && (!best || n > best.n)) best = { id: t.id, n }; }
  return { topicId: best?.id ?? null, confidence: best ? (best.n > 1 ? 'medium' : 'low') : 'low', method: 'word match' };
}
export type { AIScope, Include, OpenTarget, Candidate } from './context.ts';
export type { Action, AgentDefinition, SourceKind } from './agents.ts';
export type { ProposalView } from './proposals.ts';
export { AGENTS } from './agents.ts';
export type { ProposalKind };
