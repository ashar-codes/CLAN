// PersonalSync: local-first sync between devices of the same student. Transport-agnostic: it produces and consumes
// versioned change records (`SyncRecord`) and object bytes; any `SyncTransport` (LAN today, internet later) carries them.
// Data is read and written only through each owning module's SyncProvider. Versions: a content hash with recent
// history (to tell fast-forward from concurrent edits) and a hybrid logical clock (ordering, LWW tie-breaks).
import { createHash, createHmac, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as edVerify } from 'node:crypto';
import { mkdir, open, rm, stat, statfs } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  b64u, DeviceEntry, contentHash, LINK_ALPHABET, LINK_TTL_MS, LinkGrant, LinkHello, REQUEST_SKEW_MS, SyncRecord, deviceStatement, formatLinkCode, hlc, hlcParts, linkTranscript, normalizeLinkCode, requestStatement,
  type SyncBatch, type SyncTransport,
} from '@classroom/protocol';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { sha256File } from '../../core/resources.ts';
import { SyncConflict, SyncDefer, type SyncProvider } from '../../core/syncrows.ts';
import type { Identity } from '../../core/identity.ts';

export const schema: ModuleSchema = {
  module: 'sync', prefix: 'sync',
  migrations: [`
    CREATE TABLE sync_account (one INTEGER PRIMARY KEY CHECK (one = 1), account_id TEXT NOT NULL, discovery_secret TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE sync_self (one INTEGER PRIMARY KEY CHECK (one = 1), fp TEXT NOT NULL, public_key TEXT NOT NULL, name TEXT NOT NULL, platform TEXT NOT NULL, tls_ca TEXT NOT NULL, tls_spki TEXT NOT NULL);
    CREATE TABLE sync_devices (fp TEXT PRIMARY KEY, entry TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0, endpoints TEXT NOT NULL DEFAULT '[]', last_seen INTEGER, last_sync INTEGER,
      pulled INTEGER NOT NULL DEFAULT 0, pushed INTEGER NOT NULL DEFAULT 0, error TEXT);
    CREATE TABLE sync_meta (kind TEXT NOT NULL, id TEXT NOT NULL, version TEXT NOT NULL, hash TEXT NOT NULL, history TEXT NOT NULL, deleted INTEGER NOT NULL, seq INTEGER NOT NULL, PRIMARY KEY (kind, id));
    CREATE INDEX sync_meta_seq ON sync_meta(seq);
    CREATE TABLE sync_conflicts (id TEXT PRIMARY KEY, kind TEXT NOT NULL, entity_id TEXT NOT NULL, policy TEXT NOT NULL, note TEXT NOT NULL, local TEXT, remote TEXT, remote_hash TEXT NOT NULL,
      from_fp TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER, resolution TEXT);
    CREATE INDEX sync_conflicts_open ON sync_conflicts(resolved_at, kind, entity_id);
    CREATE TABLE sync_deferred (kind TEXT NOT NULL, id TEXT NOT NULL, record TEXT NOT NULL, from_fp TEXT NOT NULL, tries INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (kind, id));
    CREATE TABLE sync_transfers (sha256 TEXT PRIMARY KEY, size INTEGER NOT NULL, mime TEXT NOT NULL, from_fp TEXT NOT NULL, received INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL,
      error TEXT, waiting TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE sync_settings (one INTEGER PRIMARY KEY CHECK (one = 1), json TEXT NOT NULL);
    CREATE TABLE sync_clock (one INTEGER PRIMARY KEY CHECK (one = 1), last TEXT NOT NULL);
  `],
};

/** files: 'small' = files up to 50 MB (default), 'all' = also large files and recordings, 'off' = none. Diary is off by default. */
export type SyncSettings = { syncDiary: boolean; files: 'all' | 'small' | 'off'; paused: boolean };
const DEFAULTS: SyncSettings = { syncDiary: false, files: 'small', paused: false };
export const SMALL_FILE = 50 * 1024 * 1024;
export type SelfDevice = { fp: string; publicKey: string; name: string; platform: string; tlsCa: string; tlsSpki: string };
export type Signer = { fp: string; publicKey: string; sign(bytes: Uint8Array): string };
export type DeviceView = { fp: string; name: string; platform: string; current: boolean; revoked: boolean; addedAt: number; lastSeen: number | null; lastSync: number | null; error: string | null; endpoints: string[]; tlsCa: string; tlsSpki: string; publicKey: string };
export type ConflictView = { id: string; kind: string; entityId: string; policy: string; note: string; local: unknown; remote: unknown; fromDevice: string; createdAt: number; canKeepBoth: boolean };
type Meta = { kind: string; id: string; version: string; hash: string; history: string[]; deleted: boolean; seq: number };
type Link = { sessionId: string; key: Uint8Array; nonceA: string; expiresAt: number; tries: number; hello: (LinkHello & { serverSpki: string }) | null; state: 'waiting' | 'pending' | 'approved' | 'rejected'; grant: unknown; proofA: string | null };
export class SyncAuthError extends Error { readonly code: string; constructor(code: string, m: string) { super(m); this.code = code; } }

// Portable (Node and the phone's shims): Uint8Array + base64url from the protocol, no Buffer.
const fpOf = (publicKey: string) => b64u.encode(createHash('sha256').update(b64u.decode(publicKey)).digest()).slice(0, 22);
const ED25519_SPKI_PREFIX = Uint8Array.of(0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00);
const edKey = (raw: string) => { const k = b64u.decode(raw), der = new Uint8Array(12 + k.length); der.set(ED25519_SPKI_PREFIX); der.set(k, 12); return createPublicKey({ key: der as never, format: 'der', type: 'spki' }); };
export const verifyEd25519 = (publicKey: string, bytes: Uint8Array, sig: string) => { try { return edVerify(null, bytes, edKey(publicKey), b64u.decode(sig)); } catch { return false; } };
const linkKey = (code: string) => createHash('sha256').update(`clan-sync-link-key/v1|${code}`).digest();
export const linkProof = (code: string, transcript: string) => createHmac('sha256', linkKey(code)).update(transcript).digest('base64url');
const eq = (a: string, b: string) => { const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b); return x.length === y.length && timingSafeEqual(x, y); };
const isFk = (e: unknown) => /FOREIGN KEY constraint failed/.test(String((e as Error)?.message));
const HISTORY = 16;

