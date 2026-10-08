// Universal search: a rebuildable projection. Modules register providers that describe their entities as documents
// with scopes; the index is fed by those providers' events and can be rebuilt from scratch. Results are filtered by the
// caller's scopes. Diary is never indexed (registering it throws).
import type { Db, ModuleSchema } from './db.ts';
import type { EventBus, EventDef } from './events.ts';
import { userOf, type Permissions, type Principal, type Scope } from './permissions.ts';

export const searchSchema: ModuleSchema = {
  module: 'search', prefix: 'search',
  migrations: [`
    CREATE TABLE search_docs (module TEXT NOT NULL, entity_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL,
      title TEXT NOT NULL, body TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (module, entity_id, scope_kind, scope_id));
    CREATE INDEX search_docs_scope ON search_docs(scope_kind, scope_id);
  `],
};

export type IndexDoc = { entityId: string; title: string; body: string; updatedAt: number; scopes: Scope[] };
export type SearchProvider = {
  module: string;
  /** Events after which an entity must be re-indexed, and how to find its id in the payload. */
  events: { def: EventDef<never>; entityId(payload: never): string }[];
  one(entityId: string): IndexDoc | null;
  all(): IndexDoc[];
};
export type SearchHit = { module: string; entityId: string; title: string; snippet: string; scope: Scope };

const NEVER_INDEXED = new Set(['diary']);

export class SearchIndex {
  private db: Db; private bus: EventBus; private perms: Permissions;
  private providers = new Map<string, SearchProvider>();
  constructor(db: Db, bus: EventBus, perms: Permissions) { this.db = db; this.bus = bus; this.perms = perms; }

  register(p: SearchProvider) {
    if (NEVER_INDEXED.has(p.module)) throw new Error(`${p.module} is private and is never indexed.`);
    this.providers.set(p.module, p);
    for (const e of p.events) this.bus.subscribe(`search.${p.module}`, e.def, (evt) => this.reindex(p.module, e.entityId(evt.payload as never)), { persistent: true });
  }

  reindex(module: string, entityId: string) {
    const p = this.providers.get(module);
    if (!p) return;
    this.db.prepare('DELETE FROM search_docs WHERE module = ? AND entity_id = ?').run(module, entityId);
    const d = p.one(entityId);
    if (d) this.write(module, d);
  }

  /** Drops every document of `module` whose id starts with `prefix` (e.g. all timeline entries of one tape). */
  forget(module: string, prefix: string) { this.db.prepare("DELETE FROM search_docs WHERE module = ? AND substr(entity_id, 1, ?) = ?").run(module, prefix.length, prefix); }

  rebuild() {
    this.db.prepare('DELETE FROM search_docs').run();
    for (const [m, p] of this.providers) for (const d of p.all()) this.write(m, d);
  }

  private write(module: string, d: IndexDoc) {
    const ins = this.db.prepare('INSERT OR REPLACE INTO search_docs (module, entity_id, scope_kind, scope_id, title, body, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const s of d.scopes) ins.run(module, d.entityId, s.kind, s.kind === 'personal' ? s.ownerId : s.clanId, d.title.slice(0, 300), d.body.slice(0, 20_000), d.updatedAt);
  }

  query(p: Principal, text: string, limit = 30): SearchHit[] {
    const q = text.trim();
    if (!q) return [];
    const clans = this.perms.clansOf(p);
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = this.db.prepare(`SELECT module, entity_id, scope_kind, scope_id, title, body FROM search_docs
      WHERE ((scope_kind = 'personal' AND scope_id = ?) OR (scope_kind = 'clan' AND scope_id IN (SELECT value FROM json_each(?))))
        AND (title LIKE ? ESCAPE '\\' OR body LIKE ? ESCAPE '\\')
      ORDER BY updated_at DESC LIMIT ?`).all(userOf(p), JSON.stringify(clans), like, like, limit * 2) as { module: string; entity_id: string; scope_kind: 'personal' | 'clan'; scope_id: string; title: string; body: string }[];
    const seen = new Set<string>();
    const out: SearchHit[] = [];
    for (const r of rows) {
      if (seen.has(`${r.module}:${r.entity_id}`) || !this.perms.agentMay(p, r.module) || NEVER_INDEXED.has(r.module)) continue;
      seen.add(`${r.module}:${r.entity_id}`);
      const i = r.body.toLowerCase().indexOf(q.toLowerCase());
      out.push({ module: r.module, entityId: r.entity_id, title: r.title, snippet: i < 0 ? r.body.slice(0, 120) : r.body.slice(Math.max(0, i - 40), i + 80),
        scope: r.scope_kind === 'personal' ? { kind: 'personal', ownerId: r.scope_id } : { kind: 'clan', clanId: r.scope_id } });
    }
    return out.slice(0, limit);
  }
}
