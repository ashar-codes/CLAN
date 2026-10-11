// Hosting authority gates from docs/PHASE_14_2_HOSTING_DESIGN.md (authority/fencing layer only; replication is separate).
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { authorityHash, b64u, signHostStatement, verifyAuthorityChain, type AuthorityRecord, type HostDelegation } from '@classroom/protocol';
import { setup } from './helpers.ts';

const key = () => nodeSigner(newEd25519().privatePkcs8);
const cp = (s: string) => b64u.encode(new Uint8Array(32).fill(s.charCodeAt(0)));

/** Phone owner (hosts epoch 0) and a linked desktop that knows the CLAN as a member. */
function world(t0 = 1_000_000) {
  let t = t0; const now = () => t;
  const phone = setup({ now }), desk = setup({ now }), third = setup({ now });
  const ownerKey = key(), deskKey = key(), thirdKey = key();
  const clan = phone.app.clans.create({ type: 'STUDY_GROUP', name: 'Mobile group', createdBy: phone.app.me });
  for (const d of [desk, third]) d.app.clans.recordJoined({ id: clan.id, type: 'STUDY_GROUP', name: 'Mobile group', hostDeviceId: 'phone', hostName: 'Phone', me: d.app.me });
  phone.app.hosting.establish(clan.id, phone.app.me, ownerKey);
  const close = () => { for (const d of [phone, desk, third]) d.db.close(); };
  return { phone, desk, third, ownerKey, deskKey, thirdKey, clan, close, tick: (ms: number) => { t += ms; } };
}

/** Destination stages + verifies + acknowledges; source freezes and relinquishes. */
function handoff(w: ReturnType<typeof world>, to = w.desk, toKey = w.deskKey, d?: HostDelegation, checkpoint = cp('A')) {
  const delegation = d ?? w.phone.app.hosting.delegate(w.clan.id, w.ownerKey, toKey.publicKey, { id: randomUUID() });
  const chain = w.phone.app.hosting.chainOf(w.clan.id)!;
  const s = to.app.hosting.beginStaging(chain, delegation, checkpoint, toKey.publicKey);
  to.app.hosting.completeStaging(s.clanId, s.epoch, checkpoint);
  const ack = to.app.hosting.acknowledge(w.clan.id, toKey);
  w.phone.app.hosting.freeze(w.clan.id, w.ownerKey.publicKey);
  const record = w.phone.app.hosting.relinquish(w.clan.id, w.ownerKey, delegation, ack);
  return { delegation, ack, record, chain: [...chain, record] };
}