export class PersonalSync {
  private db: Db; private identity: Identity; private now: () => number; private tmpDir: string;
  private providers = new Map<string, SyncProvider>();
  private signer: Signer | null = null;
  private ingest: (path: string, mime: string) => Promise<unknown>;
  private freeBytes: () => Promise<number>;
  private seen = new Map<string, number>(); // request nonces (replay)
  private link: Link | null = null;
  private scanned = -1; // total_changes() after the last scan
  private written() { return (this.db.prepare('SELECT total_changes() n').get() as { n: number }).n; }
  /** Sync's own writes (cursors, last seen, applied records whose versions it already recorded) don't need a rescan. */
  private own<T>(f: () => T): T { const clean = this.written() === this.scanned; const r = f(); if (clean) this.scanned = this.written(); return r; }
  constructor(db: Db, identity: Identity, o: { tmpDir: string; ingest(path: string, mime: string): Promise<unknown>; freeBytes?(): Promise<number> }, now = () => Date.now()) {
    this.db = db; this.identity = identity; this.now = now; this.tmpDir = o.tmpDir; this.ingest = o.ingest; this.freeBytes = o.freeBytes ?? (async () => { await mkdir(this.tmpDir, { recursive: true }); const f = await statfs(this.tmpDir); return f.bavail * f.bsize; });
  }
  register(p: SyncProvider) { this.providers.set(p.kind, p); }

  // ---------------- account, this device, registry ----------------
  /** Called by the host at start with this device's sync identity (keys live in the host's secure storage). */
  setup(self: Omit<SelfDevice, 'fp'>, signer: Omit<Signer, 'fp'>) {
    const fp = fpOf(self.publicKey);
    this.signer = { ...signer, fp };
    tx(this.db, () => {
      this.db.prepare('INSERT INTO sync_self (one, fp, public_key, name, platform, tls_ca, tls_spki) VALUES (1, ?, ?, ?, ?, ?, ?) ON CONFLICT (one) DO UPDATE SET name = excluded.name, tls_ca = excluded.tls_ca, tls_spki = excluded.tls_spki, platform = excluded.platform')
        .run(fp, self.publicKey, self.name.slice(0, 80), self.platform, self.tlsCa, self.tlsSpki);
      if (!this.account()) {
        this.db.prepare('INSERT INTO sync_account (one, account_id, discovery_secret, created_at) VALUES (1, ?, ?, ?)').run(this.identity.localUser(), randomBytes(24).toString('base64url'), this.now());
        this.putDevice(this.sign({ fp, publicKey: self.publicKey, name: self.name.slice(0, 80), platform: self.platform, tlsCa: self.tlsCa, tlsSpki: self.tlsSpki, addedAt: this.now(), addedBy: fp, revokedAt: null, revokedBy: null }));
      }
    });
    return fp;
  }
  /** Starts over after this device was unlinked: forgets the account, registry, versions and transfers (local data
   *  stays). The host must then call setup() with a NEW device key — a revoked key can never be linked again. */
  reset() {
    tx(this.db, () => { for (const t of ['sync_account', 'sync_self', 'sync_devices', 'sync_meta', 'sync_conflicts', 'sync_deferred', 'sync_transfers', 'sync_clock']) this.db.prepare(`DELETE FROM ${t}`).run(); });
    this.signer = null; this.scanned = -1; this.link = null;
    this.setSettings({ paused: false }); // the pause came from being unlinked; Diary/file choices stay
  }
  account() { return this.db.prepare('SELECT account_id accountId, discovery_secret discoverySecret, created_at createdAt FROM sync_account').get() as { accountId: string; discoverySecret: string; createdAt: number } | undefined; }
  self(): SelfDevice { const r = this.db.prepare('SELECT fp, public_key publicKey, name, platform, tls_ca tlsCa, tls_spki tlsSpki FROM sync_self').get() as SelfDevice | undefined; if (!r) throw new Error('Sync is not set up.'); return r; }
  private sign(e: Omit<DeviceEntry, 'sig'>): DeviceEntry { if (!this.signer) throw new Error('Sync is not set up.'); return { ...e, sig: this.signer.sign(deviceStatement(e)) }; }
  private entry(fp: string) { const r = this.db.prepare('SELECT entry FROM sync_devices WHERE fp = ?').get(fp) as { entry: string } | undefined; return r ? DeviceEntry.parse(JSON.parse(r.entry)) : null; }
  private putDevice(e: DeviceEntry) {
    this.db.prepare(`INSERT INTO sync_devices (fp, entry, revoked) VALUES (?, ?, ?) ON CONFLICT (fp) DO UPDATE SET entry = excluded.entry, revoked = max(sync_devices.revoked, excluded.revoked)`).run(e.fp, JSON.stringify(e), e.revokedAt ? 1 : 0);
    this.touchMeta('device', e.fp, e, false);
  }
  /** A device entry is valid if signed by a trusted device of this account (a revocation can never be undone). */
  private verifyEntry(e: DeviceEntry, extraTrust: DeviceEntry[] = []) {
    const signerFp = e.revokedBy ?? e.addedBy;
    const signer = signerFp === e.fp && !e.revokedBy ? e : this.entry(signerFp) ?? extraTrust.find((x) => x.fp === signerFp) ?? null;
    if (!signer || (signer.revokedAt && signer.fp !== e.fp)) return false;
    if (fpOf(e.publicKey) !== e.fp) return false;
    const { sig, ...rest } = e;
    return verifyEd25519(signer.publicKey, deviceStatement(rest), sig);
  }
  devices(): DeviceView[] {
    const me = this.selfFp();
    return (this.db.prepare('SELECT * FROM sync_devices ORDER BY rowid').all() as { fp: string; entry: string; revoked: number; endpoints: string; last_seen: number | null; last_sync: number | null; error: string | null }[]).map((r) => {
      const e = DeviceEntry.parse(JSON.parse(r.entry));
      return { fp: r.fp, name: e.name, platform: e.platform, current: r.fp === me, revoked: !!r.revoked, addedAt: e.addedAt, lastSeen: r.last_seen, lastSync: r.last_sync, error: r.error, endpoints: JSON.parse(r.endpoints), tlsCa: e.tlsCa, tlsSpki: e.tlsSpki, publicKey: e.publicKey };
    });
  }
  private selfFp() { return (this.db.prepare('SELECT fp FROM sync_self').get() as { fp: string } | undefined)?.fp ?? ''; }
  isTrusted(fp: string) { const d = this.db.prepare('SELECT revoked FROM sync_devices WHERE fp = ?').get(fp) as { revoked: number } | undefined; return !!d && !d.revoked && fp !== this.selfFp(); }
  setEndpoints(fp: string, endpoints: string[]) { this.own(() => this.db.prepare('UPDATE sync_devices SET endpoints = ? WHERE fp = ?').run(JSON.stringify(endpoints.slice(0, 8)), fp)); }
  /** Unlink: signed revocation, propagated to the other devices on their next sync. Data already on it can't be wiped remotely. */
  revoke(fp: string) {
    const e = this.entry(fp); if (!e) throw new Error('No such device.');
    if (fp === this.selfFp()) throw new Error('Unlink this device from one of your other devices.');
    if (e.revokedAt) return;
    this.putDevice(this.sign({ ...e, revokedAt: this.now(), revokedBy: this.selfFp() }));
  }
  /** This device learned it was unlinked: stop syncing (local data stays). */
  markSelfRevoked() { this.setSettings({ paused: true }); this.db.prepare("UPDATE sync_devices SET error = 'unlinked' WHERE fp = ?").run(this.selfFp()); }
  selfRevoked() { const r = this.db.prepare('SELECT revoked, error FROM sync_devices WHERE fp = ?').get(this.selfFp()) as { revoked: number; error: string | null } | undefined; return !!r && (!!r.revoked || r.error === 'unlinked'); }

