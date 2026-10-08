// The local knowledge index: a rebuildable projection, never a source of truth. Content is chunked once per canonical
// version (a file = its Resource Store object, keyed by SHA-256; a note = its id + update time), however many places
// reference it. Retrieval only ever searches the source keys the Context layer allowed for this request.
import type { Db } from '../../core/db.ts';
import { tx } from '../../core/db.ts';
import { chunk, type Extracted } from './extract.ts';

export type Passage = { chunkId: number; key: string; page: number | null; section: string | null; text: string; score: number };
export type Loadable = { key: string; kind: string; version: string; load(): Promise<Extracted> | Extracted };

export class KnowledgeIndex {
  private db: Db; private now: () => number;
  /** Time spent extracting/chunking in this process (performance notes). */
  readonly stats = { indexedSources: 0, indexMs: 0 };
  constructor(db: Db, now = () => Date.now()) { this.db = db; this.now = now; }

  /** Indexes what is missing or changed; unchanged sources cost one primary-key lookup. Returns per-key status. */
  async ensure(items: Loadable[]): Promise<Map<string, { status: string; reason: string | null }>> {
    const out = new Map<string, { status: string; reason: string | null }>();
    const t = this.now();
    for (const it of items) {
      const row = this.db.prepare('SELECT version, status, reason FROM ai_sources WHERE key = ?').get(it.key) as { version: string; status: string; reason: string | null } | undefined;
      if (row && row.version === it.version) { out.set(it.key, { status: row.status, reason: row.reason }); continue; }
      const t0 = performance.now();
      const ex = await it.load();
      const chunks = ex.status === 'ok' ? chunk(ex.sections) : [];
      tx(this.db, () => {
        this.drop(it.key);
        const ins = this.db.prepare('INSERT INTO ai_chunks (source_key, ord, page, section, start, end, text) VALUES (?, ?, ?, ?, ?, ?, ?)');
        const fts = this.db.prepare('INSERT INTO ai_fts (rowid, text) VALUES (?, ?)');
        chunks.forEach((c, i) => { const r = ins.run(it.key, i, c.page, c.section, c.start, c.end, c.text); fts.run(Number(r.lastInsertRowid), `${c.section ?? ''} ${c.text}`); });
        this.db.prepare(`INSERT INTO ai_sources (key, kind, version, status, reason, chars, chunks, indexed_at, used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, version = excluded.version, status = excluded.status, reason = excluded.reason, chars = excluded.chars, chunks = excluded.chunks, indexed_at = excluded.indexed_at, used_at = excluded.used_at`)
          .run(it.key, it.kind, it.version, ex.status === 'ok' && !chunks.length ? 'no_text' : ex.status, ex.reason ?? null, chunks.reduce((n, c) => n + c.text.length, 0), chunks.length, t, t);
      });
      this.stats.indexedSources++; this.stats.indexMs += performance.now() - t0;
      out.set(it.key, { status: ex.status === 'ok' && !chunks.length ? 'no_text' : ex.status, reason: ex.reason ?? null });
    }
    if (items.length) this.db.prepare('UPDATE ai_sources SET used_at = ? WHERE key IN (SELECT value FROM json_each(?))').run(t, JSON.stringify(items.map((i) => i.key)));
    return out;
  }

  private drop(key: string) {
    const old = this.db.prepare('SELECT id, section, text FROM ai_chunks WHERE source_key = ?').all(key) as { id: number; section: string | null; text: string }[];
    const del = this.db.prepare("INSERT INTO ai_fts (ai_fts, rowid, text) VALUES ('delete', ?, ?)");
    for (const c of old) del.run(c.id, `${c.section ?? ''} ${c.text}`);
    this.db.prepare('DELETE FROM ai_vectors WHERE chunk_id IN (SELECT id FROM ai_chunks WHERE source_key = ?)').run(key);
    this.db.prepare('DELETE FROM ai_chunks WHERE source_key = ?').run(key);
  }

