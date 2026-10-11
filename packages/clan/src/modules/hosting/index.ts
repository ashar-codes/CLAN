// Hosting authority: this device's durable view of who may host each CLAN (docs/PHASE_14_2_HOSTING_DESIGN.md).
// Verification lives in @classroom/protocol; this module persists the highest accepted epoch before anything is
// acknowledged and enforces the local state machine: active → frozen → relinquished (never back to writing at that
// epoch), and staging → verified → acknowledged → active on the destination. It never stores private keys: callers
// pass a signer backed by the OS keystore. It grants no session, membership or file rights by itself.
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  authorityHash, b64u, CheckpointHeader, checkpointBlobs, checkpointHash, delegationProblem, hostAuthorized, HostAck, HostDelegation, HostRevocation, revokedDelegations, sectionBytes, sha256Hex,
  signHostStatement, verifyAuthorityChain, type AuthorityRecord, type CheckpointProvider, type HostSigner,
} from '@classroom/protocol';
import { z } from 'zod';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { sha256File } from '../../core/resources.ts';
import type { Clans } from '../clans/index.ts';

export const schema: ModuleSchema = {
  module: 'hosting', prefix: 'hosting',
  migrations: [`
    CREATE TABLE hosting_authority (clan_id TEXT PRIMARY KEY REFERENCES clans_clans(id), owner_key TEXT NOT NULL, epoch INTEGER NOT NULL,
      head_hash TEXT NOT NULL, chain TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('active','frozen','relinquished','standby','conflict')),
      conflict TEXT, updated_at INTEGER NOT NULL);
    -- The one transition this device signed when it relinquished epoch (epoch); it may only ever be replayed.
    CREATE TABLE hosting_transitions (clan_id TEXT PRIMARY KEY REFERENCES clans_clans(id), epoch INTEGER NOT NULL, record TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE hosting_revocations (delegation_id TEXT PRIMARY KEY, clan_id TEXT NOT NULL REFERENCES clans_clans(id), record TEXT NOT NULL);
    CREATE TABLE hosting_staging (clan_id TEXT NOT NULL REFERENCES clans_clans(id), epoch INTEGER NOT NULL, prev_hash TEXT NOT NULL,
      checkpoint_hash TEXT NOT NULL, delegation TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('staging','verified')),
      updated_at INTEGER NOT NULL, PRIMARY KEY (clan_id, epoch));
  `, `
    -- Owner key trusted for a CLAN before any chain is accepted: this device's own establish, the authenticated pairing
    -- with the CLAN's host, or a linked (personal sync) device. A chain naming another owner is never learned.
    CREATE TABLE hosting_anchors (clan_id TEXT PRIMARY KEY REFERENCES clans_clans(id), owner_key TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('owner','pairing','linked-device')), created_at INTEGER NOT NULL);
  `, `
    -- Source: the durable checkpoint of the frozen epoch (blob paths it may serve). Destination: the staged header.
    CREATE TABLE hosting_checkpoints (clan_id TEXT PRIMARY KEY REFERENCES clans_clans(id), epoch INTEGER NOT NULL, hash TEXT NOT NULL,
      header TEXT NOT NULL, paths TEXT NOT NULL, created_at INTEGER NOT NULL);
    ALTER TABLE hosting_staging ADD COLUMN header TEXT;
  `],
};

export type HostState = 'active' | 'frozen' | 'relinquished' | 'standby' | 'conflict';
export type HostStatus = { clanId: string; epoch: number; hostKey: string; ownerKey: string; state: HostState; writable: boolean; reason: string | null };
export class HostingError extends Error { readonly code: string; constructor(code: string, m: string) { super(m); this.code = code; } }

type Row = { clan_id: string; owner_key: string; epoch: number; head_hash: string; chain: string; state: HostState; conflict: string | null };
type Staged = { epoch: number; prev_hash: string; checkpoint_hash: string; delegation: string; state: 'staging' | 'verified'; header: string | null };
const DAY = 86_400_000;
const SHA = /^[0-9a-f]{64}$/;
const hashFile = sha256File;

export class HostAuthority {
  private db: Db; private clans: Clans; private now: () => number; private linkedDeviceKey: (publicKey: string) => boolean;
  private dir: string; private me: () => string;
  private providers = new Map<string, CheckpointProvider>();
  private busy = new Set<string>();
  /** `linkedDeviceKey`: true only for a verified, unrevoked personal-sync device key of this account. `dir`: hosting
   *  blobs (outgoing checkpoints, incoming staging). `me`: the local user, owner of an activated CLAN copy. */
  constructor(db: Db, clans: Clans, o: { now?: () => number; linkedDeviceKey?: (publicKey: string) => boolean; dir: string; me?: () => string }) {
    this.db = db; this.clans = clans; this.now = o.now ?? (() => Date.now()); this.linkedDeviceKey = o.linkedDeviceKey ?? (() => false);
    this.dir = o.dir; this.me = o.me ?? (() => '');
  }
  /** Each owning module (and the host server) contributes one section; both ends must register the same set. */
  register(p: CheckpointProvider) {
    if (this.providers.has(p.section)) throw new Error(`Duplicate checkpoint section ${p.section}.`);
    this.providers.set(p.section, p);
  }
  private async exclusive<T>(clanId: string, f: () => Promise<T>): Promise<T> {
    if (this.busy.has(clanId)) throw new HostingError('busy', 'A hosting step for this CLAN is already running.');
    this.busy.add(clanId);
    try { return await f(); } finally { this.busy.delete(clanId); }
  }

