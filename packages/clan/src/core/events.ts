// Typed, versioned domain events. Producers publish; consumers subscribe. Producers never call consumers.
// Every event is validated, stored (core_events) and delivered in order. Persistent consumers record what they
// processed in the same transaction as their effect, so redelivery (crash, restart) never applies an event twice.
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { tx, type Db, type ModuleSchema } from './db.ts';

export type EventDef<T = unknown> = {
  type: string; version: number; schema: z.ZodType<T>;
  /** Converts a stored payload of an older version into this version. */
  upcast?: { from: number; up(old: unknown): T };
};
export type ClanEvent<T = unknown> = { id: string; type: string; version: number; producer: string; ts: number; payload: T };

export const defineEvent = <T>(type: string, version: number, schema: z.ZodType<T>, upcast?: EventDef<T>['upcast']): EventDef<T> => ({ type, version, schema, upcast });

export const eventsSchema: ModuleSchema = {
  module: 'events', prefix: 'core',
  migrations: [`
    CREATE TABLE core_events (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, type TEXT NOT NULL, version INTEGER NOT NULL,
      producer TEXT NOT NULL, ts INTEGER NOT NULL, payload TEXT NOT NULL);
    CREATE INDEX core_events_type ON core_events(type, seq);
    CREATE TABLE core_consumed (consumer TEXT NOT NULL, event_id TEXT NOT NULL, PRIMARY KEY (consumer, event_id));
  `],
};

type Sub = { consumer: string; def: EventDef; handler(e: ClanEvent): void; persistent: boolean };
type Row = { id: string; type: string; version: number; producer: string; ts: number; payload: string };

export class EventBus {
  private subs: Sub[] = [];
  private db: Db; private now: () => number;
  onError: (consumer: string, e: unknown) => void = (c, e) => console.error(`[events] consumer ${c} failed: ${(e as Error).message}`);
  constructor(db: Db, now = () => Date.now()) { this.db = db; this.now = now; }

  publish<T>(def: EventDef<T>, producer: string, payload: T): ClanEvent<T> {
    const evt: ClanEvent<T> = { id: randomUUID(), type: def.type, version: def.version, producer, ts: this.now(), payload: def.schema.parse(payload) };
    this.db.prepare('INSERT INTO core_events (id, type, version, producer, ts, payload) VALUES (?, ?, ?, ?, ?, ?)')
      .run(evt.id, evt.type, evt.version, evt.producer, evt.ts, JSON.stringify(evt.payload));
    for (const s of this.subs) if (s.def.type === evt.type) this.deliver(s, evt);
    return evt;
  }

  subscribe<T>(consumer: string, def: EventDef<T>, handler: (e: ClanEvent<T>) => void, opts: { persistent?: boolean } = {}) {
    if (opts.persistent && !/^[a-z][\w.-]*$/.test(consumer)) throw new Error('bad consumer name');
    const s: Sub = { consumer, def: def as EventDef, handler: handler as Sub['handler'], persistent: !!opts.persistent };
    this.subs.push(s);
    return () => { this.subs = this.subs.filter((x) => x !== s); };
  }

  /** Delivers stored events that persistent consumers have not processed yet (startup, after a failure). */
  deliverPending() {
    for (const s of this.subs.filter((x) => x.persistent)) {
      const rows = this.db.prepare(`SELECT id, type, version, producer, ts, payload FROM core_events e WHERE type = ?
        AND NOT EXISTS (SELECT 1 FROM core_consumed c WHERE c.consumer = ? AND c.event_id = e.id) ORDER BY seq`).all(s.def.type, s.consumer) as Row[];
      for (const r of rows) this.deliver(s, this.decode(s.def, r));
    }
  }

  /** Stored events of one type, decoded (and upcast) to `def`'s version. */
  history<T>(def: EventDef<T>, limit = 100): ClanEvent<T>[] {
    return (this.db.prepare('SELECT id, type, version, producer, ts, payload FROM core_events WHERE type = ? ORDER BY seq DESC LIMIT ?').all(def.type, limit) as Row[])
      .map((r) => this.decode(def, r));
  }

  private decode<T>(def: EventDef<T>, r: Row): ClanEvent<T> {
    const raw: unknown = JSON.parse(r.payload);
    let payload: T;
    if (r.version === def.version) payload = def.schema.parse(raw);
    else if (def.upcast && r.version === def.upcast.from) payload = def.schema.parse(def.upcast.up(raw));
    else throw new Error(`${r.type} v${r.version} cannot be read as v${def.version}`);
    return { id: r.id, type: r.type, version: def.version, producer: r.producer, ts: r.ts, payload };
  }

  private deliver(s: Sub, evt: ClanEvent) {
    try {
      if (!s.persistent) return s.handler(evt);
      tx(this.db, () => {
        const done = this.db.prepare('INSERT OR IGNORE INTO core_consumed (consumer, event_id) VALUES (?, ?)').run(s.consumer, evt.id);
        if (done.changes === 0) return; // already applied
        s.handler(evt);
      });
    } catch (e) { this.onError(s.consumer, e); } // stays pending; deliverPending() retries
  }
}