  settings(): SyncSettings { const r = this.db.prepare('SELECT json FROM sync_settings').get() as { json: string } | undefined; return { ...DEFAULTS, ...(r ? JSON.parse(r.json) : {}) }; }
  setSettings(patch: Partial<SyncSettings>) {
    const before = this.settings(), next = { ...before, ...z.object({ syncDiary: z.boolean(), files: z.enum(['all', 'small', 'off']), paused: z.boolean() }).partial().parse(patch) };
    this.db.prepare('INSERT INTO sync_settings (one, json) VALUES (1, ?) ON CONFLICT (one) DO UPDATE SET json = excluded.json').run(JSON.stringify(next));
    if (!before.syncDiary && next.syncDiary) tx(this.db, () => { // turning Diary on: send ours and re-read theirs once
      for (const m of this.db.prepare("SELECT id FROM sync_meta WHERE kind = 'diary'").all() as { id: string }[]) this.db.prepare("UPDATE sync_meta SET seq = ? WHERE kind = 'diary' AND id = ?").run(this.nextSeq(), m.id);
      this.db.prepare('UPDATE sync_devices SET pulled = 0').run();
    });
    if (next.files !== before.files) this.db.prepare("UPDATE sync_transfers SET state = 'pending' WHERE state = 'skipped'").run();
    return next;
  }