describe('persistent hosting authority', () => {
  it('only the owner establishes authority; genesis is writable by the owner device only', () => {
    const w = world();
    try {
      expect(w.phone.app.hosting.status(w.clan.id, w.ownerKey.publicKey)).toMatchObject({ epoch: 0, state: 'active', writable: true });
      expect(w.phone.app.hosting.status(w.clan.id, w.deskKey.publicKey)?.writable).toBe(false);
      expect(() => w.desk.app.hosting.establish(w.clan.id, w.desk.app.me, w.deskKey)).toThrow('owner');
      expect(() => w.phone.app.hosting.establish(w.clan.id, w.phone.app.me, w.ownerKey)).toThrow('already');
      expect(() => w.phone.app.hosting.delegate(w.clan.id, w.deskKey, w.deskKey.publicKey, { id: randomUUID() })).toThrow('owner key');
    } finally { w.close(); }
  });

  it('safe handoff: one writable host, old host fenced across restart and can only replay', () => {
    const w = world();
    try {
      const h = handoff(w);
      expect(w.phone.app.hosting.status(w.clan.id, w.ownerKey.publicKey)).toMatchObject({ state: 'relinquished', writable: false });
      expect(() => w.phone.app.hosting.unfreeze(w.clan.id)).toThrow();
      // restart of the old host: same database, still fenced, replay returns the same signed record
      const again = setup({ db: w.phone.db, storageDir: w.phone.storageDir, now: () => 1_000_000 }).app.hosting;
      expect(() => again.assertWritable(w.clan.id, w.ownerKey.publicKey)).toThrow();
      expect(again.relinquish(w.clan.id, w.ownerKey, h.delegation, h.ack)).toEqual(h.record);
      expect(w.desk.app.hosting.accept(h.chain, w.deskKey.publicKey)).toMatchObject({ epoch: 1, state: 'active', writable: true });
      expect(w.desk.app.hosting.assertWritable(w.clan.id, w.deskKey.publicKey)).toBe(1);
      expect(w.phone.app.hosting.accept(h.chain, w.ownerKey.publicKey)).toMatchObject({ epoch: 1, state: 'standby', writable: false });
      expect(w.desk.app.hosting.accept(h.chain, w.deskKey.publicKey).state).toBe('active'); // idempotent
    } finally { w.close(); }
  });

  it('rejects unauthorized, copied-key, wrong-CLAN, expired and revoked delegations', () => {
    const w = world();
    try {
      const chain = w.phone.app.hosting.chainOf(w.clan.id)!;
      const base = { type: 'clan-host-delegation' as const, v: 1 as const, id: randomUUID(), clanId: w.clan.id, ownerKey: w.ownerKey.publicKey, destKey: w.deskKey.publicKey, actions: ['host' as const], issuedAt: 1_000_000, expiresAt: 2_000_000 };
      const forged = signHostStatement(w.deskKey, base); // claims the owner's public key, signed by another key
      expect(() => w.desk.app.hosting.beginStaging(chain, forged, cp('A'), w.deskKey.publicKey)).toThrow('not signed by the CLAN owner');
      const other = w.phone.app.clans.create({ type: 'FRIENDS', name: 'Other', createdBy: w.phone.app.me });
      const wrong = signHostStatement(w.ownerKey, { ...base, clanId: other.id });
      expect(() => w.desk.app.hosting.beginStaging(chain, wrong, cp('A'), w.deskKey.publicKey)).toThrow('another CLAN');
      const elsewhere = w.phone.app.hosting.delegate(w.clan.id, w.ownerKey, w.thirdKey.publicKey, { id: randomUUID() });
      expect(() => w.desk.app.hosting.beginStaging(chain, elsewhere, cp('A'), w.deskKey.publicKey)).toThrow('another device');
      const short = w.phone.app.hosting.delegate(w.clan.id, w.ownerKey, w.deskKey.publicKey, { id: randomUUID(), ttlMs: 1000 });
      w.tick(5000);
      expect(() => w.desk.app.hosting.beginStaging(chain, short, cp('A'), w.deskKey.publicKey)).toThrow('expired');
      const revoked = w.phone.app.hosting.delegate(w.clan.id, w.ownerKey, w.deskKey.publicKey, { id: randomUUID() });
      w.desk.app.hosting.accept(chain, w.deskKey.publicKey);
      w.desk.app.hosting.addRevocation(w.phone.app.hosting.revoke(w.clan.id, w.ownerKey, revoked.id));
      expect(() => w.desk.app.hosting.beginStaging(chain, revoked, cp('A'), w.deskKey.publicKey)).toThrow('revoked');
      expect(() => w.desk.app.hosting.addRevocation(signHostStatement(w.deskKey, { type: 'clan-host-revocation' as const, v: 1 as const, clanId: w.clan.id, ownerKey: w.ownerKey.publicKey, delegationId: randomUUID(), revokedAt: 1 }))).toThrow('owner');
    } finally { w.close(); }
  });

  it('destination cannot activate without verified staging, including after a restart mid-staging', () => {
    const w = world();
    try {
      const d = w.phone.app.hosting.delegate(w.clan.id, w.ownerKey, w.deskKey.publicKey, { id: randomUUID() });
      const chain = w.phone.app.hosting.chainOf(w.clan.id)!;
      w.desk.app.hosting.beginStaging(chain, d, cp('A'), w.deskKey.publicKey);
      expect(() => w.desk.app.hosting.acknowledge(w.clan.id, w.deskKey)).toThrow('not fully verified');
      const restarted = setup({ db: w.desk.db, storageDir: w.desk.storageDir, now: () => 1_000_000 }).app.hosting;
      expect(restarted.beginStaging(chain, d, cp('A'), w.deskKey.publicKey)).toEqual({ clanId: w.clan.id, epoch: 0 }); // resumable
      expect(() => restarted.beginStaging(chain, d, cp('B'), w.deskKey.publicKey)).toThrow('already staging');
      expect(() => restarted.completeStaging(w.clan.id, 0, cp('B'))).toThrow('No matching');
      // a transition naming this device for an unverified checkpoint is refused
      const ack = signHostStatement(w.deskKey, { type: 'clan-host-ack' as const, v: 1 as const, clanId: w.clan.id, epoch: 0, prevHash: authorityHash(chain[0]!), checkpointHash: cp('A'), delegationId: d.id, destKey: w.deskKey.publicKey });
      w.phone.app.hosting.freeze(w.clan.id, w.ownerKey.publicKey);
      const rec = w.phone.app.hosting.relinquish(w.clan.id, w.ownerKey, d, ack);
      expect(() => restarted.accept([...chain, rec], w.deskKey.publicKey)).toThrow('not verified');
      expect(restarted.status(w.clan.id, w.deskKey.publicKey)).toMatchObject({ epoch: 0, writable: false });
      restarted.completeStaging(w.clan.id, 0, cp('A'));
      expect(restarted.accept([...chain, rec], w.deskKey.publicKey)).toMatchObject({ epoch: 1, writable: true });
    } finally { w.close(); }
  });

  it('refuses tampered records, stale chains, simultaneous handoffs and equal-epoch conflicts', () => {
    const w = world();
    try {
      const d2 = w.phone.app.hosting.delegate(w.clan.id, w.ownerKey, w.thirdKey.publicKey, { id: randomUUID() });
      const genesis = w.phone.app.hosting.chainOf(w.clan.id)!;
      const s3 = w.third.app.hosting.beginStaging(genesis, d2, cp('C'), w.thirdKey.publicKey);
      w.third.app.hosting.completeStaging(s3.clanId, s3.epoch, cp('C'));
      const ack3 = w.third.app.hosting.acknowledge(w.clan.id, w.thirdKey);
      const h = handoff(w);
      // second destination after relinquishment: refused
      expect(() => w.phone.app.hosting.relinquish(w.clan.id, w.ownerKey, d2, ack3)).toThrow('already handed');
      // tampered checkpoint / host fields break signatures
      const bad = [...genesis, { ...h.record, checkpointHash: cp('Z') }];
      expect(() => w.desk.app.hosting.accept(bad, w.deskKey.publicKey)).toThrow();
      expect(() => w.desk.app.hosting.accept([...genesis, { ...h.record, hostKey: w.thirdKey.publicKey }], w.deskKey.publicKey)).toThrow();
      // an equal-epoch fork signed by the same (compromised/copied) host key
      const { sig: _s, ...body } = h.record;
      const forkRec: AuthorityRecord = signHostStatement(w.ownerKey, { ...body, hostKey: w.thirdKey.publicKey, checkpointHash: cp('C'), delegation: d2, ack: ack3 });
      expect(verifyAuthorityChain([...genesis, forkRec], { clanId: w.clan.id }).ok).toBe(true);
      w.desk.app.hosting.accept(h.chain, w.deskKey.publicKey);
      expect(() => w.desk.app.hosting.accept([...genesis, forkRec], w.deskKey.publicKey)).toThrow('Conflicting');
      expect(w.desk.app.hosting.status(w.clan.id, w.deskKey.publicKey)).toMatchObject({ state: 'conflict', writable: false });
      // the owner device signed only one transition: the fork is a conflict there too
      expect(() => w.phone.app.hosting.accept([...genesis, forkRec], w.ownerKey.publicKey)).toThrow('did not sign');
      // stale: a device at epoch 1 offered epoch 0
      const fresh = world();
      try {
        const hf = handoff(fresh);
        fresh.third.app.hosting.accept(hf.chain, fresh.thirdKey.publicKey);
        expect(() => fresh.third.app.hosting.accept(hf.chain.slice(0, 1), fresh.thirdKey.publicKey)).toThrow('older');
      } finally { fresh.close(); }
    } finally { w.close(); }
  });

  it('a host that never relinquished treats a newer record as a conflict; revocation stops writes but allows return to owner', () => {
    const w = world();
    try {
      const h = handoff(w);
      w.desk.app.hosting.accept(h.chain, w.deskKey.publicKey);
      // the active desktop learns a revocation of its own delegation: writes stop, already-accepted history stays valid
      w.desk.app.hosting.addRevocation(w.phone.app.hosting.revoke(w.clan.id, w.ownerKey, h.delegation.id));
      expect(w.desk.app.hosting.status(w.clan.id, w.deskKey.publicKey)).toMatchObject({ epoch: 1, state: 'active', writable: false });
      expect(w.desk.app.hosting.accept(h.chain, w.deskKey.publicKey).epoch).toBe(1);
      // hand authority back to the owner device under a fresh owner delegation
      w.phone.app.hosting.addRevocation(w.phone.app.hosting.revoke(w.clan.id, w.ownerKey, h.delegation.id));
      w.phone.app.hosting.accept(h.chain, w.ownerKey.publicKey);
      const back = w.phone.app.hosting.delegate(w.clan.id, w.ownerKey, w.ownerKey.publicKey, { id: randomUUID() });
      const s = w.phone.app.hosting.beginStaging(h.chain, back, cp('R'), w.ownerKey.publicKey);
      w.phone.app.hosting.completeStaging(s.clanId, s.epoch, cp('R'));
      const ack = w.phone.app.hosting.acknowledge(w.clan.id, w.ownerKey);
      w.desk.app.hosting.freeze(w.clan.id, w.deskKey.publicKey);
      const rec = w.desk.app.hosting.relinquish(w.clan.id, w.deskKey, back, ack);
      expect(w.phone.app.hosting.accept([...h.chain, rec], w.ownerKey.publicKey)).toMatchObject({ epoch: 2, state: 'active', writable: true });
      // the third device was never told about epoch 1 by its host; it may learn the full chain later
      expect(w.third.app.hosting.accept([...h.chain, rec], w.thirdKey.publicKey)).toMatchObject({ epoch: 2, state: 'standby' });
      // an active host offered a successor it never signed → conflict, not takeover
      const v = world();
      try {
        const forged = signHostStatement(v.ownerKey, { type: 'clan-host-authority' as const, v: 1 as const, clanId: v.clan.id, ownerKey: v.ownerKey.publicKey, epoch: 0, hostKey: v.ownerKey.publicKey, prevHash: null, checkpointHash: null, delegation: null, ack: null, issuedAt: 5 });
        expect(() => v.desk.app.hosting.accept([forged], v.deskKey.publicKey)).not.toThrow(); // a different genesis is just unknown to desk
        expect(() => v.phone.app.hosting.accept([forged], v.ownerKey.publicKey)).toThrow('Conflicting');
        expect(v.phone.app.hosting.status(v.clan.id, v.ownerKey.publicKey)?.writable).toBe(false);
      } finally { v.close(); }
    } finally { w.close(); }
  });
});
