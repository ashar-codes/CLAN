// Hosting authority: this device's durable view of who may host each CLAN (docs/PHASE_14_2_HOSTING_DESIGN.md).
// Verification lives in @classroom/protocol; this module persists the highest accepted epoch before anything is
// acknowledged and enforces the local state machine: active → frozen → relinquished (never back to writing at that
// epoch), and staging → verified → acknowledged → active on the destination. It never stores private keys: callers
// pass a signer backed by the OS keystore. It grants no session, membership or file rights by itself.
import {
  authorityHash, delegationProblem, hostAuthorized, HostAck, HostDelegation, HostRevocation, revokedDelegations, signHostStatement, verifyAuthorityChain,
  type AuthorityRecord, type HostSigner,
} from '@classroom/protocol';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
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
  `],
};

export type HostState = 'active' | 'frozen' | 'relinquished' | 'standby' | 'conflict';
export type HostStatus = { clanId: string; epoch: number; hostKey: string; ownerKey: string; state: HostState; writable: boolean; reason: string | null };
export class HostingError extends Error { readonly code: string; constructor(code: string, m: string) { super(m); this.code = code; } }

type Row = { clan_id: string; owner_key: string; epoch: number; head_hash: string; chain: string; state: HostState; conflict: string | null };
const DAY = 86_400_000;

export class HostAuthority {
  private db: Db; private clans: Clans; private now: () => number;
  constructor(db: Db, clans: Clans, now = () => Date.now()) { this.db = db; this.clans = clans; this.now = now; }

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
    this.db.prepare('INSERT INTO hosting_authority (clan_id, owner_key, epoch, head_hash, chain, state, updated_at) VALUES (?, ?, 0, ?, ?, ?, ?)')
      .run(clanId, owner.publicKey, chk.hashes[0]!, JSON.stringify([g]), 'active', this.now());
    return this.status(clanId, owner.publicKey)!;
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
  unfreeze(clanId: string) {
    const r = this.must(clanId);
    if (r.state !== 'frozen') throw new HostingError('bad_state', 'Only a paused host that has not handed over can resume.');
    this.setState(clanId, 'active');
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

  // ---- destination ----
  /** Records the start of replication. Interrupted staging never activates; re-calling is idempotent. */
  beginStaging(chain: unknown, delegation: HostDelegation, checkpointHash: string, localKey: string) {
    const head = this.learn(chain, localKey);
    const r = this.must(head.clanId);
    if (r.state === 'conflict') throw new HostingError('conflict', r.conflict ?? 'Conflicting hosting records.');
    const problem = delegationProblem(delegation, { clanId: r.clan_id, ownerKey: r.owner_key, destKey: localKey, at: this.now(), revoked: this.revoked(r) });
    if (problem) throw new HostingError('invalid_delegation', problem);
    if (!/^[A-Za-z0-9_-]{43}$/.test(checkpointHash)) throw new HostingError('invalid', 'Bad checkpoint hash.');
    const ex = this.db.prepare('SELECT checkpoint_hash h, delegation d FROM hosting_staging WHERE clan_id = ? AND epoch = ?').get(r.clan_id, r.epoch) as { h: string; d: string } | undefined;
    if (ex && (ex.h !== checkpointHash || (JSON.parse(ex.d) as HostDelegation).id !== delegation.id)) throw new HostingError('busy', 'Another handoff for this epoch is already staging.');
    if (!ex) this.db.prepare('INSERT INTO hosting_staging (clan_id, epoch, prev_hash, checkpoint_hash, delegation, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(r.clan_id, r.epoch, r.head_hash, checkpointHash, JSON.stringify(delegation), 'staging', this.now());
    return { clanId: r.clan_id, epoch: r.epoch };
  }
  /** Caller has verified every byte/record of the checkpoint and committed it durably. */
  completeStaging(clanId: string, epoch: number, checkpointHash: string) {
    const n = this.db.prepare("UPDATE hosting_staging SET state = 'verified', updated_at = ? WHERE clan_id = ? AND epoch = ? AND checkpoint_hash = ?").run(this.now(), clanId, epoch, checkpointHash).changes;
    if (!n) throw new HostingError('not_staged', 'No matching staged checkpoint.');
  }
  acknowledge(clanId: string, dest: HostSigner): HostAck {
    const r = this.must(clanId);
    const s = this.db.prepare('SELECT * FROM hosting_staging WHERE clan_id = ? AND epoch = ?').get(clanId, r.epoch) as { prev_hash: string; checkpoint_hash: string; delegation: string; state: string } | undefined;
    if (!s || s.state !== 'verified' || s.prev_hash !== r.head_hash) throw new HostingError('not_staged', 'The checkpoint is not fully verified.');
    const d = HostDelegation.parse(JSON.parse(s.delegation));
    if (d.destKey !== dest.publicKey) throw new HostingError('forbidden', 'This device is not the delegated destination.');
    return HostAck.parse(signHostStatement(dest, { type: 'clan-host-ack' as const, v: 1 as const, clanId, epoch: r.epoch, prevHash: r.head_hash, checkpointHash: s.checkpoint_hash, delegationId: d.id, destKey: dest.publicKey }));
  }

  /**
   * Accepts a (longer) verified chain. The highest accepted epoch is persisted before returning. A different record at
   * an epoch we already know marks the CLAN conflicted (no last-write-wins). Becoming host requires our verified staging.
   */
  accept(chain: unknown, localKey: string): HostStatus {
    const head = this.learn(chain, localKey);
    return this.status(head.clanId, localKey)!;
  }

  private learn(chain: unknown, localKey: string): AuthorityRecord {
    const first = (Array.isArray(chain) ? chain[0] : null) as { clanId?: unknown } | null;
    const clanId = typeof first?.clanId === 'string' ? first.clanId : '';
    if (!this.clans.get(clanId)) throw new HostingError('unknown_clan', 'Unknown CLAN.');
    const r = this.row(clanId);
    const chk = verifyAuthorityChain(chain, { clanId, ownerKey: r?.owner_key });
    if (!chk.ok) throw new HostingError('invalid', chk.reason);
    const rs = chain as AuthorityRecord[], h = chk.head;
    let conflict: string | null = null;
    const fail = (msg: string) => { conflict = msg; throw new HostingError('conflict', msg); };
    try { return this.apply(clanId, r, rs, h, chk.hashes, localKey, fail); } finally {
      // Recorded outside the rolled-back transaction: the CLAN stays unavailable for writes until resolved.
      if (conflict) this.setState(clanId, 'conflict', conflict);
    }
  }
  private apply(clanId: string, r: Row | undefined, rs: AuthorityRecord[], h: AuthorityRecord, hashes: string[], localKey: string, fail: (m: string) => never): AuthorityRecord {
    const chk = { hashes };
    return tx(this.db, () => {
      if (!r) {
        if (h.hostKey === localKey) this.requireVerified(clanId, h);
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
      if (h.hostKey === localKey) this.requireVerified(clanId, h);
      this.db.prepare('UPDATE hosting_authority SET epoch = ?, head_hash = ?, chain = ?, state = ?, conflict = NULL, updated_at = ? WHERE clan_id = ?')
        .run(h.epoch, chk.hashes[h.epoch]!, JSON.stringify(rs), h.hostKey === localKey ? 'active' : 'standby', this.now(), clanId);
      // Hosting again later: the earlier hand-over is history in the chain, and a new one may be signed.
      if (h.hostKey === localKey) { this.db.prepare('DELETE FROM hosting_staging WHERE clan_id = ?').run(clanId); this.db.prepare('DELETE FROM hosting_transitions WHERE clan_id = ?').run(clanId); }
      return h;
    });
  }
  private requireVerified(clanId: string, h: AuthorityRecord) {
    const s = this.db.prepare("SELECT 1 FROM hosting_staging WHERE clan_id = ? AND epoch = ? AND checkpoint_hash = ? AND prev_hash = ? AND state = 'verified'").get(clanId, h.epoch - 1, h.checkpointHash, h.prevHash);
    if (h.epoch === 0 || !s) throw new HostingError('not_staged', 'This device has not verified the checkpoint for that transition.');
  }
}