  /** Lexical search (BM25 over stemmed words) restricted to `keys`. Works offline, always. */
  lexical(query: string, keys: string[], limit = 40): Passage[] {
    const terms = [...new Set((query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}'-]{1,}/gu) ?? []).filter((w) => !STOP.has(w)))].slice(0, 24);
    if (!terms.length || !keys.length) return [];
    const match = terms.map((w) => `"${w.replace(/"/g, '')}"`).join(' OR ');
    return (this.db.prepare(`SELECT c.id chunkId, c.source_key key, c.page, c.section, c.text, bm25(ai_fts) score FROM ai_fts JOIN ai_chunks c ON c.id = ai_fts.rowid
      WHERE ai_fts MATCH ? AND c.source_key IN (SELECT value FROM json_each(?)) ORDER BY score LIMIT ?`).all(match, JSON.stringify(keys), limit) as Passage[]);
  }
  /** The opening chunks of each source, in order (whole-document tasks such as summaries). */
  leading(keys: string[], perSource: number): Passage[] {
    return keys.flatMap((k) => this.db.prepare('SELECT id chunkId, source_key key, page, section, text, 0 score FROM ai_chunks WHERE source_key = ? ORDER BY ord LIMIT ?').all(k, perSource) as Passage[]);
  }
  chunksOf(key: string) { return this.db.prepare('SELECT id chunkId, source_key key, page, section, start, end, text, 0 score FROM ai_chunks WHERE source_key = ? ORDER BY ord').all(key) as (Passage & { start: number; end: number })[]; }
  /** Page texts rebuilt from the chunks (the overlap between neighbouring chunks is removed using stored offsets). */
  pages(key: string) {
    const by = new Map<number | null, { text: string; end: number }>();
    for (const c of this.chunksOf(key)) {
      const cur = by.get(c.page);
      if (!cur) { by.set(c.page, { text: c.text, end: c.end }); continue; }
      const fresh = c.end - cur.end;
      if (fresh <= 0) continue;
      cur.text += c.start >= cur.end ? ` ${c.text}` : c.text.slice(Math.max(0, c.text.length - fresh));
      cur.end = c.end;
    }
    return [...by.entries()].map(([page, v]) => ({ page, text: v.text }));
  }
  status(key: string) { return this.db.prepare('SELECT status, reason, chunks FROM ai_sources WHERE key = ?').get(key) as { status: string; reason: string | null; chunks: number } | undefined; }

  // ---- optional semantic retrieval (only when a provider offers embeddings and the student enabled it) ----
  vectorsMissing(chunkIds: number[], model: string) {
    return (this.db.prepare('SELECT c.id, c.text FROM ai_chunks c WHERE c.id IN (SELECT value FROM json_each(?)) AND NOT EXISTS (SELECT 1 FROM ai_vectors v WHERE v.chunk_id = c.id AND v.model = ?)').all(JSON.stringify(chunkIds), model) as { id: number; text: string }[]);
  }
  putVector(chunkId: number, model: string, v: number[]) { this.db.prepare('INSERT OR REPLACE INTO ai_vectors (chunk_id, model, vec) VALUES (?, ?, ?)').run(chunkId, model, new Uint8Array(new Float32Array(v).buffer)); }
  semantic(qv: number[], keys: string[], model: string, limit = 40): Passage[] {
    const rows = this.db.prepare(`SELECT c.id chunkId, c.source_key key, c.page, c.section, c.text, v.vec FROM ai_vectors v JOIN ai_chunks c ON c.id = v.chunk_id
      WHERE v.model = ? AND c.source_key IN (SELECT value FROM json_each(?)) LIMIT 5000`).all(model, JSON.stringify(keys)) as (Passage & { vec: Uint8Array })[];
    const q = Float32Array.from(qv), qn = Math.hypot(...q) || 1;
    return rows.map((r) => { const v = new Float32Array(r.vec.buffer, r.vec.byteOffset, r.vec.byteLength / 4); let dot = 0, n = 0; for (let i = 0; i < v.length; i++) { dot += v[i]! * (q[i] ?? 0); n += v[i]! * v[i]!; } return { chunkId: r.chunkId, key: r.key, page: r.page, section: r.section, text: r.text, score: -dot / (qn * (Math.sqrt(n) || 1)) }; })
      .sort((a, b) => a.score - b.score).slice(0, limit);
  }

  /** Throws the whole index away; it is rebuilt on demand from canonical content. */
  rebuild() { tx(this.db, () => { this.db.exec("DELETE FROM ai_vectors; DELETE FROM ai_chunks; DELETE FROM ai_sources; INSERT INTO ai_fts (ai_fts) VALUES ('delete-all');"); }); }
  /** Cleanup: sources not used for `days` are dropped (they re-index on next use). */
  gc(days = 60) { for (const r of this.db.prepare('SELECT key FROM ai_sources WHERE used_at < ?').all(this.now() - days * 86_400_000) as { key: string }[]) tx(this.db, () => { this.drop(r.key); this.db.prepare('DELETE FROM ai_sources WHERE key = ?').run(r.key); }); }
  size() { return this.db.prepare('SELECT count(*) sources, coalesce(sum(chunks), 0) chunks, coalesce(sum(chars), 0) chars FROM ai_sources').get() as { sources: number; chunks: number; chars: number }; }
}

/** Reciprocal-rank fusion of lexical and semantic results. */
export function fuse(lists: Passage[][], k = 60): Passage[] {
  const score = new Map<number, { p: Passage; s: number }>();
  for (const l of lists) l.forEach((p, i) => { const e = score.get(p.chunkId) ?? { p, s: 0 }; e.s += 1 / (k + i); score.set(p.chunkId, e); });
  return [...score.values()].sort((a, b) => b.s - a.s).map((e) => e.p);
}
const STOP = new Set('the a an and or of to in on for is are was were be been what which who whom how why when where does did do my me i we our you your it its this that these those with about from as at by into than then so can could should would will just not no yes there their they them he she his her'.split(' '));