  // ---------------- change records ----------------
  private nextSeq() { return ((this.db.prepare('SELECT coalesce(max(seq), 0) + 1 n FROM sync_meta').get() as { n: number }).n); }
  private tick(observed?: string) {
    const last = (this.db.prepare('SELECT last FROM sync_clock').get() as { last: string } | undefined)?.last ?? hlc(0, 0, '');
    const l = hlcParts(last), o = observed ? hlcParts(observed) : null, now = this.now();
    const ms = Math.max(now, l.ms, o?.ms ?? 0);
    const counter = ms === l.ms && ms === (o?.ms ?? -1) ? Math.max(l.counter, o!.counter) + 1 : ms === l.ms ? l.counter + 1 : ms === o?.ms ? o.counter + 1 : 0;
    const v = hlc(ms, counter, this.selfFp() || 'local');
    this.db.prepare('INSERT INTO sync_clock (one, last) VALUES (1, ?) ON CONFLICT (one) DO UPDATE SET last = excluded.last').run(v);
    return v;
  }
  private meta(kind: string, id: string): Meta | null {
    const r = this.db.prepare('SELECT * FROM sync_meta WHERE kind = ? AND id = ?').get(kind, id) as (Omit<Meta, 'history' | 'deleted'> & { history: string; deleted: number }) | undefined;
    return r ? { ...r, history: JSON.parse(r.history), deleted: !!r.deleted } : null;
  }
  private writeMeta(m: Omit<Meta, 'seq'>) {
    this.db.prepare(`INSERT INTO sync_meta (kind, id, version, hash, history, deleted, seq) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (kind, id) DO UPDATE SET version = excluded.version, hash = excluded.hash, history = excluded.history, deleted = excluded.deleted, seq = excluded.seq`)
      .run(m.kind, m.id, m.version, m.hash, JSON.stringify([...new Set(m.history)].filter((h) => h !== m.hash).slice(-HISTORY)), m.deleted ? 1 : 0, this.nextSeq());
  }
  private touchMeta(kind: string, id: string, payload: unknown, deleted: boolean) {
    const m = this.meta(kind, id), h = deleted ? `tomb:${(m?.hash ?? id).slice(0, 26)}` : contentHash(payload);
    if (m && m.hash === h) return false;
    this.writeMeta({ kind, id, version: this.tick(), hash: h, history: m ? [...m.history, m.hash] : [], deleted });
    return true;
  }
  private enabled(p: SyncProvider) { return !p.sensitive || this.settings().syncDiary; }
  /** Local change detection: hashes every synced entity; changed/new ones get a new version, vanished ones a tombstone. */
  refresh() {
    if (!this.account()) return 0;
    // nothing written on this connection since the last scan → nothing to detect (SQLite counts every row change)
    if (this.written() === this.scanned) return 0;
    const owner = this.identity.localUser(); let n = 0;
    tx(this.db, () => {
      for (const p of this.providers.values()) {
        if (!this.enabled(p)) continue;
        const all = p.all(owner);
        const metas = new Map((this.db.prepare('SELECT id, hash, deleted FROM sync_meta WHERE kind = ?').all(p.kind) as { id: string; hash: string; deleted: number }[]).map((m) => [m.id, m]));
        for (const [id, payload] of all) { const m = metas.get(id); if (!m || m.deleted || m.hash !== contentHash(payload)) { if (this.touchMeta(p.kind, id, payload, false)) n++; } }
        for (const [id, m] of metas) if (!m.deleted && !all.has(id)) { this.touchMeta(p.kind, id, null, true); n++; }
      }
    });
    this.scanned = this.written();
    return n;
  }
  /** Change records after `since` (this device's seq), with current content. */
  changes(since: number, limit = 200): SyncBatch {
    if (!this.account()) throw new Error('Sync is not set up.');
    this.refresh();
    const owner = this.identity.localUser();
    const rows = this.db.prepare('SELECT * FROM sync_meta WHERE seq > ? ORDER BY seq LIMIT ?').all(since, limit + 1) as (Omit<Meta, 'history' | 'deleted'> & { history: string; deleted: number })[];
    const more = rows.length > limit, page = rows.slice(0, limit);
    const records: SyncRecord[] = [];
    for (const r of page) {
      let payload: unknown = null;
      if (r.kind === 'device') payload = this.entry(r.id);
      else { const p = this.providers.get(r.kind); if (!p || !this.enabled(p)) continue; if (!r.deleted) payload = p.one(owner, r.id); if (!r.deleted && payload === null) continue; }
      records.push({ kind: r.kind, id: r.id, version: r.version, hash: r.hash, history: JSON.parse(r.history), deleted: !!r.deleted, payload });
    }
    return { records, next: page.at(-1)?.seq ?? since, more };
  }
  pending(fp?: string) {
    const pushed = fp ? (this.db.prepare('SELECT pushed FROM sync_devices WHERE fp = ?').get(fp) as { pushed: number } | undefined)?.pushed ?? 0
      : (this.db.prepare('SELECT coalesce(min(pushed), 0) p FROM sync_devices WHERE revoked = 0 AND fp <> ?').get(this.selfFp()) as { p: number }).p;
    return (this.db.prepare('SELECT count(*) n FROM sync_meta WHERE seq > ?').get(pushed) as { n: number }).n;
  }

