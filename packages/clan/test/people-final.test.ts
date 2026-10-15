// Final phase: onboarding gate + Everyone Nearby default, device names, reply/edit/delete/react with authorship,
// ordering, tombstones, replay and restart; and internet-assisted wake-ups through a real relay (fake FCM/APNs).
import { describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { PushEvent, pushEventValid, signEnvelope, type PeerEnvelope } from '@classroom/protocol';
import { PushAgent } from '@clan/core';
import { pushRelay, type PushTarget } from '@classroom/server';
import { setup } from './helpers.ts';


function person(name: string | null, clock: { t: number }, base?: ReturnType<typeof setup>, signer = nodeSigner(newEd25519().privatePkcs8)) {
  const d = base ?? setup({ now: () => clock.t });
  d.app.people.setSigner(signer);
  if (name) d.app.people.adoptIdentity(name, `${name}'s phone`);
  return { ...d, p: d.app.people, signer, key: signer.publicKey };
}
type P = ReturnType<typeof person>;
function flush(a: P, b: P) {
  const out: string[] = [];
  for (const d of a.p.due(Number.MAX_SAFE_INTEGER)) {
    if (d.to !== b.key) continue;
    try { b.p.receive(d.envelope, a.key); a.p.delivered(d.id); out.push(`${d.envelope.body.kind}:ok`); }
    catch (e) { a.p.deliveryFailed(d.id, (e as Error).message, true); out.push(`${d.envelope.body.kind}:${(e as { code?: string }).code}`); }
  }
  return out;
}
function friends(clock: { t: number }) {
  const a = person('Aisha', clock), b = person('Bilal', clock);
  a.p.meet({ profile: b.p.profileFor(a.key).profile }); b.p.meet({ profile: a.p.profileFor(b.key).profile });
  a.p.sendFriendRequest(b.key); flush(a, b); b.p.acceptFriend(a.key); flush(b, a); flush(a, b); flush(b, a);
  const conv = a.p.conversations()[0]!.id;
  return { a, b, conv };
}

describe('profile onboarding and visibility', () => {
  it('advertises nothing before a real name; new people default to Everyone Nearby until they change it', () => {
    const clock = { t: 1_000_000 }, viewer = person('Viewer', clock), fresh = person(null, clock);
    expect(fresh.p.ready()).toBe(false);
    expect(fresh.p.visibility()).toBe('invisible');
    expect(fresh.p.profileFor(viewer.key).profile).toBeNull();
    expect(fresh.p.reachableBy(viewer.key)).toBe(false);
    expect(() => fresh.p.updateProfile({ name: 'CLAN user' })).toThrow();
    fresh.p.adoptIdentity('  Zoë Ñúñez  ', 'Zoë’s Pixel');
    expect(fresh.p.myProfile()).toMatchObject({ name: 'Zoë Ñúñez', deviceName: 'Zoë’s Pixel', ready: true });
    expect(fresh.p.visibility()).toBe('everyone');
    clock.t += 30 * 86_400_000; // no silent fallback to Friends Only
    expect(fresh.p.visibility()).toBe('everyone');
    expect(fresh.p.profileFor(viewer.key).profile!.profile.name).toBe('Zoë Ñúñez');
    fresh.p.setVisibility('everyone', 60_000); clock.t += 61_000;
    expect(fresh.p.visibility()).toBe('friends'); // only an explicit temporary choice expires
    fresh.p.setVisibility('invisible');
    expect(fresh.p.profileFor(viewer.key).profile).toBeNull();
  });
  it('keeps an existing saved preference and a name chosen in People; replaces only the placeholder', () => {
    const clock = { t: 1_000_000 }, d = setup({ now: () => clock.t });
    d.db.exec("INSERT INTO people_profile (one, name, visibility, updated_at) VALUES (1, 'CLAN user', 'friends', 1)"); // a pre-onboarding database
    const p = person(null, clock, d);
    expect(p.p.visibility()).toBe('invisible');
    p.p.adoptIdentity('Hamza', 'Hamza-PC');
    expect(p.p.myProfile()).toMatchObject({ name: 'Hamza', visibility: 'friends' }); // saved choice kept
    p.p.updateProfile({ name: 'Hamza A.' });
    p.p.adoptIdentity('Hamza Ali', 'Hamza-PC'); // onboarding renamed, but People has its own name: kept
    expect(p.p.myProfile().name).toBe('Hamza A.');
    p.p.adoptIdentity('Hamza Ali', 'Hamza-Laptop', 'Hamza A.'); // the People name was the previous onboarding name: follows
    expect(p.p.myProfile()).toMatchObject({ name: 'Hamza Ali', deviceName: 'Hamza-Laptop' });
  });
});

describe('messages: replies, edit, delete, reactions', () => {
  it('edits and deletes only by the author, in order, durably, without resurrection', async () => {
    const clock = { t: 5_000_000 }, { a, b, conv } = friends(clock);
    const m = a.p.sendText(conv, 'hello'); flush(a, b);
    const bconv = b.p.conversations()[0]!.id;
    const r = b.p.sendText(bconv, 'hi back', { replyTo: m.id }); flush(b, a);
    expect(a.p.message(r.id)!.replyTo).toMatchObject({ id: m.id, author: a.key, text: 'hello' });
    // edit propagates, marked edited, op pending until delivered
    clock.t += 1000; expect(a.p.editMessage(m.id, 'hello there').op).toBe('edit_pending');
    flush(a, b);
    expect(a.p.message(m.id)!.op).toBeNull();
    expect(b.p.message(m.id)).toMatchObject({ text: 'hello there', editedAt: expect.any(Number) });
    // the recipient cannot edit or delete-for-everyone someone else's message
    expect(() => b.p.editMessage(m.id, 'forged')).toThrow();
    await expect(b.p.deleteForEveryone(m.id)).rejects.toThrow();
    // a forged edit envelope from the other participant is refused
    const forged = signEnvelope(b.signer, { id: crypto.randomUUID(), to: a.key, at: clock.t, body: { kind: 'msg.edit', msgId: m.id, text: 'pwned' } });
    expect(() => a.p.receive(forged, b.key)).toThrow();
    expect(a.p.message(m.id)!.text).toBe('hello there');
    // reactions from either side
    b.p.react(m.id, '👍'); flush(b, a);
    expect(a.p.message(m.id)!.reactions[b.key]).toBe('👍');
    // an older edit arriving late does not overwrite a newer one
    clock.t += 1000; a.p.editMessage(m.id, 'v3');
    const [late] = a.p.due(Number.MAX_SAFE_INTEGER).map((d) => d.envelope);
    const older = signEnvelope(a.signer, { id: crypto.randomUUID(), to: b.key, at: clock.t - 5000, body: { kind: 'msg.edit', msgId: m.id, text: 'stale' } });
    b.p.receive(late!, a.key); b.p.receive(older, a.key);
    expect(b.p.message(m.id)!.text).toBe('v3');
    a.p.delivered(a.p.due(Number.MAX_SAFE_INTEGER)[0]!.id);
    // delete for everyone: tombstone on both; replaying the original message cannot bring it back
    await a.p.deleteForEveryone(m.id); flush(a, b);
    expect(b.p.message(m.id)).toMatchObject({ deleted: true, text: null });
    const replay = signEnvelope(a.signer, { id: crypto.randomUUID(), to: b.key, at: clock.t, body: { kind: 'msg.text', msgId: m.id, text: 'hello' } });
    b.p.receive(replay, a.key);
    expect(b.p.message(m.id)).toMatchObject({ deleted: true, text: null });
    // edits after deletion are ignored
    const after = signEnvelope(a.signer, { id: crypto.randomUUID(), to: b.key, at: clock.t + 10, body: { kind: 'msg.edit', msgId: m.id, text: 'zombie' } });
    b.p.receive(after, a.key);
    expect(b.p.message(m.id)!.text).toBeNull();
    expect(b.p.conversations()[0]!.lastText).not.toBe('zombie');
  });
  it('a deletion that arrives before its message wins; undelivered messages are withdrawn locally', async () => {
    const clock = { t: 9_000_000 }, { a, b, conv } = friends(clock);
    const m = a.p.sendText(conv, 'secret');
    const msgEnv = a.p.due(Number.MAX_SAFE_INTEGER).find((d) => d.envelope.body.kind === 'msg.text')!;
    a.p.sending(msgEnv.id); // in flight: deletion must be sent as its own envelope
    await a.p.deleteForEveryone(m.id);
    const envs = a.p.due(Number.MAX_SAFE_INTEGER).map((d) => d.envelope as PeerEnvelope);
    const del = envs.find((e) => e.body.kind === 'msg.delete')!;
    b.p.receive(del, a.key); // out of order
    b.p.receive(msgEnv.envelope, a.key);
    expect(b.p.message(m.id)).toMatchObject({ deleted: true, text: null });
    // never sent at all: removed from the outbox, nothing to tell them
    const n = a.p.sendText(conv, 'oops');
    await a.p.deleteForEveryone(n.id);
    expect(a.p.due(Number.MAX_SAFE_INTEGER).some((d) => (d.envelope.body as { msgId?: string }).msgId === n.id)).toBe(false);
  });
  it('delete for me hides only the local copy; edit window enforced; survives restart', async () => {
    const clock = { t: 20_000_000 }, { a, b, conv } = friends(clock);
    const m = a.p.sendText(conv, 'keep for Bilal'); flush(a, b);
    await a.p.deleteForMe(m.id);
    expect(a.p.page(conv).some((x) => x.id === m.id)).toBe(false);
    expect(b.p.message(m.id)!.text).toBe('keep for Bilal');
    const old = a.p.sendText(conv, 'old'); flush(a, b);
    clock.t += 2 * 3_600_000;
    expect(a.p.message(old.id)!.canEdit).toBe(false);
    expect(() => a.p.editMessage(old.id, 'too late')).toThrow();
    const reopened = setup({ db: a.db, storageDir: a.storageDir, now: () => clock.t }).app.people; reopened.setSigner(a.signer);
    expect(reopened.page(conv).some((x) => x.id === m.id)).toBe(false);
    expect(reopened.message(old.id)!.text).toBe('old');
  });
  it('an older device refusing the new kinds makes the change Failed, never silently "done"', () => {
    const clock = { t: 30_000_000 }, { a, b, conv } = friends(clock);
    const m = a.p.sendText(conv, 'x'); flush(a, b);
    a.p.editMessage(m.id, 'y');
    for (const d of a.p.due(Number.MAX_SAFE_INTEGER)) a.p.deliveryFailed(d.id, 'invalid', true); // as an old peer answers
    expect(a.p.message(m.id)!.op).toBe('op_failed');
    void b;
  });
});

describe('automatic downloads', () => {
  it('accepts only friends’ bounded media/documents; executables and strangers always ask', async () => {
    const clock = { t: 40_000_000 }, { a, b, conv } = friends(clock);
    const { writeFileSync } = await import('node:fs'), { join } = await import('node:path');
    const file = (n: string, size: number) => { const p = join(a.storageDir, n); writeFileSync(p, Buffer.alloc(size, 1)); return p; };
    b.p.autoDownload({ on: true, maxBytes: 2 * 1024 * 1024, kinds: ['image', 'document'] });
    const photo = await a.p.offerFile(conv, file('p.jpg', 1000), { name: 'p.jpg', mime: 'image/jpeg' });
    const big = await a.p.offerFile(conv, file('big.pdf', 3 * 1024 * 1024), { name: 'big.pdf', mime: 'application/pdf' });
    const apk = await a.p.offerFile(conv, file('game.apk', 1000), { name: 'game.apk', mime: 'image/jpeg' }); // lying mime
    const vid = await a.p.offerFile(conv, file('v.mp4', 1000), { name: 'v.mp4', mime: 'video/mp4' }); // kind not chosen
    flush(a, b);
    expect(b.p.transfer(photo.id)!.state).toBe('accepted');
    for (const t of [big, apk, vid]) expect(b.p.transfer(t.id)!.state).toBe('offered');
    b.p.autoDownload({ on: false, maxBytes: 2 * 1024 * 1024, kinds: ['image'] });
    const later = await a.p.offerFile(conv, file('q.png', 1000), { name: 'q.png', mime: 'image/png' }); flush(a, b);
    expect(b.p.transfer(later.id)!.state).toBe('offered');
  });
});

describe('internet-assisted wake-ups', () => {
  it('registers, grants per friend, wakes only while undelivered, verifies MAC, rate-limits and revokes on block', async () => {
    const clock = { t: Date.now() }, { a, b, conv } = friends(clock);
    const sent: { t: PushTarget; e: PushEvent }[] = [];
    const relay = pushRelay({ senders: { fcm: async (t, e) => { sent.push({ t, e }); return { ok: true }; } } });
    const srv = createServer(relay.listener); await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
    const agent = (x: P, devices: () => { platform: 'fcm'; token: string }[]) => new PushAgent(x.p, { fetch: (u, i) => fetch(u, i), sign: (bytes) => x.signer.sign(bytes), devices, nonce: () => randomBytes(16).toString('base64url'), now: () => clock.t });
    try {
      // Bilal's phone registers and grants Aisha a capability, delivered to her as a signed envelope
      b.p.pushRelay(url);
      const bAgent = agent(b, () => [{ platform: 'fcm', token: 'fcm-token-bilal-0123456789' }]);
      await bAgent.tick();
      expect(b.p.wakeGrants('shared')).toHaveLength(1);
      flush(b, a);
      const key = b.p.wakeKeys()[0]!;
      // Aisha sends while Bilal is unreachable → after the grace period, one wake-up (no content)
      const aAgent = agent(a, () => []);
      a.p.sendText(conv, 'are you on campus?');
      await aAgent.tick(); expect(sent).toHaveLength(0); // grace period: maybe the LAN delivers it
      clock.t += 6000; await aAgent.tick();
      expect(sent).toHaveLength(1);
      expect(JSON.stringify(sent[0])).not.toContain('campus');
      expect(pushEventValid(key.mac, sent[0]!.e, clock.t)).toBe(true);
      expect(pushEventValid(randomBytes(32).toString('base64url'), sent[0]!.e, clock.t)).toBe(false); // relay/provider cannot forge
      // delivered over the LAN before the grace period → no wake-up
      a.p.sendText(conv, 'second'); flush(a, b); clock.t += 6000; await aAgent.tick();
      expect(sent).toHaveLength(1);
      // calls ring immediately and expire within a minute
      expect(a.p.wakeForCall(b.key, crypto.randomUUID())).toBe(true); await aAgent.tick();
      expect(sent[1]!.e).toMatchObject({ k: 'call' });
      expect(sent[1]!.e.exp - clock.t).toBeLessThanOrEqual(60_000);
      // a wrong capability is refused; forged registration is refused
      const bad = await fetch(`${url}/v1/notify`, { method: 'POST', body: JSON.stringify({ op: 'notify', cap: randomBytes(32).toString('base64url'), event: sent[0]!.e }) });
      expect(bad.status).toBe(404);
      const forged = await fetch(`${url}/v1/register`, { method: 'POST', body: JSON.stringify({ op: 'register', device: b.key, platform: 'fcm', token: 'attacker-token-000000', ts: clock.t, nonce: 'aaaaaaaaaaaaaaaaaaaa', sig: 'A'.repeat(86) }) });
      expect(forged.status).toBe(403);
      // call rate limit per capability
      for (let i = 0; i < 8; i++) a.p.wakeForCall(b.key, crypto.randomUUID());
      await aAgent.tick();
      expect(sent.filter((s) => s.e.k === 'call').length).toBeLessThanOrEqual(6);
      // blocking revokes: relay forgets the capability, Aisha is told to stop
      b.p.block(a.key); await bAgent.tick();
      const after = await fetch(`${url}/v1/notify`, { method: 'POST', body: JSON.stringify({ op: 'notify', cap: (JSON.parse((a.db.prepare('SELECT push FROM people_contacts WHERE key = ?').get(b.key) as { push: string }).push) as { cap: string }).cap, event: sent[0]!.e }) });
      expect(after.status).toBe(404);
    } finally { srv.close(); relay.close(); }
  });
});
