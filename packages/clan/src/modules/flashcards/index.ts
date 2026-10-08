// Flashcards: manual decks (general, or for a course / topic / exam) and an SM-2 review schedule. A card may point at a
// note or resource by reference instead of copying it. Every review is kept (history), so the schedule is explainable.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { GRADES, NEW_CARD, sm2, type Grade } from '@classroom/protocol';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import { userOf, type Principal, type Scope } from '../../core/permissions.ts';
import type { SearchProvider } from '../../core/search.ts';
import type { Courses } from '../courses/index.ts';
import { rowProvider, SyncDefer, type SyncProvider } from '../../core/syncrows.ts';

export const schema: ModuleSchema = {
  module: 'flashcards', prefix: 'flashcards',
  migrations: [`
    CREATE TABLE flashcards_decks (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, name TEXT NOT NULL, course_id TEXT, topic_id TEXT, exam_id TEXT, created_at INTEGER NOT NULL);
    CREATE INDEX flashcards_decks_owner ON flashcards_decks(owner_id, course_id);
    CREATE TABLE flashcards_cards (id TEXT PRIMARY KEY, deck_id TEXT NOT NULL REFERENCES flashcards_decks(id), front TEXT NOT NULL, back TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
      ref_module TEXT CHECK (ref_module IN ('notes','files','saved')), ref_id TEXT, due_at INTEGER NOT NULL, interval_days INTEGER NOT NULL DEFAULT 0,
      ease REAL NOT NULL DEFAULT 2.5, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      CHECK ((ref_module IS NULL) = (ref_id IS NULL)));
    CREATE INDEX flashcards_cards_due ON flashcards_cards(deck_id, due_at);
    CREATE TABLE flashcards_reviews (id TEXT PRIMARY KEY, card_id TEXT NOT NULL REFERENCES flashcards_cards(id), at INTEGER NOT NULL, grade TEXT NOT NULL CHECK (grade IN ('again','hard','good','easy')),
      interval_before INTEGER NOT NULL, interval_after INTEGER NOT NULL, ease_after REAL NOT NULL, due_after INTEGER NOT NULL);
    CREATE INDEX flashcards_reviews_card ON flashcards_reviews(card_id, at);
    CREATE INDEX flashcards_reviews_at ON flashcards_reviews(at);
  `],
};

export const FlashcardReviewed = defineEvent('FlashcardReviewed', 1, z.object({ cardId: z.string(), deckId: z.string(), ownerId: z.string(), grade: z.enum(GRADES) }));
export const DeckChanged = defineEvent('DeckChanged', 1, z.object({ deckId: z.string(), ownerId: z.string() }));
export type Deck = { id: string; name: string; courseId: string | null; topicId: string | null; examId: string | null; cards: number; due: number };
export type Card = { id: string; deckId: string; front: string; back: string; note: string; ref: { module: string; id: string } | null; dueAt: number; interval: number; ease: number; reps: number; lapses: number };
type CRaw = { id: string; deck_id: string; front: string; back: string; note: string; ref_module: string | null; ref_id: string | null; due_at: number; interval_days: number; ease: number; reps: number; lapses: number };
const toCard = (r: CRaw): Card => ({ id: r.id, deckId: r.deck_id, front: r.front, back: r.back, note: r.note, ref: r.ref_module ? { module: r.ref_module, id: r.ref_id! } : null, dueAt: r.due_at, interval: r.interval_days, ease: r.ease, reps: r.reps, lapses: r.lapses });

export class Flashcards {
  private db: Db; private bus: EventBus; private courses: Courses; private now: () => number;
  constructor(db: Db, bus: EventBus, courses: Courses, now = () => Date.now()) { this.db = db; this.bus = bus; this.courses = courses; this.now = now; }