  private row(clanId: string) { return this.db.prepare('SELECT * FROM hosting_authority WHERE clan_id = ?').get(clanId) as Row | undefined; }
  private chain(r: Row) { return JSON.parse(r.chain) as AuthorityRecord[]; }
  private head(r: Row) { const c = this.chain(r); return c[c.length - 1]!; }
  private revocations(clanId: string) { return (this.db.prepare('SELECT record FROM hosting_revocations WHERE clan_id = ?').all(clanId) as { record: string }[]).map((x) => HostRevocation.parse(JSON.parse(x.record))); }
  private revoked(r: Row) { return revokedDelegations(r.clan_id, r.owner_key, this.revocations(r.clan_id)); }
  private must(clanId: string) { const r = this.row(clanId); if (!r) throw new HostingError('no_authority', 'This CLAN has no hosting authority record.'); return r; }
  private setState(clanId: string, state: HostState, conflict: string | null = null) {
    this.db.prepare('UPDATE hosting_authority SET state = ?, conflict = ?, updated_at = ? WHERE clan_id = ?').run(state, conflict, this.now(), clanId);
  }

  /** Owner-created CLAN: the owner's device key signs epoch 0 and hosts it. Legacy CLANs stay single-host until this runs. */
  establish(clanId: string, userId: string, owner: HostSigner): HostStatus {
    const c = this.clans.get(clanId);
    if (!c || this.clans.cleanup(clanId) || !this.clans.members(clanId).some((m) => m.userId === userId && m.role === 'owner' && m.status === 'active')) throw new HostingError('forbidden', 'Only the CLAN owner can establish hosting authority.');
    if (this.row(clanId)) throw new HostingError('exists', 'Hosting authority already exists for this CLAN.');
    const g = signHostStatement(owner, { type: 'clan-host-authority' as const, v: 1 as const, clanId, ownerKey: owner.publicKey, epoch: 0, hostKey: owner.publicKey, prevHash: null, checkpointHash: null, delegation: null, ack: null, issuedAt: this.now() });
    const chk = verifyAuthorityChain([g], { clanId });
    if (!chk.ok) throw new HostingError('invalid', chk.reason);
    tx(this.db, () => {
      this.anchor(clanId, owner.publicKey, 'owner');
      this.db.prepare('INSERT INTO hosting_authority (clan_id, owner_key, epoch, head_hash, chain, state, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
        .run(clanId, owner.publicKey, chk.hashes[0]!, JSON.stringify([g]), 'active', this.now());
    });
    return this.status(clanId, owner.publicKey)!;
  }

  // ---- owner-key anchors ----
  private anchor(clanId: string, ownerKey: string, source: 'owner' | 'pairing' | 'linked-device') {
    if (!this.clans.get(clanId)) throw new HostingError('unknown_clan', 'Unknown CLAN.');
    const a = this.anchorOf(clanId);
    if (a && a.ownerKey !== ownerKey) throw new HostingError('owner_mismatch', 'This CLAN is already bound to a different owner key.');
    if (!a) this.db.prepare('INSERT INTO hosting_anchors (clan_id, owner_key, source, created_at) VALUES (?, ?, ?, ?)').run(clanId, ownerKey, source, this.now());
  }
  anchorOf(clanId: string) {
    const a = this.db.prepare('SELECT owner_key k, source s FROM hosting_anchors WHERE clan_id = ?').get(clanId) as { k: string; s: string } | undefined;
    return a ? { ownerKey: a.k, source: a.s } : null;
  }
  /** Member side: called only with the genesis received inside the authenticated (OPAQUE + pinned TLS, host-approved)
   *  session of this exact CLAN. First binding wins; a later different owner is refused, never replaced. */
  anchorFromPairing(clanId: string, genesis: unknown) {
    const chk = verifyAuthorityChain([genesis], { clanId });
    if (!chk.ok) throw new HostingError('invalid', chk.reason);
    this.anchor(clanId, chk.head.ownerKey, 'pairing');
  }
  /** The owner is one of this account's own linked devices (mobile-created CLAN delegating to a linked desktop). */
  anchorLinkedOwner(clanId: string, ownerKey: string) {
    if (!this.linkedDeviceKey(ownerKey)) throw new HostingError('forbidden', 'The owner key is not a linked device of this account.');
    const a = this.anchorOf(clanId);
    // Same owner already learned in its authenticated session, now confirmed as one of our own devices.
    if (a?.source === 'pairing' && a.ownerKey === ownerKey) { this.db.prepare("UPDATE hosting_anchors SET source = 'linked-device' WHERE clan_id = ?").run(clanId); return; }
    // A CLAN this device already takes part in without an anchor (a legacy CLAN, possibly its own) can never be claimed
    // by another device: a hand-over would replace its data.
    if (!a && this.clans.members(clanId).length) throw new HostingError('forbidden', 'This CLAN already exists on this device and cannot be taken over.');
    this.anchor(clanId, ownerKey, 'linked-device');
  }

  status(clanId: string, localKey: string, at = this.now()): HostStatus | null {
    const r = this.row(clanId); if (!r) return null;
    const h = this.head(r);
    const reason = r.state === 'conflict' ? 'Conflicting hosting records; writes are unavailable until resolved.'
      : h.hostKey !== localKey ? 'Another device is the authorized host.'
      : r.state !== 'active' ? (r.state === 'frozen' ? 'Hosting is paused for a handoff.' : 'This device handed hosting over.')
      : !hostAuthorized(h, at, this.revoked(r)) ? 'This device\'s hosting permission has expired or was revoked.' : null;
    return { clanId, epoch: r.epoch, hostKey: h.hostKey, ownerKey: r.owner_key, state: r.state, writable: reason === null, reason };
  }
  chainOf(clanId: string) { const r = this.row(clanId); return r ? this.chain(r) : null; }

  /** Gate for every host write at the current epoch. */
  assertWritable(clanId: string, localKey: string) {
    const s = this.status(clanId, localKey);
    if (!s) throw new HostingError('no_authority', 'This CLAN has no hosting authority record.');
    if (!s.writable) throw new HostingError('not_authoritative', s.reason!);
    return s.epoch;
  }

  // ---- owner: delegation and revocation ----
  delegate(clanId: string, owner: HostSigner, destKey: string, o: { id: string; ttlMs?: number }): HostDelegation {
    const r = this.must(clanId);
    if (owner.publicKey !== r.owner_key) throw new HostingError('forbidden', 'Only the CLAN owner key can delegate hosting.');
    const at = this.now();
    return HostDelegation.parse(signHostStatement(owner, { type: 'clan-host-delegation' as const, v: 1 as const, id: o.id, clanId, ownerKey: r.owner_key, destKey, actions: ['host' as const], issuedAt: at, expiresAt: at + Math.min(o.ttlMs ?? 30 * DAY, 365 * DAY) }));
  }
  revoke(clanId: string, owner: HostSigner, delegationId: string) {
    const r = this.must(clanId);
    if (owner.publicKey !== r.owner_key) throw new HostingError('forbidden', 'Only the CLAN owner key can revoke hosting.');
    return this.addRevocation(signHostStatement(owner, { type: 'clan-host-revocation' as const, v: 1 as const, clanId, ownerKey: r.owner_key, delegationId, revokedAt: this.now() }));
  }
  /** Accepts a revocation from any source; only owner-signed ones for a known CLAN are stored. */
  addRevocation(rev: unknown) {
    const p = HostRevocation.safeParse(rev);
    const r = p.success ? this.row(p.data.clanId) : undefined;
    if (!p.success || !r || !revokedDelegations(r.clan_id, r.owner_key, [p.data]).has(p.data.delegationId)) throw new HostingError('invalid', 'Revocation is not signed by the CLAN owner.');
    this.db.prepare('INSERT OR IGNORE INTO hosting_revocations (delegation_id, clan_id, record) VALUES (?, ?, ?)').run(p.data.delegationId, r.clan_id, JSON.stringify(p.data));
    return p.data;
  }

  // ---- current host ----
  freeze(clanId: string, localKey: string) {
    const r = this.must(clanId);
    if (r.state === 'frozen') return;
    // Allowed even after expiry/revocation, so such a host can still hand authority back.
    if (r.state !== 'active' || this.head(r).hostKey !== localKey) throw new HostingError('not_authoritative', this.status(clanId, localKey)!.reason ?? 'Not the active host.');
    this.setState(clanId, 'frozen');
  }
  /** Abort a handoff before relinquishment. Impossible afterwards: the transition may already be activating elsewhere. */
  unfreeze(clanId: string, localKey: string) {
    const r = this.must(clanId);
    if (r.state !== 'frozen' || this.head(r).hostKey !== localKey || this.pendingTransition(clanId)) throw new HostingError('bad_state', 'Only the paused host that has not handed over can resume.');
    if (this.busy.has(clanId)) throw new HostingError('busy', 'A checkpoint is being prepared; try again when it finishes.');
    // Writes resume, so the checkpoint is stale: an acknowledgment of it can never be used for a hand-over.
    tx(this.db, () => { this.db.prepare('DELETE FROM hosting_checkpoints WHERE clan_id = ?').run(clanId); this.setState(clanId, 'active'); });
  }

  // ---- checkpoint (source) ----
  private outDir(clanId: string) { return join(this.dir, 'out', clanId); }
  private inDir(clanId: string) { return join(this.dir, 'in', clanId); }
  /**
   * Builds (once per frozen epoch) a consistent, content-addressed checkpoint: section rows are exported synchronously
   * from the frozen database, every file is re-hashed, and the header is stored durably before it is offered.
   */
  async prepareCheckpoint(clanId: string, localKey: string): Promise<{ header: CheckpointHeader; hash: string }> {
    return this.exclusive(clanId, async () => {
      const r = this.must(clanId);
      if (r.state !== 'frozen' || this.head(r).hostKey !== localKey) throw new HostingError('bad_state', 'Pause hosting on the current host before preparing a hand-over.');
      const have = this.checkpointOf(clanId);
      if (have && have.header.epoch === r.epoch) return have;
      if (!this.providers.size) throw new HostingError('unavailable', 'No checkpoint sections are registered.');
      const exported = [...this.providers.values()].map((p) => ({ name: p.section, ...p.export(clanId) }));
      const out = this.outDir(clanId);
      await rm(out, { recursive: true, force: true }); // section blobs of a discarded earlier checkpoint
      await mkdir(out, { recursive: true });
      const paths: Record<string, string> = {};
      const sections: CheckpointHeader['sections'] = {};
      for (const e of exported) {
        const bytes = sectionBytes(e.rows), sha = sha256Hex(bytes), path = join(out, sha);
        await rm(`${path}.tmp`, { force: true });
        const fh = await open(`${path}.tmp`, 'a');
        try { await fh.write(bytes); } finally { await fh.close(); }
        await rename(`${path}.tmp`, path);
        sections[e.name] = { sha256: sha, size: bytes.length, rows: e.rows.length };
        paths[sha] = path;
      }
      const files = new Map<string, number>();
      for (const f of exported.flatMap((e) => e.files)) {
        if (!SHA.test(f.sha256)) throw new HostingError('invalid', 'A CLAN file has no valid hash.');
        if (paths[f.sha256]) continue;
        const check = await hashFile(f.path).catch(() => null);
        if (!check || check.sha256 !== f.sha256 || check.size !== f.size) throw new HostingError('corrupt', 'A CLAN file on this device is missing or changed; it cannot be handed over.');
        paths[f.sha256] = f.path; files.set(f.sha256, f.size);
      }
      const header = CheckpointHeader.parse({ type: 'clan-host-checkpoint', v: 1, clanId, epoch: r.epoch, prevHash: r.head_hash, createdAt: this.now(), sections,
        files: [...files].sort(([a], [b]) => (a < b ? -1 : 1)).map(([sha256, size]) => ({ sha256, size })) });
      const hash = checkpointHash(header);
      this.db.prepare('INSERT INTO hosting_checkpoints (clan_id, epoch, hash, header, paths, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (clan_id) DO UPDATE SET epoch = excluded.epoch, hash = excluded.hash, header = excluded.header, paths = excluded.paths, created_at = excluded.created_at')
        .run(clanId, r.epoch, hash, JSON.stringify(header), JSON.stringify(paths), this.now());
      return { header, hash };
    });
  }
  checkpointOf(clanId: string) {
    const c = this.db.prepare('SELECT hash, header FROM hosting_checkpoints WHERE clan_id = ?').get(clanId) as { hash: string; header: string } | undefined;
    return c ? { header: CheckpointHeader.parse(JSON.parse(c.header)), hash: c.hash } : null;
  }
  /** Only blobs of the current frozen checkpoint are ever served. */
  checkpointBlob(clanId: string, sha256: string): string | null {
    const r = this.row(clanId);
    const c = this.db.prepare('SELECT epoch, paths FROM hosting_checkpoints WHERE clan_id = ?').get(clanId) as { epoch: number; paths: string } | undefined;
    if (!r || !c || c.epoch !== r.epoch || (r.state !== 'frozen' && r.state !== 'relinquished') || !SHA.test(sha256)) return null;
    return (JSON.parse(c.paths) as Record<string, string>)[sha256] ?? null;
  }

  /**
   * Durably relinquishes the current epoch and signs the single transition to the acknowledged destination. After this
   * the device can only replay the same record (e.g. after a restart), never resume writing at the old epoch.
   */
  relinquish(clanId: string, host: HostSigner, delegation: HostDelegation, ack: HostAck): AuthorityRecord {
    const r = this.must(clanId);
    const done = this.db.prepare('SELECT record FROM hosting_transitions WHERE clan_id = ?').get(clanId) as { record: string } | undefined;
    if (done) {
      const t = JSON.parse(done.record) as AuthorityRecord;
      if (t.delegation?.id === delegation.id && t.ack?.sig === ack.sig) return t;
      throw new HostingError('already_relinquished', 'This device already handed hosting to another device.');
    }
    if (r.state !== 'frozen') throw new HostingError('bad_state', 'Pause hosting before handing it over.');
    const h = this.head(r);
    if (h.hostKey !== host.publicKey) throw new HostingError('forbidden', 'Only the current host can hand hosting over.');
    const at = this.now();
    const problem = delegationProblem(delegation, { clanId, ownerKey: r.owner_key, destKey: delegation.destKey, at, revoked: this.revoked(r) });
    if (problem) throw new HostingError('invalid_delegation', problem);
    const a = HostAck.safeParse(ack);
    if (!a.success || a.data.clanId !== clanId || a.data.epoch !== r.epoch || a.data.prevHash !== r.head_hash || a.data.delegationId !== delegation.id || a.data.destKey !== delegation.destKey) throw new HostingError('invalid_ack', 'Destination acknowledgment does not match this epoch.');
    const mine = this.checkpointOf(clanId);
    if (!mine || mine.header.epoch !== r.epoch || mine.hash !== a.data.checkpointHash) throw new HostingError('invalid_ack', 'The destination acknowledged a different checkpoint than this host prepared.');
    const t = signHostStatement(host, { type: 'clan-host-authority' as const, v: 1 as const, clanId, ownerKey: r.owner_key, epoch: r.epoch + 1, hostKey: delegation.destKey, prevHash: r.head_hash, checkpointHash: a.data.checkpointHash, delegation, ack: a.data, issuedAt: at });
    const chk = verifyAuthorityChain([...this.chain(r), t], { clanId, ownerKey: r.owner_key });
    if (!chk.ok) throw new HostingError('invalid', chk.reason);
    // Relinquishment and the signed record commit together, before anything is sent.
    tx(this.db, () => {
      this.db.prepare('INSERT INTO hosting_transitions (clan_id, epoch, record, created_at) VALUES (?, ?, ?, ?)').run(clanId, r.epoch, JSON.stringify(t), at);
      this.setState(clanId, 'relinquished');
    });
    return t;
  }
  pendingTransition(clanId: string) {
    const t = this.db.prepare('SELECT record FROM hosting_transitions WHERE clan_id = ?').get(clanId) as { record: string } | undefined;
    return t ? JSON.parse(t.record) as AuthorityRecord : null;
  }

  /**
   * Source side of the hand-over transport (served to authenticated linked devices only). Every call re-checks the
   * owner's delegation to the caller's key; blobs are served only to the device that was offered this checkpoint.
   */
  replicationSource(o: { localKey: string; signer: HostSigner }) {
    const offered = new Map<string, string>(); // clanId → destination key
    const Offer = z.object({ clanId: z.string().uuid(), delegation: HostDelegation }).strict();
    const Relinquish = Offer.extend({ ack: HostAck }).strict();
    const authorize = (callerKey: string, clanId: string, d: HostDelegation) => {
      const r = this.must(clanId);
      if (d.destKey !== callerKey) throw new HostingError('forbidden', 'The delegation names another device.');
      const problem = delegationProblem(d, { clanId, ownerKey: r.owner_key, destKey: callerKey, at: this.now(), revoked: this.revoked(r) });
      if (problem) throw new HostingError('invalid_delegation', problem);
      if (this.head(r).hostKey !== o.localKey) throw new HostingError('not_authoritative', 'This device is not the CLAN\'s host.');
      return r;
    };
    return {
      offer: (callerKey: string, raw: unknown) => {
        const b = Offer.parse(raw), r = authorize(callerKey, b.clanId, b.delegation);
        const t = this.pendingTransition(b.clanId);
        // Already handed to this caller (e.g. it crashed before activating): give it the transition again, nothing else.
        if (r.state === 'relinquished' && t?.hostKey === callerKey) return { chain: this.chain(r), transition: t };
        const c = this.checkpointOf(b.clanId);
        if (r.state !== 'frozen' || !c || c.header.epoch !== r.epoch) throw new HostingError('bad_state', 'The host has not prepared a hand-over yet.');
        const clan = this.clans.get(b.clanId)!;
        offered.set(b.clanId, callerKey);
        return { chain: this.chain(r), header: c.header, clan: { type: clan.type, name: clan.name, expiresAt: clan.expiresAt } };
      },
      blob: (callerKey: string, clanId: string, sha256: string) => offered.get(clanId) === callerKey ? this.checkpointBlob(clanId, sha256) : null,
      relinquish: (callerKey: string, raw: unknown) => {
        const b = Relinquish.parse(raw);
        authorize(callerKey, b.clanId, b.delegation);
        if (b.ack.destKey !== callerKey) throw new HostingError('forbidden', 'The acknowledgment is not the caller\'s.');
        const t = this.relinquish(b.clanId, o.signer, b.delegation, b.ack);
        offered.delete(b.clanId);
        return { chain: this.chain(this.must(b.clanId)), transition: t };
      },
    };
  }

  /**
   * Destination side of a hand-over pushed by the current host (a phone accepts no connections, so it pushes to its
   * linked computer). Callers are authenticated linked devices; the pusher must be the verified current host of an
   * owner-anchored chain, the delegation must name this device, and only that pusher may continue the staging.
   */
  replicationSink(o: { localKey: string; signer: HostSigner }) {
    const pushing = new Map<string, string>(); // clanId → pusher key
    const Begin = z.object({ chain: z.array(z.unknown()).min(1).max(1000), delegation: HostDelegation, header: z.unknown(),
      clan: z.object({ type: z.string(), name: z.string(), expiresAt: z.number().int().nullable() }).strict() }).strict();
    const Blob = z.object({ clanId: z.string().uuid(), sha256: z.string().regex(SHA), offset: z.number().int().nonnegative(), data: z.string().max(12_000_000).regex(/^[A-Za-z0-9_-]*$/) }).strict();
    const Clan = z.object({ clanId: z.string().uuid() }).strict();
    const pusher = (callerKey: string, clanId: string) => { if (pushing.get(clanId) !== callerKey) throw new HostingError('forbidden', 'Start the hand-over first.'); };
    return {
      begin: async (callerKey: string, raw: unknown) => {
        const b = Begin.parse(raw);
        const g = b.chain[0] as { clanId?: unknown; ownerKey?: unknown }, head = b.chain[b.chain.length - 1] as { hostKey?: unknown };
        if (typeof g.clanId !== 'string' || typeof g.ownerKey !== 'string' || head.hostKey !== callerKey) throw new HostingError('forbidden', 'Only the CLAN\'s current host can hand it over.');
        const clanId = g.clanId;
        tx(this.db, () => {
          this.clans.ensureKnown({ id: clanId, type: b.clan.type as never, name: b.clan.name, expiresAt: b.clan.expiresAt, createdBy: this.me() });
          const anchored = this.anchorOf(clanId);
          if (!anchored || anchored.source === 'pairing') this.anchorLinkedOwner(clanId, g.ownerKey as string);
        });
        this.beginStaging(b.chain, b.delegation, b.header, o.localKey);
        pushing.set(clanId, callerKey);
        const have = await Promise.all((await this.stagingPathList(clanId)).map(async (x) => ({ sha256: x.sha256, size: x.size,
          have: await stat(x.path).then((st) => (st.size === x.size ? x.size : 0), () => stat(`${x.path}.part`).then((st) => Math.min(st.size, x.size), () => 0)) })));
        return { missing: have.filter((x) => x.have < x.size) };
      },
      blob: async (callerKey: string, raw: unknown) => {
        const b = Blob.parse(raw);
        pusher(callerKey, b.clanId);
        const final = this.stagingPath(b.clanId, b.sha256), part = `${final}.part`;
        const size = checkpointBlobs(this.stagedHeader(b.clanId).header).find((x) => x.sha256 === b.sha256)!.size;
        const have = await stat(part).then((st) => st.size, () => 0);
        if (b.offset !== have) return { have }; // the pusher resumes from what is actually here
        const bytes = b64u.decode(b.data);
        if (have + bytes.length > size) throw new HostingError('invalid', 'More bytes than the checkpoint lists.');
        const fh = await open(part, 'a');
        try { await fh.write(bytes); } finally { await fh.close(); }
        if (have + bytes.length === size) await rename(part, final);
        return { have: have + bytes.length };
      },
      complete: async (callerKey: string, raw: unknown) => {
        const { clanId } = Clan.parse(raw);
        pusher(callerKey, clanId);
        await this.completeStaging(clanId);
        return { ack: this.acknowledge(clanId, o.signer) };
      },
      activate: async (_callerKey: string, raw: unknown) => {
        // Any linked device may deliver a verified chain: becoming host still requires this device's own verified staging.
        const b = z.object({ clanId: z.string().uuid(), chain: z.array(z.unknown()).min(1).max(1000) }).strict().parse(raw);
        const st = await this.accept(b.chain, o.localKey);
        if (st.hostKey === o.localKey) pushing.delete(b.clanId);
        return { epoch: st.epoch, writable: st.writable };
      },
      revoke: (_callerKey: string, raw: unknown) => { this.addRevocation(raw); return { ok: true }; },
    };
  }

  // ---- destination ----
  /**
   * Records the start of replication of `header` (untrusted until completeStaging verifies every blob). Only the
   * owner's own devices may become host. Resumable: the same header continues; a newer checkpoint of the same epoch
   * (the source resumed and paused again) replaces an unacknowledged one.
   */
  beginStaging(chain: unknown, delegation: HostDelegation, rawHeader: unknown, localKey: string) {
    const head = this.learn(chain, localKey);
    const r = this.must(head.clanId);
    if (r.state === 'conflict') throw new HostingError('conflict', r.conflict ?? 'Conflicting hosting records.');
    const source = this.anchorOf(r.clan_id)?.source;
    if (source !== 'owner' && source !== 'linked-device') throw new HostingError('forbidden', 'Hosting can only move between the owner\'s own devices.');
    const problem = delegationProblem(delegation, { clanId: r.clan_id, ownerKey: r.owner_key, destKey: localKey, at: this.now(), revoked: this.revoked(r) });
    if (problem) throw new HostingError('invalid_delegation', problem);
    const p = CheckpointHeader.safeParse(rawHeader);
    if (!p.success || p.data.clanId !== r.clan_id || p.data.epoch !== r.epoch || p.data.prevHash !== r.head_hash) throw new HostingError('invalid', 'The checkpoint does not belong to the current epoch.');
    const hash = checkpointHash(p.data);
    const ex = this.staged(r.clan_id, r.epoch);
    if (ex && ex.checkpoint_hash === hash && (JSON.parse(ex.delegation) as HostDelegation).id === delegation.id) return { clanId: r.clan_id, epoch: r.epoch, hash };
    if (this.busy.has(r.clan_id)) throw new HostingError('busy', 'Staging for this CLAN is being verified.');
    this.db.prepare(`INSERT INTO hosting_staging (clan_id, epoch, prev_hash, checkpoint_hash, delegation, state, updated_at, header) VALUES (?, ?, ?, ?, ?, 'staging', ?, ?)
      ON CONFLICT (clan_id, epoch) DO UPDATE SET checkpoint_hash = excluded.checkpoint_hash, delegation = excluded.delegation, state = 'staging', updated_at = excluded.updated_at, header = excluded.header`)
      .run(r.clan_id, r.epoch, r.head_hash, hash, JSON.stringify(delegation), this.now(), JSON.stringify(p.data));
    return { clanId: r.clan_id, epoch: r.epoch, hash };
  }
  private staged(clanId: string, epoch: number) { return this.db.prepare('SELECT * FROM hosting_staging WHERE clan_id = ? AND epoch = ?').get(clanId, epoch) as Staged | undefined; }
  private stagedHeader(clanId: string) {
    const r = this.must(clanId), s = this.staged(clanId, r.epoch);
    if (!s?.header) throw new HostingError('not_staged', 'Nothing is staged for this CLAN.');
    return { row: s, header: CheckpointHeader.parse(JSON.parse(s.header)) };
  }
  /** Where the transport stores blob `sha256` (resume from `${path}.part`). Only blobs of the staged header. */
  stagingPath(clanId: string, sha256: string) {
    const { header } = this.stagedHeader(clanId);
    if (!SHA.test(sha256) || !checkpointBlobs(header).some((b) => b.sha256 === sha256)) throw new HostingError('invalid', 'That blob is not part of the staged checkpoint.');
    return join(this.inDir(clanId), sha256);
  }
  /** Every blob of the staged checkpoint with its staging path. */
  async stagingPathList(clanId: string) {
    const { header } = this.stagedHeader(clanId);
    await mkdir(this.inDir(clanId), { recursive: true });
    return checkpointBlobs(header).map((b) => ({ ...b, path: join(this.inDir(clanId), b.sha256) }));
  }
  /** Blobs not yet completely received (by size; hashes are checked by completeStaging). */
  async missingBlobs(clanId: string) {
    const { header } = this.stagedHeader(clanId);
    await mkdir(this.inDir(clanId), { recursive: true });
    const out: { sha256: string; size: number }[] = [];
    for (const b of checkpointBlobs(header)) if (!(await stat(join(this.inDir(clanId), b.sha256)).then((x) => x.size === b.size, () => false))) out.push(b);
    return out;
  }

  /**
   * Verifies the complete staged checkpoint itself (never on the caller's word): every blob's size and SHA-256, every
   * section re-encoded to the same canonical bytes and row count, exactly the registered sections, every section valid
   * for this CLAN, and the referenced files equal to the header's file list. Corrupt blobs are deleted for re-download.
   */
  async completeStaging(clanId: string) {
    return this.exclusive(clanId, async () => {
      const { row, header } = this.stagedHeader(clanId);
      await this.verifyStaged(clanId, header);
      const n = this.db.prepare("UPDATE hosting_staging SET state = 'verified', updated_at = ? WHERE clan_id = ? AND epoch = ? AND checkpoint_hash = ?").run(this.now(), clanId, row.epoch, row.checkpoint_hash).changes;
      if (!n) throw new HostingError('not_staged', 'The staged checkpoint changed during verification.');
    });
  }
  private async verifyStaged(clanId: string, header: CheckpointHeader) {
    const names = Object.keys(header.sections).sort(), mine = [...this.providers.keys()].sort();
    if (names.join() !== mine.join()) throw new HostingError('incomplete', `Checkpoint sections differ (received ${names.join(', ') || 'none'}).`);
    for (const b of checkpointBlobs(header)) {
      const path = join(this.inDir(clanId), b.sha256);
      const got = await hashFile(path).catch(() => null);
      if (!got) throw new HostingError('incomplete', 'Part of the checkpoint has not been received.');
      if (got.sha256 !== b.sha256 || got.size !== b.size) { await rm(path, { force: true }); throw new HostingError('corrupt', 'A received checkpoint blob is corrupt; it will be downloaded again.'); }
    }
    const sections = new Map<string, unknown[]>();
    const need = new Map<string, number>();
    for (const [name, meta] of Object.entries(header.sections)) {
      const bytes = await readFile(join(this.inDir(clanId), meta.sha256));
      let rows: unknown;
      try { rows = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new HostingError('corrupt', `Checkpoint section ${name} is not valid JSON.`); }
      if (!Array.isArray(rows) || rows.length !== meta.rows || sha256Hex(sectionBytes(rows)) !== meta.sha256) throw new HostingError('corrupt', `Checkpoint section ${name} is not canonical.`);
      let files;
      try { files = this.providers.get(name)!.validate(clanId, rows); } catch (e) { throw new HostingError('invalid', `Checkpoint section ${name} was refused: ${(e as Error).message}`); }
      for (const f of files) {
        if (need.has(f.sha256) && need.get(f.sha256) !== f.size) throw new HostingError('invalid', 'A file is listed with two sizes.');
        need.set(f.sha256, f.size);
      }
      sections.set(name, rows);
    }
    const listed = new Map(header.files.map((f) => [f.sha256, f.size]));
    if (listed.size !== header.files.length || listed.size !== need.size || [...need].some(([sha, size]) => listed.get(sha) !== size)) throw new HostingError('incomplete', 'The checkpoint file list does not match its records.');
    return sections;
  }
  acknowledge(clanId: string, dest: HostSigner): HostAck {
    const r = this.must(clanId);
    const s = this.staged(clanId, r.epoch);
    if (!s || s.state !== 'verified' || s.prev_hash !== r.head_hash) throw new HostingError('not_staged', 'The checkpoint is not fully verified.');
    const d = HostDelegation.parse(JSON.parse(s.delegation));
    if (d.destKey !== dest.publicKey) throw new HostingError('forbidden', 'This device is not the delegated destination.');
    return HostAck.parse(signHostStatement(dest, { type: 'clan-host-ack' as const, v: 1 as const, clanId, epoch: r.epoch, prevHash: r.head_hash, checkpointHash: s.checkpoint_hash, delegationId: d.id, destKey: dest.publicKey }));
  }

  /**
   * Accepts a (longer) verified chain. The highest accepted epoch is persisted before returning. A different record at
   * an epoch we already know marks the CLAN conflicted (no last-write-wins). Becoming host requires our verified staging,
   * which is re-verified, materialized and imported in the same transaction that records the new epoch.
   */
  async accept(chain: unknown, localKey: string): Promise<HostStatus> {
    const peek = this.peek(chain, localKey);
    if (!peek) return this.status(this.learn(chain, localKey).clanId, localKey)!;
    return this.exclusive(peek.clanId, async () => {
      const { header } = this.stagedHeader(peek.clanId);
      if (checkpointHash(header) !== peek.checkpointHash) throw new HostingError('not_staged', 'This device has not verified the checkpoint for that transition.');
      const sections = await this.verifyStaged(peek.clanId, header);
      const blob = (sha: string) => { if (!SHA.test(sha)) throw new Error('bad blob'); return join(this.inDir(peek.clanId), sha); };
      for (const [name, rows] of sections) await this.providers.get(name)!.materialize?.(peek.clanId, rows, blob);
      const head = this.learn(chain, localKey, sections);
      void rm(this.inDir(peek.clanId), { recursive: true, force: true });
      return this.status(head.clanId, localKey)!;
    });
  }
  /** Would this chain make the local device host of a newer epoch? (No writes.) */
  private peek(chain: unknown, localKey: string) {
    const first = (Array.isArray(chain) ? chain[0] : null) as { clanId?: unknown } | null;
    const clanId = typeof first?.clanId === 'string' ? first.clanId : '';
    const r = this.row(clanId);
    const chk = verifyAuthorityChain(chain, { clanId, ownerKey: r?.owner_key ?? this.anchorOf(clanId)?.ownerKey ?? '' });
    if (!chk.ok || chk.head.hostKey !== localKey || chk.head.epoch === 0 || (r && chk.head.epoch <= r.epoch)) return null;
    return { clanId, checkpointHash: chk.head.checkpointHash! };
  }

  private learn(chain: unknown, localKey: string, sections?: Map<string, unknown[]>): AuthorityRecord {
    const first = (Array.isArray(chain) ? chain[0] : null) as { clanId?: unknown } | null;
    const clanId = typeof first?.clanId === 'string' ? first.clanId : '';
    if (!this.clans.get(clanId)) throw new HostingError('unknown_clan', 'Unknown CLAN.');
    const r = this.row(clanId);
    // Never trust the first chain offered: its owner must match an anchored, authenticated owner key.
    const anchored = this.anchorOf(clanId)?.ownerKey;
    if (!r && !anchored) throw new HostingError('unanchored', 'This CLAN\'s owner key is not yet trusted on this device.');
    const chk = verifyAuthorityChain(chain, { clanId, ownerKey: r?.owner_key ?? anchored });
    if (!chk.ok) throw new HostingError('invalid', chk.reason);
    const rs = chain as AuthorityRecord[], h = chk.head;
    let conflict: string | null = null;
    const fail = (msg: string) => { conflict = msg; throw new HostingError('conflict', msg); };
    try { return this.apply(clanId, r, rs, h, chk.hashes, localKey, fail, sections); } finally {
      // Recorded outside the rolled-back transaction: the CLAN stays unavailable for writes until resolved.
      if (conflict) this.setState(clanId, 'conflict', conflict);
    }
  }
  private apply(clanId: string, r: Row | undefined, rs: AuthorityRecord[], h: AuthorityRecord, hashes: string[], localKey: string, fail: (m: string) => never, sections?: Map<string, unknown[]>): AuthorityRecord {
    const chk = { hashes };
    const activate = () => {
      this.requireVerified(clanId, h);
      if (!sections) throw new HostingError('not_staged', 'The verified checkpoint must be imported when this device becomes host.');
      for (const [name, rows] of sections) this.providers.get(name)!.import(clanId, rows, { me: this.me() });
    };
    return tx(this.db, () => {
      if (!r) {
        if (h.hostKey === localKey) activate();
        this.db.prepare('INSERT INTO hosting_authority (clan_id, owner_key, epoch, head_hash, chain, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(clanId, h.ownerKey, h.epoch, chk.hashes[h.epoch]!, JSON.stringify(rs), h.hostKey === localKey ? 'active' : 'standby', this.now());
        if (h.hostKey === localKey) this.db.prepare('DELETE FROM hosting_staging WHERE clan_id = ?').run(clanId);
        return h;
      }
      const known = chk.hashes[Math.min(r.epoch, h.epoch)];
      const ours = r.epoch <= h.epoch ? r.head_hash : authorityHash(this.chain(r)[h.epoch]!);
      if (known !== ours) fail(`Conflicting hosting record at epoch ${Math.min(r.epoch, h.epoch)}.`);
      if (h.epoch < r.epoch) throw new HostingError('stale', 'An older hosting record was offered.');
      if (h.epoch === r.epoch) return h;
      if (r.state === 'relinquished') {
        const t = this.pendingTransition(clanId);
        if (!t || authorityHash(t) !== chk.hashes[r.epoch + 1]) fail('A transition this device did not sign was offered.');
      } else if (r.state === 'active' || r.state === 'frozen') {
        // A host that never relinquished cannot have been superseded; refuse rather than lose our own writes.
        fail('A newer hosting record exists although this device never handed over.');
      }
      if (r.state === 'conflict') throw new HostingError('conflict', r.conflict ?? 'Conflicting hosting records.');
      if (h.hostKey === localKey) activate();
      this.db.prepare('UPDATE hosting_authority SET epoch = ?, head_hash = ?, chain = ?, state = ?, conflict = NULL, updated_at = ? WHERE clan_id = ?')
        .run(h.epoch, chk.hashes[h.epoch]!, JSON.stringify(rs), h.hostKey === localKey ? 'active' : 'standby', this.now(), clanId);
      // Hosting again later: the earlier hand-over is history in the chain, and a new one may be signed.
      if (h.hostKey === localKey) for (const q of ['DELETE FROM hosting_staging WHERE clan_id = ?', 'DELETE FROM hosting_transitions WHERE clan_id = ?', 'DELETE FROM hosting_checkpoints WHERE clan_id = ?']) this.db.prepare(q).run(clanId);
      return h;
    });
  }
  private requireVerified(clanId: string, h: AuthorityRecord) {
    const s = this.db.prepare("SELECT 1 FROM hosting_staging WHERE clan_id = ? AND epoch = ? AND checkpoint_hash = ? AND prev_hash = ? AND state = 'verified'").get(clanId, h.epoch - 1, h.checkpointHash, h.prevHash);
    if (h.epoch === 0 || !s) throw new HostingError('not_staged', 'This device has not verified the checkpoint for that transition.');
  }
}