  // ---------------- applying remote records ----------------
  /** Applies a batch from a trusted device. Each record is atomic; failures are deferred, never half-applied. */
  async applyBatch(fromFp: string, raw: unknown[]) {
    if (!this.isTrusted(fromFp)) throw new SyncAuthError('unknown_device', 'That device is not linked to this account.');
    const records = raw.map((r) => SyncRecord.parse(r));
    return this.own(() => {
      let accepted = 0;
      for (const r of records) if (this.applyRecord(fromFp, r)) accepted++;
      this.retryDeferred();
      return { accepted };
    });
  }
  private applyRecord(fromFp: string, rec: SyncRecord): boolean {
    if (rec.kind === 'device') return this.applyDevice(rec);
    const p = this.providers.get(rec.kind), owner = this.identity.localUser();
    if (!p || !this.enabled(p)) return false; // unknown (newer app) or turned off here
    this.tick(rec.version);
    let m = this.meta(rec.kind, rec.id);
    // A local edit made after this round's change scan (rounds await the network) must not look "unchanged": record it
    // now, so the incoming version is compared with what is really here instead of fast-forwarding over it.
    if (m && p.policy !== 'union') {
      const live = p.one(owner, rec.id);
      if (live === null ? !m.deleted : m.deleted || contentHash(live) !== m.hash) { this.touchMeta(rec.kind, rec.id, live, live === null); m = this.meta(rec.kind, rec.id); }
    }
    if (m && m.hash === rec.hash) return false; // already have it (idempotent)
    if (!m && p.policy !== 'union') { // first sight here, but this device may already hold its own version (same day, profile)
      const local = p.one(owner, rec.id);
      if (local !== null && contentHash(local) !== rec.hash) {
        if (p.policy === 'preserve') { this.conflict(rec, fromFp, 'preserve', 'Both devices have a version. Compare and choose.', local, rec.payload, false); return true; }
        this.conflict(rec, fromFp, 'lww', 'Both devices had a version — the other device’s was kept; this one is here.', local, rec.payload, true);
      }
    }
    if (!m || rec.history.includes(m.hash)) return this.applyRemote(p, fromFp, rec, m, false);
    if (m.history.includes(rec.hash)) return false; // stale: we already moved on from it
    // concurrent edits
    if (p.policy === 'union') return this.applyRemote(p, fromFp, rec, m, true);
    const local = m.deleted ? null : p.one(owner, rec.id);
    if (p.policy === 'lww') {
      const remoteWins = rec.version > m.version;
      this.conflict(rec, fromFp, 'lww', remoteWins ? 'Edited on two devices — the newer edit was kept; the other is here.' : 'Edited on two devices — this device’s newer edit was kept.', remoteWins ? local : rec.payload, remoteWins ? rec.payload : local, true);
      if (remoteWins) return this.applyRemote(p, fromFp, rec, m, false);
      tx(this.db, () => this.writeMeta({ ...m, version: this.tick(), history: [...m.history, m.hash, rec.hash] }));
      return true;
    }
    // preserve: never lose writing
    if (m.deleted && !rec.deleted) { this.conflict(rec, fromFp, 'preserve', 'Deleted here but edited on another device — restored.', null, rec.payload, true); return this.applyRemote(p, fromFp, rec, m, false); }
    if (rec.deleted && !m.deleted) {
      this.conflict(rec, fromFp, 'preserve', 'Deleted on another device but edited here — kept.', local, null, true);
      tx(this.db, () => this.writeMeta({ ...m, version: this.tick(), history: [...m.history, rec.hash] }));
      return true;
    }
    this.conflict(rec, fromFp, 'preserve', 'Edited on two devices while apart. Compare and choose.', local, rec.payload, false);
    return true;
  }
  private applyRemote(p: SyncProvider, fromFp: string, rec: SyncRecord, m: Meta | null, merge: boolean): boolean {
    const owner = this.identity.localUser();
    try {
      const ok = tx(this.db, () => {
        const r = p.apply(owner, rec.id, rec.deleted ? null : rec.payload, { merge });
        if (r && 'needs' in r) { this.needObject(r.needs, fromFp, rec); return false; }
        const after = rec.deleted ? null : p.one(owner, rec.id);
        const h = rec.deleted ? rec.hash : after === null ? rec.hash : contentHash(after);
        const history = [...(m?.history ?? []), ...(m ? [m.hash] : []), ...rec.history, rec.hash];
        this.writeMeta({ kind: rec.kind, id: rec.id, version: merge ? this.tick() : rec.version > (m?.version ?? '') ? rec.version : this.tick(), hash: h, history, deleted: rec.deleted });
        this.db.prepare('DELETE FROM sync_deferred WHERE kind = ? AND id = ?').run(rec.kind, rec.id);
        // a version descending from both sides settles any open conflict about this entity
        this.db.prepare("UPDATE sync_conflicts SET resolved_at = ?, resolution = 'superseded' WHERE kind = ? AND entity_id = ? AND resolved_at IS NULL").run(this.now(), rec.kind, rec.id);
        return true;
      });
      if (ok) this.applied(rec.kind, rec.id);
      return ok;
    } catch (e) {
      if (e instanceof SyncDefer || isFk(e)) { this.defer(rec, fromFp); return false; }
      // never half-applied (the transaction rolled back) and never silently dropped: shown for the student to decide
      this.db.prepare('DELETE FROM sync_deferred WHERE kind = ? AND id = ?').run(rec.kind, rec.id);
      const note = e instanceof SyncConflict ? e.message || 'Both devices have a version. Compare and choose.' : `Couldn’t apply on this device (${String((e as Error).message).slice(0, 120)}).`;
      this.conflict(rec, fromFp, 'preserve', note, p.one(owner, rec.id), rec.payload, false);
      return true;
    }
  }
  private defer(rec: SyncRecord, fromFp: string) {
    this.db.prepare('INSERT INTO sync_deferred (kind, id, record, from_fp, tries) VALUES (?, ?, ?, ?, 1) ON CONFLICT (kind, id) DO UPDATE SET record = excluded.record, tries = sync_deferred.tries + 1').run(rec.kind, rec.id, JSON.stringify(rec), fromFp);
  }
  private retryDeferred() {
    for (let pass = 0; pass < 3; pass++) {
      const rows = this.db.prepare('SELECT * FROM sync_deferred WHERE tries < 50 ORDER BY rowid LIMIT 2000').all() as { kind: string; id: string; record: string; from_fp: string }[];
      if (!rows.length) return;
      let progress = 0;
      for (const r of rows) { const rec = SyncRecord.parse(JSON.parse(r.record)); if (this.applyRecord(r.from_fp, rec)) progress++; else if (!this.db.prepare('SELECT 1 FROM sync_deferred WHERE kind = ? AND id = ?').get(r.kind, r.id)) progress++; }
      if (!progress) return;
    }
  }
  private conflict(rec: SyncRecord, fromFp: string, policy: string, note: string, local: unknown, remote: unknown, resolved: boolean) {
    if (this.db.prepare('SELECT 1 FROM sync_conflicts WHERE kind = ? AND entity_id = ? AND remote_hash = ?').get(rec.kind, rec.id, rec.hash)) return;
    this.db.prepare('INSERT INTO sync_conflicts (id, kind, entity_id, policy, note, local, remote, remote_hash, from_fp, created_at, resolved_at, resolution) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), rec.kind, rec.id, policy, note, JSON.stringify(local ?? null), JSON.stringify(remote ?? null), rec.hash, fromFp, this.now(), resolved ? this.now() : null, resolved ? 'automatic' : null);
  }
  private applyDevice(rec: SyncRecord) {
    const e = DeviceEntry.safeParse(rec.payload);
    if (!e.success || e.data.fp !== rec.id || !this.verifyEntry(e.data)) return false;
    const cur = this.entry(rec.id);
    if (cur?.revokedAt && !e.data.revokedAt) return false; // revocation is permanent
    if (cur && JSON.stringify(cur) === JSON.stringify(e.data)) return false;
    tx(this.db, () => this.putDevice(e.data));
    return true;
  }

  /** One-time import of records produced on THIS device by an older format (the phone's pre-core study data): each is
   *  applied by its module's provider as local data, then detected as a normal local change. Returns how many applied. */
  importLocal(raw: unknown[]) {
    const owner = this.identity.localUser(); let n = 0;
    for (const r of raw.map((x) => SyncRecord.parse(x))) {
      const p = this.providers.get(r.kind); if (!p) continue;
      try { tx(this.db, () => p.apply(owner, r.id, r.payload, { merge: false })); n++; } catch { /* skip what can't apply (e.g. a dangling reference) */ }
    }
    return n;
  }

  // ---------------- conflicts ----------------
  conflicts(open = true): ConflictView[] {
    return (this.db.prepare(`SELECT c.*, d.entry FROM sync_conflicts c LEFT JOIN sync_devices d ON d.fp = c.from_fp WHERE ${open ? 'c.resolved_at IS NULL' : '1'} ORDER BY c.created_at DESC LIMIT 200`).all() as { id: string; kind: string; entity_id: string; policy: string; note: string; local: string; remote: string; from_fp: string; created_at: number; entry: string | null }[])
      .map((r) => ({ id: r.id, kind: r.kind, entityId: r.entity_id, policy: r.policy, note: r.note, local: JSON.parse(r.local), remote: JSON.parse(r.remote), fromDevice: r.entry ? JSON.parse(r.entry).name : 'another device', createdAt: r.created_at, canKeepBoth: !!this.providers.get(r.kind)?.keepBoth }));
  }
  private listeners: ((kind: string, id: string) => void)[] = [];
  /** Called after a remote change was applied (the composition root reindexes search). */
  onApplied(f: (kind: string, id: string) => void) { this.listeners.push(f); }
  private applied(kind: string, id: string) { for (const f of this.listeners) f(kind, id); }
  resolve(conflictId: string, choice: 'mine' | 'theirs' | 'both') {
    const c = this.db.prepare('SELECT * FROM sync_conflicts WHERE id = ? AND resolved_at IS NULL').get(conflictId) as { kind: string; entity_id: string; remote: string; remote_hash: string } | undefined;
    if (!c) throw new Error('Already resolved.');
    const p = this.providers.get(c.kind), owner = this.identity.localUser();
    if (!p) throw new Error('This kind is not synced on this device.');
    tx(this.db, () => {
      const m = this.meta(c.kind, c.entity_id);
      if (choice === 'theirs') p.apply(owner, c.entity_id, JSON.parse(c.remote), { merge: false });
      if (choice === 'both') { if (!p.keepBoth) throw new Error('This kind can’t keep both.'); p.keepBoth(owner, c.entity_id, JSON.parse(c.remote)); }
      const now = p.one(owner, c.entity_id);
      // the result descends from both versions, so the other device fast-forwards to it
      this.writeMeta({ kind: c.kind, id: c.entity_id, version: this.tick(), hash: now === null ? `tomb:${c.entity_id.slice(0, 26)}` : contentHash(now), history: [...(m?.history ?? []), ...(m ? [m.hash] : []), c.remote_hash], deleted: now === null });
      this.db.prepare('UPDATE sync_conflicts SET resolved_at = ?, resolution = ? WHERE id = ?').run(this.now(), choice, conflictId);
      this.db.prepare('UPDATE sync_conflicts SET resolved_at = ?, resolution = ? WHERE kind = ? AND entity_id = ? AND resolved_at IS NULL').run(this.now(), 'superseded', c.kind, c.entity_id);
    });
    this.applied(c.kind, c.entity_id);
  }

  // ---------------- resources ----------------
  private needObject(n: { sha256: string; size: number; mime: string }, fromFp: string, rec: SyncRecord) {
    const s = this.settings();
    const skip = s.files === 'off' || (s.files === 'small' && n.size > SMALL_FILE);
    const cur = this.db.prepare('SELECT waiting FROM sync_transfers WHERE sha256 = ?').get(n.sha256) as { waiting: string } | undefined;
    const waiting = [...(cur ? JSON.parse(cur.waiting) as SyncRecord[] : []).filter((w) => !(w.kind === rec.kind && w.id === rec.id)), rec];
    this.db.prepare(`INSERT INTO sync_transfers (sha256, size, mime, from_fp, state, waiting, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (sha256) DO UPDATE SET waiting = excluded.waiting, from_fp = excluded.from_fp, updated_at = excluded.updated_at`).run(n.sha256, n.size, n.mime, fromFp, skip ? 'skipped' : 'pending', JSON.stringify(waiting), this.now());
  }
  transfers() { return this.db.prepare('SELECT sha256, size, mime, from_fp fromFp, received, state, error FROM sync_transfers ORDER BY updated_at DESC LIMIT 200').all() as { sha256: string; size: number; mime: string; fromFp: string; received: number; state: string; error: string | null }[]; }
  /** Fetches pending objects from a peer: resumable (.part keeps received bytes), SHA-256 verified, then the waiting records apply. */
  async fetchObjects(t: SyncTransport, o: { signal?: AbortSignal } = {}) {
    const rows = this.db.prepare("SELECT * FROM sync_transfers WHERE from_fp = ? AND state IN ('pending','partial','failed','waiting_space') ORDER BY size LIMIT 100").all(t.peer) as { sha256: string; size: number; mime: string; waiting: string }[];
    let done = 0; await mkdir(this.tmpDir, { recursive: true });
    for (const r of rows) {
      if (o.signal?.aborted) break;
      const part = join(this.tmpDir, `${r.sha256}.part`);
      const have = await stat(part).then((s) => s.size, () => 0);
      if (r.size - have > (await this.freeBytes()) - 256 * 1024 * 1024) { this.db.prepare("UPDATE sync_transfers SET state = 'waiting_space', error = 'Not enough free space' WHERE sha256 = ?").run(r.sha256); continue; }
      const fh = await open(part, 'a');
      let received = have;
      try {
        for await (const chunk of await t.object(r.sha256, have)) { await fh.write(chunk); received += chunk.length; if (received > r.size) throw new Error('More bytes than expected.'); }
      } catch (e) {
        await fh.close();
        this.db.prepare("UPDATE sync_transfers SET state = 'partial', received = ?, error = ?, updated_at = ? WHERE sha256 = ?").run(received, String((e as Error).message).slice(0, 200), this.now(), r.sha256);
        continue;
      }
      await fh.close();
      if ((await sha256File(part)).sha256 !== r.sha256 || received !== r.size) { await rm(part, { force: true }); this.db.prepare("UPDATE sync_transfers SET state = 'failed', received = 0, error = 'Checksum mismatch; will retry', updated_at = ? WHERE sha256 = ?").run(this.now(), r.sha256); continue; }
      await this.ingest(part, r.mime);
      this.db.prepare('DELETE FROM sync_transfers WHERE sha256 = ?').run(r.sha256);
      for (const w of JSON.parse(r.waiting) as SyncRecord[]) this.applyRecord(t.peer, w);
      done++;
    }
    return done;
  }

  // ---------------- one sync round with a peer (any transport) ----------------
  async syncWith(t: SyncTransport, o: { signal?: AbortSignal } = {}) {
    if (!this.isTrusted(t.peer)) throw new SyncAuthError('unknown_device', 'That device is not linked.');
    if (this.settings().paused) return { pulled: 0, pushed: 0, objects: 0, skipped: 'paused' as const };
    const cur = () => this.db.prepare('SELECT pulled, pushed FROM sync_devices WHERE fp = ?').get(t.peer) as { pulled: number; pushed: number };
    let pulled = 0, pushed = 0;
    try {
      if (cur().pulled > 0) this.refresh(); // a newly linked device takes in its account first, then offers its own data
      for (let more = true; more && !o.signal?.aborted;) { // pull — checkpoint persisted after each applied page
        const b = await t.pull(cur().pulled, 200);
        const r = await this.applyBatch(t.peer, b.records);
        pulled += r.accepted;
        this.own(() => this.db.prepare('UPDATE sync_devices SET pulled = ? WHERE fp = ?').run(b.next, t.peer));
        more = b.more;
      }
      this.refresh();
      for (let more = true; more && !o.signal?.aborted;) { // push
        const b = this.changes(cur().pushed, 200);
        if (b.records.length) { const r = await t.push(b.records); pushed += r.accepted; }
        this.own(() => this.db.prepare('UPDATE sync_devices SET pushed = ? WHERE fp = ?').run(b.next, t.peer));
        more = b.more;
      }
      const objects = await this.fetchObjects(t, o);
      this.own(() => this.db.prepare('UPDATE sync_devices SET last_sync = ?, last_seen = ?, error = NULL WHERE fp = ?').run(this.now(), this.now(), t.peer));
      return { pulled, pushed, objects, skipped: null };
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === 'revoked') this.markSelfRevoked();
      this.db.prepare('UPDATE sync_devices SET error = ? WHERE fp = ?').run(String((e as Error).message).slice(0, 200), t.peer);
      throw e;
    }
  }