  /** Personal sync: decks with their cards (content only), and reviews as an append-only log. A card's schedule is
   *  never copied — it is recomputed from all its reviews, so reviews made on two devices both count. */
  syncProviders(): SyncProvider[] {
    type Rv = { id: string; card_id: string; at: number; grade: Grade; interval_before: number; interval_after: number; ease_after: number; due_after: number };
    const ownCard = (owner: string, cardId: string) => this.db.prepare('SELECT c.created_at FROM flashcards_cards c JOIN flashcards_decks d ON d.id = c.deck_id WHERE c.id = ? AND d.owner_id = ?').get(cardId, owner) as { created_at: number } | undefined;
    const recompute = (cardId: string, createdAt: number) => {
      let s = { ...NEW_CARD, dueAt: createdAt };
      for (const r of this.db.prepare('SELECT grade, at FROM flashcards_reviews WHERE card_id = ? ORDER BY at, id').all(cardId) as { grade: Grade; at: number }[]) s = sm2(s, r.grade, r.at);
      this.db.prepare('UPDATE flashcards_cards SET due_at = ?, interval_days = ?, ease = ?, reps = ?, lapses = ? WHERE id = ?').run(s.dueAt, s.interval, s.ease, s.reps, s.lapses, cardId);
    };
    const Review = z.object({ card_id: z.string().max(80), at: z.number().int(), grade: z.enum(GRADES), interval_before: z.number().int(), interval_after: z.number().int(), ease_after: z.number(), due_after: z.number().int() });
    const wire = ({ id: _id, ...r }: Rv) => r;
    const SELECT = 'SELECT r.* FROM flashcards_reviews r JOIN flashcards_cards c ON c.id = r.card_id JOIN flashcards_decks d ON d.id = c.deck_id WHERE d.owner_id = ?';
    return [
      rowProvider(this.db, { kind: 'deck', policy: 'lww', table: 'flashcards_decks', owner: 'owner_id',
        children: [{ table: 'flashcards_cards', fk: 'deck_id', key: 'id', exclude: ['due_at', 'interval_days', 'ease', 'reps', 'lapses', 'updated_at'], order: 'created_at, id',
          defaults: { due_at: (r) => r.created_at, updated_at: (r) => r.created_at }, dependents: [{ table: 'flashcards_reviews', fk: 'card_id' }] }] }),
      { kind: 'review', policy: 'union',
        all: (owner) => new Map((this.db.prepare(SELECT).all(owner) as Rv[]).map((r) => [r.id, wire(r)])),
        one: (owner, id) => { const r = this.db.prepare(`${SELECT} AND r.id = ?`).get(owner, id) as Rv | undefined; return r ? wire(r) : null; },
        apply: (owner, id, payload) => {
          if (payload === null) { const r = this.db.prepare(`${SELECT} AND r.id = ?`).get(owner, id) as Rv | undefined; if (r) { this.db.prepare('DELETE FROM flashcards_reviews WHERE id = ?').run(id); const c = ownCard(owner, r.card_id); if (c) recompute(r.card_id, c.created_at); } return; }
          const r = Review.parse(payload), c = ownCard(owner, r.card_id);
          if (!c) { if (this.db.prepare('SELECT 1 FROM flashcards_cards WHERE id = ?').get(r.card_id)) throw new Error('That card belongs to someone else.'); throw new SyncDefer('card not here yet'); }
          this.db.prepare('INSERT OR IGNORE INTO flashcards_reviews (id, card_id, at, grade, interval_before, interval_after, ease_after, due_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, r.card_id, r.at, r.grade, r.interval_before, r.interval_after, r.ease_after, r.due_after);
          recompute(r.card_id, c.created_at);
        } },
    ];
  }
  private owner(p: Principal) { if (p.kind !== 'user') throw new Error('Only you can change your flashcards.'); return p.userId; }
  private deckRow(p: Principal, id: string) {
    const d = this.db.prepare('SELECT * FROM flashcards_decks WHERE id = ? AND owner_id = ?').get(id, userOf(p)) as { id: string; course_id: string | null } | undefined;
    if (!d) throw new Error('Deck not found.');
    return d;
  }

  createDeck(p: Principal, o: { name: string; courseId?: string | null; topicId?: string | null; examId?: string | null }): Deck {
    const u = this.owner(p), id = randomUUID();
    if (o.courseId) this.courses.mine(p, o.courseId);
    if (o.topicId && this.courses.topic(p, o.topicId).courseId !== o.courseId) throw new Error('Topic of another course.');
    this.db.prepare('INSERT INTO flashcards_decks (id, owner_id, name, course_id, topic_id, exam_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, u, z.string().trim().min(1).max(120).parse(o.name), o.courseId ?? null, o.topicId ?? null, o.examId ?? null, this.now());
    this.bus.publish(DeckChanged, 'flashcards', { deckId: id, ownerId: u });
    return this.decks(p).find((d) => d.id === id)!;
  }
  /** Decks with card and due counts — counts only, no cards loaded. */
  decks(p: Principal, o: { courseId?: string; examId?: string } = {}): Deck[] {
    if (p.kind === 'agent' && !p.scopes.includes('flashcards:read')) return [];
    return this.db.prepare(`SELECT d.id, d.name, d.course_id courseId, d.topic_id topicId, d.exam_id examId,
        (SELECT count(*) FROM flashcards_cards c WHERE c.deck_id = d.id) cards, (SELECT count(*) FROM flashcards_cards c WHERE c.deck_id = d.id AND c.due_at <= ?) due
      FROM flashcards_decks d WHERE d.owner_id = ? ${o.courseId ? 'AND d.course_id = ?' : ''} ${o.examId ? 'AND d.exam_id = ?' : ''} ORDER BY d.name LIMIT 200`)
      .all(...[this.now(), userOf(p), ...(o.courseId ? [o.courseId] : []), ...(o.examId ? [o.examId] : [])]) as Deck[];
  }
  /** Cards due now across decks (optionally one course or exam): a single indexed count. */
  dueCount(p: Principal, o: { courseId?: string; examId?: string; deckId?: string } = {}) {
    return (this.db.prepare(`SELECT count(*) n FROM flashcards_cards c JOIN flashcards_decks d ON d.id = c.deck_id WHERE d.owner_id = ? AND c.due_at <= ?
      ${o.courseId ? 'AND d.course_id = ?' : ''} ${o.examId ? 'AND d.exam_id = ?' : ''} ${o.deckId ? 'AND d.id = ?' : ''}`)
      .get(...[userOf(p), this.now(), ...(o.courseId ? [o.courseId] : []), ...(o.examId ? [o.examId] : []), ...(o.deckId ? [o.deckId] : [])]) as { n: number }).n;
  }
  addCard(p: Principal, deckId: string, o: { front: string; back: string; note?: string; ref?: { module: 'notes' | 'files' | 'saved'; id: string } }): Card {
    const u = this.owner(p); this.deckRow(p, deckId);
    const id = randomUUID(), t = this.now();
    this.db.prepare('INSERT INTO flashcards_cards (id, deck_id, front, back, note, ref_module, ref_id, due_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, deckId, z.string().trim().min(1).max(2000).parse(o.front), z.string().trim().min(1).max(4000).parse(o.back), z.string().max(2000).parse(o.note ?? ''), o.ref?.module ?? null, o.ref?.id ?? null, t, t, t);
    this.bus.publish(DeckChanged, 'flashcards', { deckId, ownerId: u });
    return this.card(p, id)!;
  }
  editCard(p: Principal, id: string, o: { front?: string; back?: string; note?: string }) {
    const c = this.card(p, id); if (!c) throw new Error('Card not found.');
    this.db.prepare('UPDATE flashcards_cards SET front = ?, back = ?, note = ?, updated_at = ? WHERE id = ?').run(z.string().trim().min(1).max(2000).parse(o.front ?? c.front), z.string().trim().min(1).max(4000).parse(o.back ?? c.back), z.string().max(2000).parse(o.note ?? c.note), this.now(), id);
  }
  removeCard(p: Principal, id: string) { if (!this.card(p, id)) throw new Error('Card not found.'); tx(this.db, () => { this.db.prepare('DELETE FROM flashcards_reviews WHERE card_id = ?').run(id); this.db.prepare('DELETE FROM flashcards_cards WHERE id = ?').run(id); }); }
  card(p: Principal, id: string) { const r = this.db.prepare('SELECT c.* FROM flashcards_cards c JOIN flashcards_decks d ON d.id = c.deck_id WHERE c.id = ? AND d.owner_id = ?').get(id, userOf(p)) as CRaw | undefined; return r ? toCard(r) : null; }
  /** The review queue: only cards due now, oldest due first, bounded — never the whole deck. */
  queue(p: Principal, deckId: string, limit = 50): Card[] {
    this.deckRow(p, deckId);
    return (this.db.prepare('SELECT * FROM flashcards_cards WHERE deck_id = ? AND due_at <= ? ORDER BY due_at LIMIT ?').all(deckId, this.now(), Math.min(limit, 200)) as CRaw[]).map(toCard);
  }
  cards(p: Principal, deckId: string, o: { offset?: number; limit?: number } = {}): Card[] {
    this.deckRow(p, deckId);
    return (this.db.prepare('SELECT * FROM flashcards_cards WHERE deck_id = ? ORDER BY created_at LIMIT ? OFFSET ?').all(deckId, Math.min(o.limit ?? 100, 500), o.offset ?? 0) as CRaw[]).map(toCard);
  }
  /** One answer: SM-2 (see @classroom/protocol study.ts), stored with its history entry in one transaction. */
  review(p: Principal, cardId: string, grade: Grade): Card {
    const u = this.owner(p), c = this.card(p, cardId);
    if (!c) throw new Error('Card not found.');
    const g = z.enum(GRADES).parse(grade), t = this.now();
    const next = sm2({ interval: c.interval, ease: c.ease, reps: c.reps, lapses: c.lapses }, g, t);
    tx(this.db, () => {
      this.db.prepare('UPDATE flashcards_cards SET due_at = ?, interval_days = ?, ease = ?, reps = ?, lapses = ?, updated_at = ? WHERE id = ?').run(next.dueAt, next.interval, next.ease, next.reps, next.lapses, t, cardId);
      this.db.prepare('INSERT INTO flashcards_reviews (id, card_id, at, grade, interval_before, interval_after, ease_after, due_after) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(randomUUID(), cardId, t, g, c.interval, next.interval, next.ease, next.dueAt);
      this.bus.publish(FlashcardReviewed, 'flashcards', { cardId, deckId: c.deckId, ownerId: u, grade: g });
    });
    return this.card(p, cardId)!;
  }
  history(p: Principal, cardId: string) { if (!this.card(p, cardId)) return []; return this.db.prepare('SELECT at, grade, interval_before intervalBefore, interval_after intervalAfter FROM flashcards_reviews WHERE card_id = ? ORDER BY at').all(cardId) as { at: number; grade: Grade; intervalBefore: number; intervalAfter: number }[]; }
  /** Reviews per course since `since` (study history; personal only). */
  reviewsByCourse(p: Principal, since: number) {
    return this.db.prepare(`SELECT d.course_id courseId, count(*) n FROM flashcards_reviews r JOIN flashcards_cards c ON c.id = r.card_id JOIN flashcards_decks d ON d.id = c.deck_id
      WHERE d.owner_id = ? AND r.at >= ? GROUP BY d.course_id`).all(userOf(p), since) as { courseId: string | null; n: number }[];
  }
  /** Owners with cards due (notification tick). */
  dueOwners() { return this.db.prepare('SELECT d.owner_id ownerId, count(*) n FROM flashcards_cards c JOIN flashcards_decks d ON d.id = c.deck_id WHERE c.due_at <= ? GROUP BY d.owner_id').all(this.now()) as { ownerId: string; n: number }[]; }
  searchProvider(): SearchProvider {
    const doc = (id: string) => {
      const d = this.db.prepare('SELECT * FROM flashcards_decks WHERE id = ?').get(id) as { id: string; owner_id: string; name: string; created_at: number } | undefined;
      if (!d) return null;
      const cards = this.db.prepare('SELECT front, back FROM flashcards_cards WHERE deck_id = ? LIMIT 300').all(id) as { front: string; back: string }[];
      return { entityId: d.id, title: d.name, body: cards.map((c) => `${c.front} — ${c.back}`).join('\n'), updatedAt: d.created_at, scopes: [{ kind: 'personal', ownerId: d.owner_id } as Scope] };
    };
    return { module: 'flashcards', events: [{ def: DeckChanged as never, entityId: (e: never) => (e as { deckId: string }).deckId }], one: doc, all: () => (this.db.prepare('SELECT id FROM flashcards_decks').all() as { id: string }[]).map((r) => doc(r.id)).filter((x) => !!x) };
  }
}
