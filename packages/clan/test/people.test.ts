// People core: profiles/visibility, friendships, blocks, consent, private conversations (permanent and temporary),
// receipts, direct files and voice notes, call permission, replay/forgery/rate protection. Envelopes travel between two
// real device databases exactly as transports carry them (signed, verified on arrival).
import { describe, expect, it } from 'vitest';
import { copyFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { newEd25519, nodeSigner } from '@classroom/client/node';
import { signEnvelope, type PeerEnvelope } from '@classroom/protocol';
import { setup } from './helpers.ts';

function person(name: string, clock: { t: number }) {
  const d = setup({ now: () => clock.t });
  const signer = nodeSigner(newEd25519().privatePkcs8);
  d.app.people.setSigner(signer);
  d.app.people.updateProfile({ name });
  return { ...d, p: d.app.people, signer, key: signer.publicKey };
}
type P = ReturnType<typeof person>;
/** Deliver everything due from a to b (as the transport does: delivered on acceptance, refused = final). */
function flush(a: P, b: P) {
  const out: { kind: string; result: string }[] = [];
  for (const d of a.p.due(Number.MAX_SAFE_INTEGER)) {
    if (d.to !== b.key) continue;
    try { const r = b.p.receive(d.envelope, a.key); a.p.delivered(d.id); out.push({ kind: r.kind, result: 'ok' }); }
    catch (e) { a.p.deliveryFailed(d.id, (e as Error).message, true); out.push({ kind: d.envelope.body.kind, result: (e as { code?: string }).code ?? 'error' }); }
  }
  return out;
}
const meet = (a: P, b: P) => { b.p.setVisibility('everyone'); a.p.meet({ profile: b.p.profileFor(a.key).profile }); a.p.setVisibility('everyone'); b.p.meet({ profile: a.p.profileFor(b.key).profile }); };

describe('people: profiles, visibility and friends', () => {
  it('releases profiles per visibility and field settings; persists across restart', () => {
    const clock = { t: 1_000_000 }, a = person('Aisha', clock), b = person('Bilal', clock);
    a.p.updateProfile({ university: 'NUST', bio: 'Physics', fieldVisibility: { university: 'everyone', bio: 'friends' } });
    expect(a.p.profileFor(b.key).profile).toBeNull(); // Friends Only by default: strangers see nothing
    a.p.setVisibility('everyone', 60_000);
    const seen = a.p.profileFor(b.key).profile!.profile;
    expect(seen).toMatchObject({ name: 'Aisha', university: 'NUST' });
    expect(seen.bio).toBeUndefined();
    clock.t += 61_000; // Everyone Nearby is temporary
    expect(a.p.visibility()).toBe('friends');
    expect(a.p.profileFor(b.key).profile).toBeNull();
    a.p.setVisibility('invisible');
    const again = setup({ db: a.db, storageDir: a.storageDir, now: () => clock.t }).app.people;
    again.setSigner(a.signer);
    expect(again.myProfile()).toMatchObject({ name: 'Aisha', visibility: 'invisible', fields: { university: 'NUST', bio: 'Physics' } });
  });

  it('friend request, accept, remove; reject and cancel; mutual requests become friends; tied to keys not names', () => {
    const clock = { t: 1_000_000 }, a = person('Aisha', clock), b = person('Bilal', clock);
    meet(a, b);
    a.p.sendFriendRequest(b.key, 'Lab partner?');
    expect(flush(a, b)).toEqual([{ kind: 'friend.request', result: 'ok' }]);
    expect(b.p.contacts('requests')).toMatchObject([{ key: a.key, relation: 'incoming', note: 'Lab partner?' }]);
    b.p.acceptFriend(a.key); flush(b, a);
    expect(a.p.isFriend(b.key) && b.p.isFriend(a.key)).toBe(true);
    expect(a.p.conversations()).toMatchObject([{ peerKey: b.key, state: 'active', mode: 'permanent', friend: true }]);
    a.p.removeFriend(b.key); flush(a, b);
    expect(b.p.isFriend(a.key)).toBe(false);
    a.p.sendFriendRequest(b.key); flush(a, b); b.p.rejectFriend(a.key); flush(b, a);
    expect(a.p.contact(b.key)?.relation).toBe('none');
    a.p.sendFriendRequest(b.key); flush(a, b); a.p.cancelFriendRequest(b.key); flush(a, b);
    expect(b.p.contact(a.key)?.relation).toBe('none');
    // both ask at the same time: friends
    a.p.sendFriendRequest(b.key); b.p.sendFriendRequest(a.key); flush(a, b); flush(b, a);
    expect(a.p.isFriend(b.key) && b.p.isFriend(a.key)).toBe(true);
    // a renamed profile is the same person (identity = key)
    b.p.updateProfile({ name: 'Bilal K.' }); a.p.meet({ profile: b.p.profileFor(a.key).profile });
    expect(a.p.contacts('friends').map((c) => c.name)).toEqual(['Bilal K.']);
  });

  it('refuses forged, misdirected, replayed and blocked envelopes; rate-limits unsolicited requests', () => {
    const clock = { t: 1_800_000_000_000 }, a = person('Aisha', clock), b = person('Bilal', clock), mallory = person('Mallory', clock);
    meet(a, b);
    const forged = signEnvelope(mallory.signer, { id: randomUUID(), to: b.key, at: clock.t, body: { kind: 'friend.request' } });
    expect(() => b.p.receive({ ...forged, from: a.key }, a.key)).toThrow(/signed/); // claims to be Aisha
    expect(() => b.p.receive(forged, a.key)).toThrow(/signed/); // arrived on Aisha's connection
    expect(() => b.p.receive(signEnvelope(a.signer, { id: randomUUID(), to: mallory.key, at: clock.t, body: { kind: 'friend.request' } }), a.key)).toThrow(/not for this device/);
    const ok = signEnvelope(a.signer, { id: randomUUID(), to: b.key, at: clock.t, body: { kind: 'friend.request' } });
    b.p.receive(ok, a.key); b.p.rejectFriend(a.key);
    b.p.receive(ok, a.key); // replay: no effect
    expect(b.p.contact(a.key)?.relation).toBe('none');
    expect(() => b.p.receive(signEnvelope(a.signer, { id: randomUUID(), to: b.key, at: clock.t - 15 * 86_400_000, body: { kind: 'friend.request' } }), a.key)).toThrow(/old/);
    for (let i = 0; i < 5; i++) b.p.receive(signEnvelope(a.signer, { id: randomUUID(), to: b.key, at: clock.t, body: { kind: 'friend.request' } }), a.key);
    expect(() => b.p.receive(signEnvelope(a.signer, { id: randomUUID(), to: b.key, at: clock.t, body: { kind: 'friend.request' } }), a.key)).toThrow(/Too many/);
    b.p.block(a.key);
    expect(() => b.p.receive(signEnvelope(a.signer, { id: randomUUID(), to: b.key, at: clock.t, body: { kind: 'chat.invite', mode: 'permanent', ttlMs: null } }), a.key)).toThrow(/Not accepted/);
    expect(b.p.profileFor(a.key).profile).toBeNull();
    expect(b.p.reachableBy(a.key)).toBe(false);
    b.p.unblock(a.key);
    expect(b.p.contacts('blocked')).toEqual([]);
  });
});

describe('people: private conversations', () => {
  it('invite non-friends with mutual acceptance; text, delivery, read, unread counts, pagination; nothing before consent', () => {
    const clock = { t: 1_000_000 }, a = person('Aisha', clock), b = person('Bilal', clock);
    meet(a, b);
    const conv = a.p.inviteChat(b.key);
    expect(() => a.p.sendText(conv, 'hi?')).toThrow(/Waiting/);
    // a message forced in before acceptance is refused
    expect(() => b.p.receive(signEnvelope(a.signer, { id: randomUUID(), to: b.key, at: clock.t, body: { kind: 'msg.text', msgId: randomUUID(), text: 'spam' } }), a.key)).toThrow(/No active/);
    flush(a, b);
    expect(b.p.conversations()).toMatchObject([{ id: conv, state: 'invited_in', friend: false }]);
    b.p.acceptChat(conv); flush(b, a);
    for (let i = 0; i < 60; i++) { clock.t += 1000; a.p.sendText(conv, `m${i}`); }
    expect(a.p.page(conv).at(-1)).toMatchObject({ text: 'm59', state: 'queued', mine: true });
    flush(a, b);
    expect(a.p.page(conv).at(-1)?.state).toBe('delivered');
    expect(b.p.conversation(conv)?.unread).toBe(60);
    const last = b.p.page(conv, { limit: 20 });
    expect(last.map((m) => m.text)[0]).toBe('m40');
    expect(b.p.page(conv, { before: last[0]!.seq, limit: 20 }).map((m) => m.text)[0]).toBe('m20');
    b.p.markRead(conv); flush(b, a);
    expect(b.p.conversation(conv)?.unread).toBe(0);
    expect(a.p.page(conv).at(-1)?.state).toBe('read');
  });

  it('queued messages survive restart and deliver later; failed sends can be retried', () => {
    const clock = { t: 1_000_000 }, a = person('Aisha', clock), b = person('Bilal', clock);
    meet(a, b); a.p.sendFriendRequest(b.key); flush(a, b); b.p.acceptFriend(a.key); flush(b, a); flush(a, b); // + presence keys
    const conv = a.p.conversations()[0]!.id;
    const m = a.p.sendText(conv, 'while you were away');
    const d = a.p.due()[0]!;
    a.p.deliveryFailed(d.id, 'unreachable');
    expect(a.p.due(clock.t)).toEqual([]); // backoff
    const a2 = setup({ db: a.db, storageDir: a.storageDir, now: () => clock.t }).app.people; a2.setSigner(a.signer);
    a2.wake(b.key);
    expect(a2.due(clock.t).map((x) => x.envelope.body.kind)).toEqual(['msg.text']);
    const env = a2.due(clock.t)[0]!;
    b.p.receive(env.envelope, a.key); a2.delivered(env.id);
    expect(a2.message(m.id)?.state).toBe('delivered');
    expect(b.p.page(conv).map((x) => x.text)).toEqual(['while you were away']);
  });

  it('temporary chats: both sides agree the terms; messages expire on both after restart; clear and remove locally', async () => {
    const clock = { t: 1_000_000 }, a = person('Aisha', clock), b = person('Bilal', clock);
    meet(a, b);
    expect(() => a.p.inviteChat(b.key, 'temporary', 12345)).toThrow(/how long/);
    const conv = a.p.inviteChat(b.key, 'temporary', 3_600_000); flush(a, b);
    // a peer cannot silently change the retention terms when accepting
    expect(() => a.p.receive(signEnvelope(b.signer, { id: randomUUID(), to: a.key, at: clock.t, body: { kind: 'chat.accept', mode: 'permanent', ttlMs: null } }), b.key)).toThrow(/No matching/);
    b.p.acceptChat(conv); flush(b, a);
    a.p.sendText(conv, 'gone in an hour'); flush(a, b);
    expect(b.p.page(conv)[0]).toMatchObject({ text: 'gone in an hour', expiresAt: clock.t + 3_600_000 });
    clock.t += 3_600_001;
    const b2 = setup({ db: b.db, storageDir: b.storageDir, now: () => clock.t }).app.people; b2.setSigner(b.signer);
    expect(await b2.sweep()).toBe(1);
    expect(await a.p.sweep()).toBe(1);
    expect(b2.page(conv)).toEqual([]);
    a.p.sendText(conv, 'keep?'); flush(a, b);
    await b2.clearHistory(conv);
    expect(b2.page(conv)).toEqual([]);
    expect(a.p.page(conv)).toHaveLength(1); // their copy is theirs
    await b2.removeConversation(conv); flush(b, a);
    expect(b2.conversations()).toEqual([]);
    expect(a.p.conversation(conv)?.state).toBe('ended');
  });
});

describe('people: files, voice notes, calls', () => {
  it('files need explicit consent; only the conversation peer may fetch; SHA-256 verified; temporary files expire', async () => {
    const clock = { t: 1_000_000 }, a = person('Aisha', clock), b = person('Bilal', clock), c = person('Chen', clock);
    meet(a, b);
    const conv = a.p.inviteChat(b.key, 'temporary', 86_400_000); flush(a, b); b.p.acceptChat(conv); flush(b, a);
    const src = join(a.storageDir, 'notes.pdf'); writeFileSync(src, Buffer.alloc(300_000, 7));
    const t = await a.p.offerFile(conv, src, { name: 'notes.pdf', mime: 'application/pdf' });
    flush(a, b);
    expect(b.p.transfer(t.id)).toMatchObject({ state: 'offered', retention: 'temporary', direction: 'in' });
    expect(a.p.outgoingBytes(t.id, b.key)).toBeNull(); // not before consent
    b.p.acceptFile(t.id); flush(b, a);
    expect(a.p.outgoingBytes(t.id, c.key)).toBeNull(); // never to anyone else
    const bytes = a.p.outgoingBytes(t.id, b.key)!;
    const part = join(b.storageDir, 'recv.part');
    writeFileSync(part, Buffer.alloc(300_000, 8)); // corrupted in transit
    await expect(b.p.completeDownload(t.id, part)).rejects.toThrow(/did not match/);
    b.p.retryDownload(t.id);
    copyFileSync(bytes.path, part);
    expect(await b.p.completeDownload(t.id, part)).toMatchObject({ state: 'complete' });
    expect(b.p.filePath(t.id)).toBeTruthy();
    expect(a.p.transfer(t.id)?.state).not.toBe('complete');
    flush(b, a); // the receiver's signed receipt: verified on their side
    expect(a.p.transfer(t.id)?.state).toBe('complete');
    clock.t += 86_400_001;
    await b.p.sweep(); await a.p.sweep();
    expect(b.p.transfer(t.id)).toBeNull();
    expect(a.p.outgoingBytes(t.id, b.key)).toBeNull();
  });

  it('voice notes arrive pre-accepted in an active chat and are size/format limited; calls only for friends or active chats', async () => {
    const clock = { t: 1_000_000 }, a = person('Aisha', clock), b = person('Bilal', clock);
    meet(a, b);
    expect(() => a.p.callSignal(b.key, { kind: 'call.invite', callId: randomUUID(), sdp: 'v=0' })).toThrow(/call friends/);
    a.p.sendFriendRequest(b.key); flush(a, b); b.p.acceptFriend(a.key); flush(b, a); flush(a, b);
    const conv = a.p.conversations()[0]!.id;
    const ogg = join(a.storageDir, 'v.webm'); writeFileSync(ogg, Buffer.alloc(20_000, 1));
    const v = await a.p.offerFile(conv, ogg, { name: 'Voice message.webm', mime: 'audio/webm', voiceMs: 4200 });
    const r = flush(a, b);
    expect(r).toEqual([{ kind: 'file.offer', result: 'ok' }]);
    expect(b.p.transfer(v.id)).toMatchObject({ state: 'accepted', voiceMs: 4200 });
    expect(b.p.page(conv).at(-1)).toMatchObject({ kind: 'voice' });
    await expect(a.p.offerFile(conv, ogg, { name: 'x.exe', mime: 'application/x-msdownload', voiceMs: 10 })).rejects.toThrow(/Unsupported voice/);
    const sig = a.p.callSignal(b.key, { kind: 'call.invite', callId: randomUUID(), sdp: 'v=0' });
    expect(b.p.receive(sig, a.key)).toMatchObject({ kind: 'call.invite', live: sig });
    clock.t += 61_000;
    expect(() => b.p.receive(sig, a.key)).toThrow(/Expired/); // live signals are never replayed later
    a.p.logCall({ id: 'c1', peerKey: b.key, direction: 'out', connectedAt: clock.t });
    a.p.logCall({ id: 'c1', peerKey: b.key, direction: 'out', endedAt: clock.t + 65_000, outcome: 'hangup' });
    expect(a.p.page(conv).at(-1)).toMatchObject({ kind: 'call', text: 'Call · 1:05' });
  });

  it('friends and blocks follow the owner to linked devices through personal sync providers', () => {
    const clock = { t: 1_000_000 }, a = person('Aisha', clock), b = person('Bilal', clock), a2 = person('Aisha laptop', clock);
    meet(a, b); a.p.sendFriendRequest(b.key); flush(a, b); b.p.acceptFriend(a.key); flush(b, a);
    const prov = a.p.syncProviders()[0]!, other = a2.p.syncProviders()[0]!;
    for (const [id, payload] of prov.all('')) other.apply('', id, payload, { merge: false });
    expect(a2.p.contacts('friends')).toMatchObject([{ key: b.key, name: 'Bilal' }]);
  });
});

// the envelope type is exported for transports
export type { PeerEnvelope };

describe('people: presence', () => {
  it('only friends can recognise anonymous adverts; presence keys come only from friends; removal rotates the key', () => {
    const clock = { t: 1_000_000 }, a = person('Aisha', clock), b = person('Bilal', clock), c = person('Chen', clock);
    meet(a, b); a.p.sendFriendRequest(b.key); flush(a, b); b.p.acceptFriend(a.key); flush(b, a); flush(a, b); flush(b, a);
    const r = 'AbCdEfGhIjKlMnOp';
    expect(b.p.matchPresence(r, a.p.presenceTagFor(r))).toBe(a.key);
    expect(a.p.matchPresence(r, b.p.presenceTagFor(r))).toBe(b.key);
    expect(c.p.matchPresence(r, a.p.presenceTagFor(r))).toBeNull(); // a stranger sees random values
    expect(a.p.presenceTagFor('ZZZZZZZZZZZZZZZZ')).not.toBe(a.p.presenceTagFor(r)); // unlinkable across rotations
    meet(c, a);
    const forged = signEnvelope(c.signer, { id: randomUUID(), to: a.key, at: clock.t, body: { kind: 'presence.key', key: 'A'.repeat(43) } });
    expect(() => a.p.receive(forged, c.key)).toThrow(/friends/);
    a.p.removeFriend(b.key); flush(a, b);
    expect(b.p.matchPresence(r, a.p.presenceTagFor(r))).toBeNull();
    expect(a.p.matchPresence(r, b.p.presenceTagFor(r))).toBeNull();
  });
});