  // ---------------- transport-facing (server side) ----------------
  /** Verifies a signed request from a linked device (on top of pinned TLS). Returns the caller's fingerprint. */
  verifyRequest(h: { auth: string | undefined; sig: string | undefined }, method: string, path: string, bodySha: string) {
    let a: { fp: string; ts: number; nonce: string; bodySha: string };
    try { a = z.object({ fp: z.string().max(64), ts: z.number().int(), nonce: z.string().min(16).max(64), bodySha: z.string().max(64) }).parse(JSON.parse(new TextDecoder().decode(b64u.decode(h.auth ?? '')))); } catch { throw new SyncAuthError('bad_auth', 'Missing or malformed authentication.'); }
    const d = this.db.prepare('SELECT entry, revoked FROM sync_devices WHERE fp = ?').get(a.fp) as { entry: string; revoked: number } | undefined;
    if (!d || a.fp === this.selfFp()) throw new SyncAuthError('unknown_device', 'This device is not linked to the account.');
    if (d.revoked) throw new SyncAuthError('revoked', 'This device was unlinked.');
    if (Math.abs(this.now() - a.ts) > REQUEST_SKEW_MS) throw new SyncAuthError('stale', 'Request too old or clock too far off.');
    if (a.bodySha !== bodySha) throw new SyncAuthError('bad_auth', 'Body does not match the signature.');
    const key = `${a.fp}:${a.nonce}`;
    for (const [k, t] of this.seen) if (t < this.now() - 2 * REQUEST_SKEW_MS) this.seen.delete(k);
    if (this.seen.has(key)) throw new SyncAuthError('replay', 'Request was replayed.');
    if (!verifyEd25519(DeviceEntry.parse(JSON.parse(d.entry)).publicKey, requestStatement({ method, path, ts: a.ts, nonce: a.nonce, bodySha, fp: a.fp }), h.sig ?? '')) throw new SyncAuthError('bad_auth', 'Signature does not verify.');
    this.seen.set(key, this.now());
    this.own(() => this.db.prepare('UPDATE sync_devices SET last_seen = ? WHERE fp = ?').run(this.now(), a.fp));
    return a.fp;
  }
  /** Client side: auth headers for a request. */
  authHeaders(method: string, path: string, body: string) {
    if (!this.signer) throw new Error('Sync is not set up.');
    const bodySha = createHash('sha256').update(body).digest('base64url'), ts = this.now(), nonce = randomBytes(18).toString('base64url');
    const auth = b64u.encode(new TextEncoder().encode(JSON.stringify({ fp: this.signer.fp, ts, nonce, bodySha })));
    return { 'x-clan-sync': auth, 'x-clan-sync-sig': this.signer.sign(requestStatement({ method, path, ts, nonce, bodySha, fp: this.signer.fp })) };
  }
  bodySha(body: string | Uint8Array) { return createHash('sha256').update(body).digest('base64url'); }

  // ---------------- linking ----------------
  /** Trusted device: a short single-use code (60 bits), valid 2 minutes. Never the CLAN join code. */
  startLink() {
    const bytes = randomBytes(12); const code = [...bytes].map((b) => LINK_ALPHABET[b % 32]).join('');
    this.link = { sessionId: randomUUID(), key: linkKey(code), nonceA: randomBytes(18).toString('base64url'), expiresAt: this.now() + LINK_TTL_MS, tries: 0, hello: null, state: 'waiting', grant: null, proofA: null };
    return { code: formatLinkCode(code), sessionId: this.link.sessionId, expiresAt: this.link.expiresAt, raw: code };
  }
  cancelLink() { this.link = null; }
  private liveLink() { const l = this.link; if (!l || l.expiresAt < this.now() || l.state === 'rejected') { this.link = null; throw new SyncAuthError('no_link', 'No device link is open on this device.'); } return l; }
  linkStart() { const l = this.liveLink(); return { sessionId: l.sessionId, nonceA: l.nonceA }; }
  /** Joiner's hello: proof of the code bound to our TLS key, and proof it holds its device key. */
  linkHello(raw: unknown, serverSpki: string) {
    const l = this.liveLink(), h = LinkHello.parse(raw);
    if (h.sessionId !== l.sessionId || l.state !== 'waiting') throw new SyncAuthError('no_link', 'This link was already used.');
    const t = linkTranscript('joiner', { sessionId: l.sessionId, serverSpki, joinerKey: h.device.publicKey, nonceA: l.nonceA, nonceB: h.nonceB });
    const ok = eq(createHmac('sha256', l.key).update(t).digest('base64url'), h.proof) && verifyEd25519(h.device.publicKey, new TextEncoder().encode(t), h.sig) && fpOf(h.device.publicKey) === h.device.fp;
    if (!ok) { if (++l.tries >= 3) this.link = null; throw new SyncAuthError('bad_code', 'That code is not right.'); }
    l.hello = { ...h, serverSpki }; l.state = 'pending';
    return { status: 'pending' as const };
  }
  linkRequest() { const l = this.link; return l && l.state === 'pending' && l.hello ? { sessionId: l.sessionId, name: l.hello.device.name, platform: l.hello.device.platform, fp: l.hello.device.fp } : null; }
  /** Explicit approval on the trusted device: signs the new device into the account. */
  approveLink(sessionId: string, approverEndpoints: string[]) {
    const l = this.liveLink(); if (l.sessionId !== sessionId || l.state !== 'pending' || !l.hello) throw new Error('Nothing to approve.');
    const d = l.hello.device, me = this.selfFp(), acc = this.account()!;
    tx(this.db, () => { this.putDevice(this.sign({ fp: d.fp, publicKey: d.publicKey, name: d.name, platform: d.platform, tlsCa: d.tlsCa, tlsSpki: d.tlsSpki, addedAt: this.now(), addedBy: me, revokedAt: null, revokedBy: null })); this.setEndpoints(d.fp, d.endpoints); });
    const grant: LinkGrant = { accountId: acc.accountId, accountName: this.identity.displayName(acc.accountId) ?? 'Me', discoverySecret: acc.discoverySecret, devices: this.devices().map((x) => this.entry(x.fp)!), approver: { fp: me, endpoints: approverEndpoints } };
    l.grant = grant; l.state = 'approved';
    l.proofA = createHmac('sha256', l.key).update(linkTranscript('approver', { sessionId: l.sessionId, serverSpki: l.hello.serverSpki, joinerKey: d.publicKey, nonceA: l.nonceA, nonceB: l.hello.nonceB })).digest('base64url');
  }
  rejectLink(sessionId: string) { if (this.link?.sessionId === sessionId) this.link.state = 'rejected'; }
  linkStatus(sessionId: string, nonceB: string) {
    const l = this.link; if (!l || l.sessionId !== sessionId || l.hello?.nonceB !== nonceB) throw new SyncAuthError('no_link', 'No such link.');
    if (l.state === 'approved') { const out = { status: 'approved' as const, proof: l.proofA!, grant: l.grant }; this.link = null; return out; } // single use
    if (l.state === 'rejected') { this.link = null; return { status: 'rejected' as const }; }
    return { status: 'pending' as const };
  }
  /** Joiner, after verifying the approver's proof: joins the account. This device's own data moves to the account. */
  adopt(raw: unknown) {
    const g = LinkGrant.parse(raw), me = this.selfFp();
    const mine = g.devices.find((d) => d.fp === me);
    if (!mine) throw new Error('The grant does not include this device.');
    const trusted: DeviceEntry[] = [];
    for (const d of [...g.devices].sort((a, b) => a.addedAt - b.addedAt)) if (this.verifyEntryWith(d, trusted)) trusted.push(d);
    if (!trusted.some((d) => d.fp === me) || !trusted.some((d) => d.fp === g.approver.fp)) throw new Error('The device list could not be verified.');
    tx(this.db, () => {
      this.db.prepare('DELETE FROM sync_account').run();
      this.db.prepare('INSERT INTO sync_account (one, account_id, discovery_secret, created_at) VALUES (1, ?, ?, ?)').run(g.accountId, g.discoverySecret, this.now());
      this.db.prepare('DELETE FROM sync_devices').run(); this.db.prepare('DELETE FROM sync_meta').run(); // versions start fresh in the account
      for (const d of trusted) this.putDevice(d);
      this.setEndpoints(g.approver.fp, g.approver.endpoints);
    });
    return { accountId: g.accountId, accountName: g.accountName };
  }
  private verifyEntryWith(e: DeviceEntry, trusted: DeviceEntry[]) {
    const signerFp = e.revokedBy ?? e.addedBy;
    const signer = signerFp === e.fp && !e.revokedBy && !trusted.length ? e : trusted.find((x) => x.fp === signerFp) ?? null;
    if (!signer || fpOf(e.publicKey) !== e.fp) return false;
    const { sig, ...rest } = e;
    return verifyEd25519(signer.publicKey, deviceStatement(rest), sig);
  }
  /** Storage numbers for the UI (no invented progress). */
  stats() {
    const n = (sql: string) => (this.db.prepare(sql).get() as { n: number }).n;
    return { tracked: n('SELECT count(*) n FROM sync_meta'), pending: this.pending(), conflicts: n('SELECT count(*) n FROM sync_conflicts WHERE resolved_at IS NULL'), deferred: n('SELECT count(*) n FROM sync_deferred'),
      transfers: n("SELECT count(*) n FROM sync_transfers WHERE state <> 'skipped'"), transferBytes: n("SELECT coalesce(sum(size - received), 0) n FROM sync_transfers WHERE state <> 'skipped'"), skippedBytes: n("SELECT coalesce(sum(size), 0) n FROM sync_transfers WHERE state = 'skipped'") };
  }
}
export { fpOf, contentHash };

/** The profile (display name) as a synced record. */
export const profileProvider = (identity: Identity): SyncProvider => ({
  kind: 'profile', policy: 'lww',
  all: (o) => new Map([['me', { name: identity.displayName(o) ?? 'Me' }]]),
  one: (o, id) => id === 'me' ? { name: identity.displayName(o) ?? 'Me' } : null,
  apply: (o, id, p) => { if (id === 'me' && p) identity.rename(o, z.object({ name: z.string().trim().min(1).max(80) }).parse(p).name); },
});
