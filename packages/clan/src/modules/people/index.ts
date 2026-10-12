// People: this device's profile and visibility, people it has met (by identity key, never by name or address),
// friendships and blocks, private one-to-one conversations (permanent or temporary), direct file and voice-note
// transfers, and the delivery queue. Every incoming envelope is verified (signature, recipient, replay, block, rate,
// consent) here; transports (desktop people server, phone client) only move signed envelopes and bytes. Calls are
// live signaling only (never stored beyond a call log line). No private key is stored: a keystore-backed signer is
// set at startup.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import {
  b64u, personDeviceStatement, presenceTag, safetyNumber, verifyStatement, CHAT_MODES, conversationId, envelopeValid, FILE_MAX, FieldVisibility, LIVE_KINDS, LIVE_MAX_AGE_MS, PeerEnvelope, PROFILE_FIELDS, ProfileView, profileValid, SignedProfile, signEnvelope, signProfile,
  TEMP_TTLS, Visibility, VOICE_MAX, VOICE_MIME, type FileMeta, type PeerBody, type PeerSigner, type ProfileField,
} from '@classroom/protocol';
import { tx, type Db, type ModuleSchema } from '../../core/db.ts';
import { defineEvent, type EventBus } from '../../core/events.ts';
import type { ResourceStore } from '../../core/resources.ts';
import type { SyncProvider } from '../../core/syncrows.ts';

export const schema: ModuleSchema = {
  module: 'people', prefix: 'people',
  migrations: [`
    CREATE TABLE people_profile (one INTEGER PRIMARY KEY CHECK (one = 1), name TEXT NOT NULL, avatar_object TEXT, fields TEXT NOT NULL DEFAULT '{}',
      field_visibility TEXT NOT NULL DEFAULT '{}', visibility TEXT NOT NULL DEFAULT 'friends' CHECK (visibility IN ('everyone','friends','invisible')),
      everyone_until INTEGER, updated_at INTEGER NOT NULL);
    -- People this device has met. Identity = key; name/profile are the last verified, signed profile they released to us.
    CREATE TABLE people_contacts (key TEXT PRIMARY KEY, profile TEXT, endpoints TEXT NOT NULL DEFAULT '[]', tls TEXT, verified INTEGER NOT NULL DEFAULT 0,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE people_relations (key TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'none' CHECK (state IN ('none','outgoing','incoming','friend')),
      blocked INTEGER NOT NULL DEFAULT 0, note TEXT, updated_at INTEGER NOT NULL);
    CREATE TABLE people_conversations (id TEXT PRIMARY KEY, peer_key TEXT NOT NULL UNIQUE, state TEXT NOT NULL CHECK (state IN ('invited_out','invited_in','active','declined','ended')),
      mode TEXT NOT NULL CHECK (mode IN ('permanent','temporary')), ttl_ms INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      read_seq INTEGER NOT NULL DEFAULT 0, peer_read_at INTEGER NOT NULL DEFAULT 0, next_seq INTEGER NOT NULL DEFAULT 1);
    CREATE TABLE people_messages (id TEXT PRIMARY KEY, conv_id TEXT NOT NULL REFERENCES people_conversations(id), seq INTEGER NOT NULL, author TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('text','file','voice','call','event')), text TEXT, transfer_id TEXT, created_at INTEGER NOT NULL, received_at INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('queued','delivered','failed','received')), expires_at INTEGER, UNIQUE (conv_id, seq));
    CREATE INDEX people_messages_conv ON people_messages(conv_id, seq);
    CREATE INDEX people_messages_expiry ON people_messages(expires_at) WHERE expires_at IS NOT NULL;
    CREATE TABLE people_outbox (id TEXT PRIMARY KEY, to_key TEXT NOT NULL, envelope TEXT NOT NULL, msg_id TEXT, created_at INTEGER NOT NULL, tries INTEGER NOT NULL DEFAULT 0,
      next_at INTEGER NOT NULL, last_error TEXT);
    CREATE INDEX people_outbox_due ON people_outbox(next_at);
    -- Envelope ids already accepted (replay protection); kept longer than the acceptance window.
    CREATE TABLE people_seen (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
    CREATE TABLE people_transfers (id TEXT PRIMARY KEY, conv_id TEXT NOT NULL REFERENCES people_conversations(id), msg_id TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL, retention TEXT NOT NULL CHECK (retention IN ('temporary','permanent')), voice_ms INTEGER,
      state TEXT NOT NULL CHECK (state IN ('offered','accepted','transferring','complete','declined','cancelled','failed','expired')), received INTEGER NOT NULL DEFAULT 0,
      object_id TEXT, ref_id TEXT, error TEXT, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE people_calls (id TEXT PRIMARY KEY, peer_key TEXT NOT NULL, direction TEXT NOT NULL CHECK (direction IN ('in','out')), started_at INTEGER NOT NULL,
      connected_at INTEGER, ended_at INTEGER, outcome TEXT);
  `, `
    -- Secret carried only by this device's profile QR: whoever scanned it may reach us even in Friends Only mode.
    ALTER TABLE people_profile ADD COLUMN invite TEXT;
  `, `
    -- Where the person's secure link listener was last reachable ("tcp:host:port"), for router-free and hotspot links.
    ALTER TABLE people_contacts ADD COLUMN link_addrs TEXT NOT NULL DEFAULT '[]';
  `, `
    -- Presence: our secret for friends to recognise our anonymous adverts, and each friend's.
    ALTER TABLE people_profile ADD COLUMN presence TEXT;
    ALTER TABLE people_contacts ADD COLUMN presence_key TEXT;
  `, `
    -- Other people's pictures, fetched only when their profile (as shown to us) has one; verified by SHA-256.
    CREATE TABLE people_avatar_cache (sha256 TEXT PRIMARY KEY, mime TEXT NOT NULL, data BLOB NOT NULL, used_at INTEGER NOT NULL);
  `, `
    -- This person's own devices (each self-signed for the account; synced between them) and other people's devices
    -- that a friend presented, waiting for an explicit yes.
    CREATE TABLE people_my_devices (key TEXT PRIMARY KEY, name TEXT NOT NULL, account TEXT NOT NULL, sig TEXT NOT NULL, at INTEGER NOT NULL);
    CREATE TABLE people_device_offers (from_key TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', at INTEGER NOT NULL, PRIMARY KEY (from_key, key));
    ALTER TABLE people_profile ADD COLUMN devices_shared TEXT;
  `, `
    ALTER TABLE people_profile ADD COLUMN nearby_alerts INTEGER NOT NULL DEFAULT 0;
    CREATE TABLE people_nearby_alerts (key TEXT PRIMARY KEY, at INTEGER NOT NULL);
  `],
};

export const PeopleChanged = defineEvent('PeopleChanged', 1, z.object({ what: z.enum(['profile', 'contacts', 'relations', 'conversations', 'messages', 'transfers', 'calls']), key: z.string().optional(), convId: z.string().optional() }));

// Published only after authenticated, authorized, durable receipt; retries produce no second alert.
export const PeopleAlert = defineEvent('PeopleAlert', 1, z.object({ id: z.uuid(), key: z.string(), kind: z.string(), convId: z.uuid().optional() }));

export class PeerError extends Error { readonly code: string; constructor(code: string, m: string) { super(m); this.code = code; } }
export type Relation = 'none' | 'outgoing' | 'incoming' | 'friend';
export type Contact = { key: string; name: string; profile: ProfileView | null; verified: boolean; endpoints: string[]; relation: Relation; blocked: boolean; note: string | null; lastSeen: number };
export type Conversation = { id: string; peerKey: string; peerName: string; state: 'invited_out' | 'invited_in' | 'active' | 'declined' | 'ended'; mode: 'permanent' | 'temporary'; ttlMs: number | null;
  unread: number; lastAt: number | null; lastText: string | null; friend: boolean };
export type Message = { id: string; convId: string; seq: number; author: string; mine: boolean; kind: 'text' | 'file' | 'voice' | 'call' | 'event'; text: string | null; createdAt: number;
  state: 'queued' | 'sending' | 'delivered' | 'failed' | 'received' | 'read'; expiresAt: number | null; transfer: Transfer | null };
export type Transfer = { id: string; direction: 'in' | 'out'; name: string; mime: string; size: number; sha256: string; retention: 'temporary' | 'permanent'; voiceMs: number | null;
  state: 'offered' | 'accepted' | 'transferring' | 'complete' | 'declined' | 'cancelled' | 'failed' | 'expired'; received: number; objectId: string | null; error: string | null; expiresAt: number | null };
export type ProfileInput = { name?: string; university?: string; department?: string; course?: string; interests?: string[]; bio?: string; fieldVisibility?: Partial<Record<ProfileField, 'everyone' | 'friends' | 'nobody'>> };

const REPLAY_WINDOW_MS = 14 * 86_400_000;
const NAME = z.string().trim().min(1).max(80);
const DEFAULT_VIS: Record<ProfileField, 'everyone' | 'friends' | 'nobody'> = { university: 'friends', department: 'friends', course: 'friends', interests: 'friends', bio: 'friends' };
/** Unsolicited (non-friend) contact limits: per sender and overall, per hour. */
const RATE = { perSender: 6, overall: 40, windowMs: 3_600_000 };
const PENDING_REQUESTS_MAX = 50;

type RelRow = { key: string; state: Relation; blocked: number; note: string | null };
type ConvRow = { id: string; peer_key: string; state: Conversation['state']; mode: 'permanent' | 'temporary'; ttl_ms: number | null; created_at: number; updated_at: number; read_seq: number; peer_read_at: number; next_seq: number };
type MsgRow = { id: string; conv_id: string; seq: number; author: string; kind: Message['kind']; text: string | null; transfer_id: string | null; created_at: number; received_at: number; state: 'queued' | 'delivered' | 'failed' | 'received'; expires_at: number | null };
type XferRow = { id: string; conv_id: string; msg_id: string; direction: 'in' | 'out'; name: string; mime: string; size: number; sha256: string; retention: 'temporary' | 'permanent'; voice_ms: number | null;
  state: Transfer['state']; received: number; object_id: string | null; ref_id: string | null; error: string | null; expires_at: number | null };

export class People {
  private db: Db; private bus: EventBus; private store: ResourceStore; private now: () => number; private me: () => string;
  private signer: PeerSigner | null = null;
  private activeSends = new Map<string, number>(); // transient; a restart always restores durable Pending
  private rate = new Map<string, number[]>();
  constructor(db: Db, bus: EventBus, store: ResourceStore, now = () => Date.now(), me: () => string = () => '') { this.db = db; this.bus = bus; this.store = store; this.now = now; this.me = me; }

  /** The device's keystore-held identity signer (desktop: `device-ed25519`; phone: its device key). */
  setSigner(s: PeerSigner) { this.signer = s; }
  private sgn() { if (!this.signer) throw new PeerError('unavailable', 'People features start once this device identity is ready.'); return this.signer; }
  myKey() { return this.sgn().publicKey; }
  private changed(what: z.infer<typeof PeopleChanged.schema>['what'], extra: { key?: string; convId?: string } = {}) { this.bus.publish(PeopleChanged, 'people', { what, ...extra }); }

  // ---------------- profile & visibility ----------------
  private profileRow(): { name: string; avatar_object: string | null; fields: string; field_visibility: string; visibility: Visibility; everyone_until: number | null; updated_at: number } {
    type R = ReturnType<People['profileRow']>;
    const get = () => this.db.prepare('SELECT * FROM people_profile').get() as R | undefined;
    const r = get();
    if (r) return r;
    this.db.prepare('INSERT INTO people_profile (one, name, updated_at) VALUES (1, ?, ?)').run('CLAN user', this.now());
    return get()!;
  }
  myProfile() {
    const r = this.profileRow();
    const fields = JSON.parse(r.fields) as Partial<Record<ProfileField, unknown>>, vis = { ...DEFAULT_VIS, ...JSON.parse(r.field_visibility) } as Record<ProfileField, 'everyone' | 'friends' | 'nobody'>;
    const avatar = r.avatar_object ? this.store.object(r.avatar_object) : null;
    return { name: r.name, fields, fieldVisibility: vis, visibility: this.visibility(), everyoneUntil: r.everyone_until, avatar: avatar ? { sha256: avatar.sha256, size: avatar.size, mime: avatar.mime as 'image/png' | 'image/jpeg', objectId: avatar.id } : null, updatedAt: r.updated_at };
  }
  updateProfile(input: ProfileInput) {
    const cur = this.myProfile();
    const f = { ...cur.fields } as Record<string, unknown>;
    const P = z.object({ name: NAME.optional(), university: z.string().trim().max(120).optional(), department: z.string().trim().max(120).optional(), course: z.string().trim().max(120).optional(),
      interests: z.array(z.string().trim().min(1).max(40)).max(12).optional(), bio: z.string().trim().max(500).optional(), fieldVisibility: z.partialRecord(z.enum(PROFILE_FIELDS), FieldVisibility).optional() }).strict().parse(input);
    for (const k of PROFILE_FIELDS) if (P[k] !== undefined) { if (P[k] === '' || (Array.isArray(P[k]) && !(P[k] as unknown[]).length)) delete f[k]; else f[k] = P[k]; }
    this.db.prepare('UPDATE people_profile SET name = ?, fields = ?, field_visibility = ?, updated_at = ? WHERE one = 1')
      .run(P.name ?? cur.name, JSON.stringify(f), JSON.stringify({ ...cur.fieldVisibility, ...(P.fieldVisibility ?? {}) }), this.now());
    this.changed('profile');
    return this.myProfile();
  }
  /** Avatar: PNG/JPEG up to 512 KiB, stored in the Resource Store (personal scope). */
  async setAvatar(path: string | null, mime?: string) {
    if (path === null) { this.db.prepare('UPDATE people_profile SET avatar_object = NULL, updated_at = ? WHERE one = 1').run(this.now()); this.changed('profile'); return null; }
    const m = z.enum(['image/png', 'image/jpeg']).parse(mime);
    const { object, release } = await this.store.put(path, m);
    try {
      if (object.size > 512 * 1024) throw new PeerError('too_large', 'Choose a picture under 512 KB.');
      this.store.ref(object.id, { module: 'people', entity: 'avatar', entityId: 'me', scope: { kind: 'personal', ownerId: this.me() }, createdBy: this.me() });
      this.db.prepare('UPDATE people_profile SET avatar_object = ?, updated_at = ? WHERE one = 1').run(object.id, this.now());
    } finally { release(); }
    this.changed('profile');
    return this.myProfile().avatar;
  }
  /** Our picture for `viewer`, only if the profile they may see includes it. */
  async avatarFor(viewer: string, invite?: string | null): Promise<{ mime: string; data: Uint8Array } | null> {
    const view = this.profileFor(viewer, invite).profile?.profile;
    const a = this.myProfile().avatar;
    if (!view?.avatar || !a) return null;
    const loc = this.store.object(a.objectId)?.location;
    if (!loc) return null;
    const { readFile } = await import('node:fs/promises');
    return { mime: a.mime, data: new Uint8Array(await readFile(loc)) };
  }
  /** People whose shown profile has a picture we have not cached yet (to fetch while connected). */
  wantedAvatar(key: string): string | null {
    const sha = this.contact(key)?.profile?.avatar?.sha256;
    if (!sha || this.isBlocked(key)) return null;
    return this.db.prepare('SELECT 1 FROM people_avatar_cache WHERE sha256 = ?').get(sha) ? null : sha;
  }
  /** Keep a fetched picture only if it is exactly the one their signed profile announced (PNG/JPEG, ≤ 512 KB). */
  storeAvatar(key: string, mime: string, data: Uint8Array) {
    const a = this.contact(key)?.profile?.avatar;
    if (!a || data.length > 512 * 1024 || data.length !== a.size || !['image/png', 'image/jpeg'].includes(mime)) throw new PeerError('invalid', 'Unexpected picture.');
    const png = data[0] === 0x89 && data[1] === 0x50, jpg = data[0] === 0xff && data[1] === 0xd8;
    if (!(png || jpg) || createHash('sha256').update(data).digest('hex') !== a.sha256) throw new PeerError('invalid', 'Picture does not match the profile.');
    this.db.prepare('INSERT OR REPLACE INTO people_avatar_cache (sha256, mime, data, used_at) VALUES (?, ?, ?, ?)').run(a.sha256, mime, data, this.now());
    // bounded cache: at most 300 pictures (≈ 150 MB worst case, far less in practice); least recently used go first
    this.db.prepare('DELETE FROM people_avatar_cache WHERE sha256 IN (SELECT sha256 FROM people_avatar_cache ORDER BY used_at DESC LIMIT -1 OFFSET 300)').run();
    this.changed('contacts', { key });
  }
  /** Cached picture for a contact (current profile only). */
  avatarOf(key: string): { mime: string; data: Uint8Array } | null {
    const sha = this.contact(key)?.profile?.avatar?.sha256; if (!sha || this.isBlocked(key)) return null;
    const r = this.db.prepare('SELECT mime, data FROM people_avatar_cache WHERE sha256 = ?').get(sha) as { mime: string; data: Uint8Array } | undefined;
    if (r) this.db.prepare('UPDATE people_avatar_cache SET used_at = ? WHERE sha256 = ?').run(this.now(), sha);
    return r ? { mime: r.mime, data: new Uint8Array(r.data) } : null;
  }
  avatarPath(objectId: string) { const p = this.myProfile().avatar; return p && p.objectId === objectId ? this.store.object(objectId)?.location ?? null : null; }
  /** Everyone Nearby is opt-in and temporary (default 1 h); it falls back to Friends Only when it expires. */
  setVisibility(v: Visibility, everyoneMs = 3_600_000) {
    const vis = Visibility.parse(v);
    const until = vis === 'everyone' ? this.now() + z.number().int().min(60_000).max(8 * 3_600_000).parse(everyoneMs) : null;
    this.db.prepare('UPDATE people_profile SET visibility = ?, everyone_until = ?, updated_at = ? WHERE one = 1').run(vis, until, this.now());
    this.changed('profile');
    return this.visibility();
  }
  visibility(at = this.now()): Visibility {
    const r = this.db.prepare('SELECT visibility, everyone_until FROM people_profile').get() as { visibility: Visibility; everyone_until: number | null } | undefined;
    if (!r) return 'friends';
    return r.visibility === 'everyone' && (r.everyone_until ?? 0) <= at ? 'friends' : r.visibility;
  }
  /** What `viewer` may see. Strangers see a profile only while this device is visible to Everyone Nearby. */
  profileFor(viewer: string | null, invite?: string | null): { profile: ReturnType<typeof signProfile> | null } {
    const rel = viewer ? this.rel(viewer) : null;
    if (rel?.blocked) return { profile: null };
    const friend = rel?.state === 'friend';
    const known = friend || (viewer ? this.hasConversation(viewer) || rel?.state === 'incoming' || rel?.state === 'outgoing' : false);
    const vis = this.visibility();
    if (!known && vis !== 'everyone' && !(invite && vis !== 'invisible' && invite === this.inviteToken())) return { profile: null };
    const p = this.myProfile(), view: Record<string, unknown> = { key: this.myKey(), name: p.name, avatar: p.avatar ? { sha256: p.avatar.sha256, size: p.avatar.size, mime: p.avatar.mime } : null, updatedAt: p.updatedAt };
    for (const k of PROFILE_FIELDS) { const v = p.fields[k]; const fv = p.fieldVisibility[k]; if (v !== undefined && (fv === 'everyone' || (fv === 'friends' && friend))) view[k] = v; }
    return { profile: signProfile(this.sgn(), ProfileView.parse(view)) };
  }
  /** Whether `viewer` may open a connection to this device at all (discovery mode, relationship, or our QR secret). */
  reachableBy(viewer: string, invite?: string | null) {
    const rel = this.rel(viewer);
    if (rel?.blocked) return false;
    if (rel?.state && rel.state !== 'none') return true;
    if (this.hasConversation(viewer)) return true;
    if (invite && this.visibility() !== 'invisible' && invite === this.inviteToken()) return true;
    return this.visibility() === 'everyone';
  }
  /** The secret in this device's profile QR (created once; `reset` makes old printed/shared codes stop working). */
  // ---------------- this person's other devices ----------------
  /** Record this device as one of the account's devices (self-signed); synced to the account's other devices. */
  announceDevice(account: string, name: string) {
    const key = this.myKey(), n = name.trim().slice(0, 80) || 'Device';
    const cur = this.db.prepare('SELECT name, account FROM people_my_devices WHERE key = ?').get(key) as { name: string; account: string } | undefined;
    if (cur?.name === n && cur.account === account) return;
    this.db.prepare('INSERT OR REPLACE INTO people_my_devices (key, name, account, sig, at) VALUES (?, ?, ?, ?, ?)').run(key, n, account, this.sgn().sign(personDeviceStatement(account, key)), this.now());
  }
  /** Tell friends about this account's other devices (when the set changed). */
  shareDeviceLinks() {
    const me = this.myKey(), mine = this.db.prepare('SELECT account FROM people_my_devices WHERE key = ?').get(me) as { account: string } | undefined;
    if (!mine) return 0;
    const devices = (this.db.prepare('SELECT key, name, sig FROM people_my_devices WHERE account = ? AND key <> ? ORDER BY key').all(mine.account, me) as { key: string; name: string; sig: string }[]).slice(0, 8);
    const hash = createHash('sha256').update(JSON.stringify([mine.account, devices])).digest('hex');
    if ((this.db.prepare('SELECT devices_shared FROM people_profile').get() as { devices_shared: string | null } | undefined)?.devices_shared === hash) return 0;
    this.profileRow();
    this.db.prepare('UPDATE people_profile SET devices_shared = ? WHERE one = 1').run(hash);
    if (!devices.length) return 0;
    const friends = this.contacts('friends');
    for (const f of friends) this.queue(f.key, { kind: 'device.links', account: mine.account, devices });
    return friends.length;
  }
  /** Devices friends presented as theirs, waiting for this person's decision. */
  deviceOffers() {
    return (this.db.prepare("SELECT from_key fromKey, key, name, at FROM people_device_offers WHERE state = 'pending' ORDER BY at DESC").all() as { fromKey: string; key: string; name: string; at: number }[])
      .filter((o) => this.isFriend(o.fromKey) && !this.isBlocked(o.key)).map((o) => ({ ...o, fromName: this.contact(o.fromKey)?.name ?? 'A friend', safety: safetyNumber(this.myKey(), o.key) }));
  }
  /** Yes: treat that device as the same friend (after comparing its safety number in person where possible). */
  acceptDeviceOffer(fromKey: string, key: string) {
    const o = this.db.prepare("SELECT * FROM people_device_offers WHERE from_key = ? AND key = ? AND state = 'pending'").get(fromKey, key);
    if (!o || !this.isFriend(fromKey)) throw new PeerError('not_found', 'That device is no longer offered.');
    tx(this.db, () => {
      this.touch(key);
      this.db.prepare("UPDATE people_device_offers SET state = 'accepted' WHERE from_key = ? AND key = ?").run(fromKey, key);
      this.setRel(key, 'friend');
      this.queue(key, { kind: 'friend.accept' });
      this.queue(key, { kind: 'presence.key', key: this.presenceKey() });
      this.ensureConversation(key, 'active', 'permanent', null);
    });
  }
  declineDeviceOffer(fromKey: string, key: string) { this.db.prepare("UPDATE people_device_offers SET state = 'declined' WHERE from_key = ? AND key = ?").run(fromKey, key); this.changed('relations', { key }); }
  /** Our presence secret (shared only with friends). Rotated when someone stops being a friend. */
  presenceKey(rotate = false) {
    const r = this.db.prepare('SELECT presence FROM people_profile').get() as { presence: string | null } | undefined;
    if (r?.presence && !rotate) return r.presence;
    this.profileRow();
    const k = b64u.encode(randomBytes(32));
    this.db.prepare('UPDATE people_profile SET presence = ? WHERE one = 1').run(k);
    if (rotate) for (const f of this.contacts('friends')) this.queue(f.key, { kind: 'presence.key', key: k });
    return k;
  }
  /** The tag to put next to random id `r` in our adverts. */
  presenceTagFor(r: string) { return presenceTag(this.presenceKey(), r); }
  /** Which friend (if any) an advert {r, t} belongs to. */
  matchPresence(r: string, t: string): string | null {
    if (!/^[A-Za-z0-9_-]{8,24}$/.test(r) || !/^[A-Za-z0-9_-]{16}$/.test(t)) return null;
    const rows = this.db.prepare("SELECT c.key, c.presence_key FROM people_contacts c JOIN people_relations r ON r.key = c.key WHERE r.state = 'friend' AND r.blocked = 0 AND c.presence_key IS NOT NULL").all() as { key: string; presence_key: string }[];
    return rows.find((x) => presenceTag(x.presence_key, r) === t)?.key ?? null;
  }
  inviteToken(reset = false) {
    const r = this.db.prepare('SELECT invite FROM people_profile').get() as { invite: string | null } | undefined;
    if (r?.invite && !reset) return r.invite;
    this.profileRow();
    const t = randomUUID().replace(/-/g, '');
    this.db.prepare('UPDATE people_profile SET invite = ? WHERE one = 1').run(t);
    return t;
  }

  // ---------------- contacts ----------------
  /** Records a verified, signed profile (its key is the identity). `endpoints`/`tls` are where to reach it. */
  meet(o: { profile: unknown; endpoints?: string[]; tls?: { certificate: string; spkiSha256: string }; verified?: boolean }) {
    const p = SignedProfile.safeParse(o.profile);
    if (!p.success || !profileValid(p.data)) throw new PeerError('invalid', 'That profile is not validly signed.');
    const key = p.data.profile.key;
    if (key === this.myKey()) throw new PeerError('invalid', 'That is this device.');
    const at = this.now(), endpoints = z.array(z.string().regex(/^[0-9.]{7,15}:\d{2,5}$/)).max(6).parse(o.endpoints ?? []);
    this.db.prepare(`INSERT INTO people_contacts (key, profile, endpoints, tls, verified, first_seen, last_seen) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (key) DO UPDATE SET profile = CASE WHEN excluded.profile IS NOT NULL THEN excluded.profile ELSE profile END,
        endpoints = CASE WHEN excluded.endpoints <> '[]' THEN excluded.endpoints ELSE endpoints END, tls = coalesce(excluded.tls, tls), verified = max(verified, excluded.verified), last_seen = excluded.last_seen`)
      .run(key, JSON.stringify(p.data), JSON.stringify(endpoints), o.tls ? JSON.stringify(o.tls) : null, o.verified ? 1 : 0, at, at);
    this.changed('contacts', { key });
    return this.contact(key)!;
  }
  /** A peer reached us (authenticated) without us having its profile yet: remember the key only. */
  private touch(key: string) {
    const at = this.now();
    this.db.prepare('INSERT INTO people_contacts (key, first_seen, last_seen) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET last_seen = excluded.last_seen').run(key, at, at);
  }
  /** Link listener addresses a peer told us over an authenticated session (or a scanned code). */
  linkAddrs(key: string): string[] { const r = this.db.prepare('SELECT link_addrs FROM people_contacts WHERE key = ?').get(key) as { link_addrs: string } | undefined; return r ? JSON.parse(r.link_addrs) as string[] : []; }
  setLinkAddrs(key: string, addrs: string[]) {
    const ok = z.array(z.string().max(80).regex(/^tcp:(\[[0-9a-fA-F:.%a-z0-9]+\]|[0-9.]{7,15}):\d{2,5}$/)).max(6).parse(addrs);
    this.touch(key);
    this.db.prepare('UPDATE people_contacts SET link_addrs = ? WHERE key = ?').run(JSON.stringify(ok), key);
  }
  markVerified(key: string) { this.db.prepare('UPDATE people_contacts SET verified = 1 WHERE key = ?').run(key); this.changed('contacts', { key }); }
  contact(key: string): Contact | null {
    const c = this.db.prepare('SELECT * FROM people_contacts WHERE key = ?').get(key) as { key: string; profile: string | null; endpoints: string; tls: string | null; verified: number; last_seen: number } | undefined;
    if (!c) return null;
    const prof = c.profile ? (JSON.parse(c.profile) as { profile: ProfileView }).profile : null, rel = this.rel(key);
    return { key, name: prof?.name ?? 'Unknown person', profile: prof, verified: !!c.verified, endpoints: JSON.parse(c.endpoints), relation: rel?.state ?? 'none', blocked: !!rel?.blocked, note: rel?.note ?? null, lastSeen: c.last_seen };
  }
  route(key: string) {
    const c = this.db.prepare('SELECT endpoints, tls FROM people_contacts WHERE key = ?').get(key) as { endpoints: string; tls: string | null } | undefined;
    return c ? { endpoints: JSON.parse(c.endpoints) as string[], tls: c.tls ? JSON.parse(c.tls) as { certificate: string; spkiSha256: string } : null } : null;
  }
  contacts(filter: 'friends' | 'requests' | 'blocked' | 'all' = 'all'): Contact[] {
    const keys = (this.db.prepare('SELECT key FROM people_contacts ORDER BY last_seen DESC').all() as { key: string }[]).map((r) => this.contact(r.key)!);
    return keys.filter((c) => filter === 'all' ? !c.blocked : filter === 'friends' ? c.relation === 'friend' && !c.blocked : filter === 'blocked' ? c.blocked : !c.blocked && (c.relation === 'incoming' || c.relation === 'outgoing'));
  }

  // ---------------- relationships ----------------
  private rel(key: string) { return this.db.prepare('SELECT * FROM people_relations WHERE key = ?').get(key) as RelRow | undefined; }
  private setRel(key: string, state: Relation, note: string | null = null) {
    this.db.prepare(`INSERT INTO people_relations (key, state, note, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET state = excluded.state, note = excluded.note, updated_at = excluded.updated_at`).run(key, state, note, this.now());
    this.changed('relations', { key });
  }
  isFriend(key: string) { const r = this.rel(key); return r?.state === 'friend' && !r.blocked; }
  isBlocked(key: string) { return !!this.rel(key)?.blocked; }
  sendFriendRequest(key: string, note?: string) {
    this.assertPeer(key);
    const r = this.rel(key);
    if (r?.state === 'friend') throw new PeerError('exists', 'You are already friends.');
    if (r?.state === 'incoming') return this.acceptFriend(key); // they asked first
    if ((this.db.prepare("SELECT count(*) n FROM people_relations WHERE state = 'outgoing'").get() as { n: number }).n >= PENDING_REQUESTS_MAX) throw new PeerError('too_many', 'Too many pending requests; cancel some first.');
    tx(this.db, () => { this.setRel(key, 'outgoing', note ?? null); this.queue(key, { kind: 'friend.request', ...(note ? { note } : {}) }); });
  }
  acceptFriend(key: string) {
    if (this.rel(key)?.state !== 'incoming') throw new PeerError('not_found', 'There is no request from this person.');
    tx(this.db, () => { this.setRel(key, 'friend'); this.queue(key, { kind: 'friend.accept' }); this.queue(key, { kind: 'presence.key', key: this.presenceKey() }); this.ensureConversation(key, 'active', 'permanent', null); });
  }
  rejectFriend(key: string) {
    if (this.rel(key)?.state !== 'incoming') throw new PeerError('not_found', 'There is no request from this person.');
    tx(this.db, () => { this.setRel(key, 'none'); this.queue(key, { kind: 'friend.reject' }); });
  }
  cancelFriendRequest(key: string) {
    if (this.rel(key)?.state !== 'outgoing') throw new PeerError('not_found', 'There is no pending request to cancel.');
    tx(this.db, () => { this.setRel(key, 'none'); this.dropQueued(key, 'friend.request'); this.queue(key, { kind: 'friend.cancel' }); });
  }
  removeFriend(key: string) {
    if (this.rel(key)?.state !== 'friend') throw new PeerError('not_found', 'This person is not a friend.');
    tx(this.db, () => { this.setRel(key, 'none'); this.queue(key, { kind: 'friend.remove' }); this.forgetPresence(key); });
  }
  /** They are no longer a friend: stop recognising them and make our future adverts unrecognisable to them. */
  private forgetPresence(key: string) {
    this.db.prepare('UPDATE people_contacts SET presence_key = NULL WHERE key = ?').run(key);
    this.presenceKey(true);
  }
  /** Blocking is local and silent: nothing from them is accepted, nothing is sent to them, pending requests end. */
  block(key: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || key === this.myKey()) throw new PeerError('invalid', 'Unknown person.');
    this.touch(key);
    const wasFriend = this.rel(key)?.state === 'friend';
    tx(this.db, () => {
      this.db.prepare(`INSERT INTO people_relations (key, state, blocked, updated_at) VALUES (?, 'none', 1, ?) ON CONFLICT (key) DO UPDATE SET state = 'none', blocked = 1, updated_at = excluded.updated_at`).run(key, this.now());
      this.db.prepare('DELETE FROM people_outbox WHERE to_key = ?').run(key);
      if (wasFriend) this.forgetPresence(key);
      this.db.prepare("UPDATE people_conversations SET state = 'ended', updated_at = ? WHERE peer_key = ? AND state <> 'ended'").run(this.now(), key);
    });
    this.changed('relations', { key });
  }
  unblock(key: string) { this.db.prepare('UPDATE people_relations SET blocked = 0, updated_at = ? WHERE key = ?').run(this.now(), key); this.changed('relations', { key }); }

  // ---------------- conversations ----------------
  private conv(id: string) { return this.db.prepare('SELECT * FROM people_conversations WHERE id = ?').get(id) as ConvRow | undefined; }
  private convWith(key: string) { return this.db.prepare('SELECT * FROM people_conversations WHERE peer_key = ?').get(key) as ConvRow | undefined; }
  private hasConversation(key: string) { const c = this.convWith(key); return !!c && (c.state === 'active' || c.state === 'invited_out'); }
  private ensureConversation(key: string, state: ConvRow['state'], mode: 'permanent' | 'temporary', ttl: number | null) {
    const id = conversationId(this.myKey(), key), at = this.now();
    this.db.prepare(`INSERT INTO people_conversations (id, peer_key, state, mode, ttl_ms, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET state = excluded.state, mode = excluded.mode, ttl_ms = excluded.ttl_ms, updated_at = excluded.updated_at`).run(id, key, state, mode, ttl, at, at);
    this.changed('conversations', { convId: id, key });
    return id;
  }
  /** Invite anyone you can reach (no friendship needed); messages flow only after they accept the same terms. */
  inviteChat(key: string, mode: 'permanent' | 'temporary' = 'permanent', ttlMs: number | null = null) {
    this.assertPeer(key);
    z.enum(CHAT_MODES).parse(mode);
    if (mode === 'temporary' && !(TEMP_TTLS as readonly number[]).includes(ttlMs ?? -1)) throw new PeerError('invalid', 'Choose how long temporary messages last.');
    const ttl = mode === 'temporary' ? ttlMs : null;
    const c = this.convWith(key);
    // Friends already share a permanent conversation; switching to temporary terms needs their acceptance too.
    return tx(this.db, () => { const id = this.ensureConversation(key, c?.state === 'active' && c.mode === mode && c.ttl_ms === ttl ? 'active' : 'invited_out', mode, ttl); this.queue(key, { kind: 'chat.invite', mode, ttlMs: ttl }); return id; });
  }
  acceptChat(convId: string) {
    const c = this.conv(convId);
    if (!c || c.state !== 'invited_in') throw new PeerError('not_found', 'There is no invitation to accept.');
    tx(this.db, () => { this.db.prepare("UPDATE people_conversations SET state = 'active', updated_at = ? WHERE id = ?").run(this.now(), convId); this.queue(c.peer_key, { kind: 'chat.accept', mode: c.mode, ttlMs: c.ttl_ms }); });
    this.changed('conversations', { convId });
  }
  declineChat(convId: string) {
    const c = this.conv(convId);
    if (!c || c.state !== 'invited_in') throw new PeerError('not_found', 'There is no invitation to decline.');
    tx(this.db, () => { this.db.prepare("UPDATE people_conversations SET state = 'declined', updated_at = ? WHERE id = ?").run(this.now(), convId); this.queue(c.peer_key, { kind: 'chat.decline' }); });
    this.changed('conversations', { convId });
  }
  /** Ends the conversation for both (they are told); local history stays until cleared. */
  endChat(convId: string) {
    const c = this.must(convId);
    tx(this.db, () => { this.db.prepare("UPDATE people_conversations SET state = 'ended', updated_at = ? WHERE id = ?").run(this.now(), convId); this.queue(c.peer_key, { kind: 'chat.end' }); });
    this.changed('conversations', { convId });
  }
  private must(convId: string) { const c = this.conv(convId); if (!c) throw new PeerError('not_found', 'No such conversation.'); return c; }
  conversations(): Conversation[] {
    const rows = this.db.prepare('SELECT * FROM people_conversations ORDER BY updated_at DESC').all() as ConvRow[];
    return rows.filter((c) => !this.isBlocked(c.peer_key)).map((c) => {
      const last = this.db.prepare('SELECT text, kind, created_at FROM people_messages WHERE conv_id = ? ORDER BY seq DESC LIMIT 1').get(c.id) as { text: string | null; kind: string; created_at: number } | undefined;
      const unread = (this.db.prepare("SELECT count(*) n FROM people_messages WHERE conv_id = ? AND seq > ? AND author <> ? AND kind <> 'event'").get(c.id, c.read_seq, this.myKey()) as { n: number }).n;
      return { id: c.id, peerKey: c.peer_key, peerName: this.contact(c.peer_key)?.name ?? 'Unknown person', state: c.state, mode: c.mode, ttlMs: c.ttl_ms, unread, lastAt: last?.created_at ?? null,
        lastText: last ? (last.kind === 'text' ? last.text : last.kind === 'voice' ? 'Voice message' : last.kind === 'file' ? 'File' : last.text) : null, friend: this.isFriend(c.peer_key) };
    });
  }
  conversation(convId: string) { return this.conversations().find((c) => c.id === convId) ?? null; }
  canMessage(c: ConvRow) { return c.state === 'active' && !this.isBlocked(c.peer_key); }

  // ---------------- messages ----------------
  private addMessage(convId: string, o: { id: string; author: string; kind: Message['kind']; text?: string | null; transferId?: string | null; createdAt: number; state: MsgRow['state']; expiresAt: number | null }) {
    const c = this.must(convId);
    if (this.db.prepare('SELECT 1 FROM people_messages WHERE id = ?').get(o.id)) return false;
    this.db.prepare('INSERT INTO people_messages (id, conv_id, seq, author, kind, text, transfer_id, created_at, received_at, state, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(o.id, convId, c.next_seq, o.author, o.kind, o.text ?? null, o.transferId ?? null, o.createdAt, this.now(), o.state, o.expiresAt);
    this.db.prepare('UPDATE people_conversations SET next_seq = next_seq + 1, updated_at = ? WHERE id = ?').run(this.now(), convId);
    return true;
  }
  private expiry(c: ConvRow, at: number) { return c.mode === 'temporary' && c.ttl_ms ? at + c.ttl_ms : null; }
  sendText(convId: string, text: string) {
    const c = this.must(convId);
    if (!this.canMessage(c)) throw new PeerError('not_allowed', c.state === 'invited_out' ? 'Waiting for them to accept the chat.' : 'This conversation is not active.');
    const t = z.string().trim().min(1).max(8000).parse(text), id = randomUUID(), at = this.now();
    tx(this.db, () => { this.addMessage(convId, { id, author: this.myKey(), kind: 'text', text: t, createdAt: at, state: 'queued', expiresAt: this.expiry(c, at) }); this.queue(c.peer_key, { kind: 'msg.text', msgId: id, text: t }, id); });
    this.changed('messages', { convId });
    return this.message(id)!;
  }
  private toMessage(m: MsgRow, c: ConvRow): Message {
    const mine = m.author === this.myKey();
    return { id: m.id, convId: m.conv_id, seq: m.seq, author: m.author, mine, kind: m.kind, text: m.text, createdAt: m.created_at, expiresAt: m.expires_at,
      state: mine && m.state === 'queued' && (this.activeSends.get(m.id) ?? 0) > this.now() ? 'sending' : mine && m.state === 'delivered' && c.peer_read_at >= m.created_at ? 'read' : m.state, transfer: m.transfer_id ? this.transfer(m.transfer_id) : null };
  }
  message(id: string) { const m = this.db.prepare('SELECT * FROM people_messages WHERE id = ?').get(id) as MsgRow | undefined; return m ? this.toMessage(m, this.conv(m.conv_id)!) : null; }
  /** Newest-last page; `before` = a seq to page backwards (reading position stays on the client). */
  page(convId: string, o: { before?: number; limit?: number } = {}): Message[] {
    const c = this.must(convId), lim = Math.min(Math.max(o.limit ?? 50, 1), 200);
    const rows = this.db.prepare(`SELECT * FROM people_messages WHERE conv_id = ? ${o.before ? 'AND seq < ?' : ''} ORDER BY seq DESC LIMIT ?`).all(...[convId, ...(o.before ? [o.before] : []), lim]) as MsgRow[];
    return rows.reverse().map((m) => this.toMessage(m, c));
  }
  markRead(convId: string) {
    const c = this.must(convId), top = (this.db.prepare('SELECT coalesce(max(seq), 0) s FROM people_messages WHERE conv_id = ?').get(convId) as { s: number }).s;
    if (top <= c.read_seq) return;
    this.db.prepare('UPDATE people_conversations SET read_seq = ? WHERE id = ?').run(top, convId);
    if (this.canMessage(c)) this.queue(c.peer_key, { kind: 'msg.read', upTo: this.now() });
    this.changed('conversations', { convId });
  }
  /** Deletes this device's copy of the messages (and their files). The other person's copy is theirs. */
  async clearHistory(convId: string) {
    this.must(convId);
    const files = this.db.prepare('SELECT id FROM people_transfers WHERE conv_id = ?').all(convId) as { id: string }[];
    for (const f of files) await this.dropTransferBytes(f.id, 'cancelled');
    tx(this.db, () => { this.db.prepare('DELETE FROM people_messages WHERE conv_id = ?').run(convId); this.db.prepare('DELETE FROM people_transfers WHERE conv_id = ?').run(convId); this.db.prepare('UPDATE people_conversations SET read_seq = 0 WHERE id = ?').run(convId); });
    this.changed('messages', { convId });
  }
  /** Removes the conversation from this device (history included). Tells them only if it was still active. */
  async removeConversation(convId: string) {
    const c = this.must(convId);
    if (c.state === 'active' || c.state === 'invited_out') this.endChat(convId);
    await this.clearHistory(convId);
    this.db.prepare('DELETE FROM people_outbox WHERE to_key = ? AND msg_id IS NOT NULL').run(c.peer_key);
    this.db.prepare('DELETE FROM people_conversations WHERE id = ?').run(convId);
    this.changed('conversations', { convId });
  }

  // ---------------- files & voice notes ----------------
  transfer(id: string): Transfer | null {
    const t = this.db.prepare('SELECT * FROM people_transfers WHERE id = ?').get(id) as XferRow | undefined;
    return t ? { id: t.id, direction: t.direction, name: t.name, mime: t.mime, size: t.size, sha256: t.sha256, retention: t.retention, voiceMs: t.voice_ms, state: t.state, received: t.received, objectId: t.object_id, error: t.error, expiresAt: t.expires_at } : null;
  }
  private xfer(id: string) { const t = this.db.prepare('SELECT * FROM people_transfers WHERE id = ?').get(id) as XferRow | undefined; if (!t) throw new PeerError('not_found', 'No such file.'); return t; }
  /** Offers a file (copied into this device's store first). Voice notes are auto-accepted inside an active chat. */
  async offerFile(convId: string, path: string, o: { name: string; mime: string; voiceMs?: number; retention?: 'temporary' | 'permanent' }) {
    const c = this.must(convId);
    if (!this.canMessage(c)) throw new PeerError('not_allowed', 'This conversation is not active.');
    const voice = o.voiceMs !== undefined;
    if (voice && !(VOICE_MIME as readonly string[]).includes(o.mime)) throw new PeerError('invalid', 'Unsupported voice format.');
    const { object, release } = await this.store.put(path, o.mime);
    try {
      if (object.size > (voice ? VOICE_MAX : FILE_MAX)) throw new PeerError('too_large', voice ? 'Voice messages are limited to 10 MB.' : 'Files are limited to 2 GB.');
      const retention = c.mode === 'temporary' ? 'temporary' : (o.retention ?? 'permanent');
      const id = randomUUID(), msgId = randomUUID(), at = this.now(), expires = this.expiry(c, at);
      const file: FileMeta = { transferId: id, name: z.string().trim().min(1).max(255).parse(o.name).replace(/[\\/\0]/g, '_'), mime: o.mime.slice(0, 120), size: object.size, sha256: object.sha256, retention, ...(voice ? { voice: { durationMs: Math.max(1, Math.round(o.voiceMs!)) } } : {}) };
      tx(this.db, () => {
        const ref = this.store.ref(object.id, { module: 'people', entity: 'transfer', entityId: id, scope: { kind: 'personal', ownerId: this.me() }, name: file.name, createdBy: this.me() });
        this.db.prepare(`INSERT INTO people_transfers (id, conv_id, msg_id, direction, name, mime, size, sha256, retention, voice_ms, state, received, object_id, ref_id, expires_at, created_at, updated_at)
          VALUES (?, ?, ?, 'out', ?, ?, ?, ?, ?, ?, 'offered', ?, ?, ?, ?, ?, ?)`).run(id, convId, msgId, file.name, file.mime, file.size, file.sha256, retention, file.voice?.durationMs ?? null, object.size, object.id, ref.id, expires, at, at);
        this.addMessage(convId, { id: msgId, author: this.myKey(), kind: voice ? 'voice' : 'file', transferId: id, createdAt: at, state: 'queued', expiresAt: expires });
        this.queue(c.peer_key, { kind: 'file.offer', msgId, file }, msgId);
      });
      this.changed('transfers', { convId });
      return this.transfer(id)!;
    } finally { release(); }
  }
  /** The receiver's explicit consent (voice notes in an active chat are accepted on arrival). */
  acceptFile(id: string) {
    const t = this.xfer(id);
    if (t.direction !== 'in' || t.state !== 'offered') throw new PeerError('bad_state', 'This file is not waiting for you.');
    const c = this.must(t.conv_id);
    tx(this.db, () => { this.setXfer(id, 'accepted'); this.queue(c.peer_key, { kind: 'file.accept', transferId: id }); });
  }
  declineFile(id: string) {
    const t = this.xfer(id);
    if (t.direction !== 'in' || t.state !== 'offered') throw new PeerError('bad_state', 'This file is not waiting for you.');
    tx(this.db, () => { this.setXfer(id, 'declined'); this.queue(this.must(t.conv_id).peer_key, { kind: 'file.decline', transferId: id }); });
  }
  async cancelFile(id: string) {
    const t = this.xfer(id);
    if (['complete', 'declined', 'cancelled', 'expired'].includes(t.state)) return;
    this.queue(this.must(t.conv_id).peer_key, { kind: 'file.cancel', transferId: id });
    await this.dropTransferBytes(id, 'cancelled');
  }
  private setXfer(id: string, state: Transfer['state'], extra: { received?: number; error?: string | null; objectId?: string | null; refId?: string | null } = {}) {
    this.db.prepare('UPDATE people_transfers SET state = ?, received = coalesce(?, received), error = ?, object_id = coalesce(?, object_id), ref_id = coalesce(?, ref_id), updated_at = ? WHERE id = ?')
      .run(state, extra.received ?? null, extra.error ?? null, extra.objectId ?? null, extra.refId ?? null, this.now(), id);
    this.changed('transfers', { convId: (this.db.prepare('SELECT conv_id c FROM people_transfers WHERE id = ?').get(id) as { c: string } | undefined)?.c });
  }
  /** Sender side: the bytes a peer may fetch — only an accepted transfer of ours, only to that conversation's peer. */
  outgoingBytes(id: string, peerKey: string) {
    const t = this.db.prepare('SELECT * FROM people_transfers WHERE id = ?').get(id) as XferRow | undefined;
    if (!t || t.direction !== 'out' || !['accepted', 'transferring', 'complete'].includes(t.state) || this.must(t.conv_id).peer_key !== peerKey || !t.object_id) return null;
    const o = this.store.object(t.object_id);
    return o ? { path: o.location, size: t.size, sha256: t.sha256, mime: t.mime, name: t.name } : null;
  }
  /** This device's own copy of a file it sent (for preview/save on the sender's side). */
  outgoingBytesLocal(id: string) { const t = this.xfer(id); return t.direction === 'out' && t.object_id && !['cancelled', 'expired'].includes(t.state) ? this.store.object(t.object_id)?.location ?? null : null; }
  outgoingServed(id: string) { const t = this.xfer(id); if (t.direction === 'out' && t.state !== 'complete') this.setXfer(id, 'transferring'); }
  /** Receiver side, what to fetch next. */
  pendingDownloads() { return (this.db.prepare("SELECT id FROM people_transfers WHERE direction = 'in' AND state IN ('accepted','transferring')").all() as { id: string }[]).map((r) => ({ ...this.transfer(r.id)!, peerKey: this.must(this.xfer(r.id).conv_id).peer_key })); }
  /** Sender side, for a device that pushes (a phone): offered files the other person accepted and has not confirmed yet. */
  pendingUploads() { return (this.db.prepare("SELECT id FROM people_transfers WHERE direction = 'out' AND state IN ('accepted','transferring')").all() as { id: string }[]).map((r) => ({ ...this.transfer(r.id)!, peerKey: this.must(this.xfer(r.id).conv_id).peer_key, path: this.outgoingBytesLocal(r.id) })); }
  progress(id: string, received: number) { const t = this.xfer(id); if (t.direction === 'in' && ['accepted', 'transferring'].includes(t.state)) this.setXfer(id, 'transferring', { received: Math.min(received, t.size) }); }
  /** Receiver: bytes fully arrived at `path`. Verified (size + SHA-256) and moved into the store, or rejected. */
  async completeDownload(id: string, path: string) {
    const t = this.xfer(id);
    if (t.direction !== 'in' || !['accepted', 'transferring'].includes(t.state)) throw new PeerError('bad_state', 'Not receiving this file.');
    const { object, release } = await this.store.ingest(path, t.mime);
    try {
      if (object.sha256 !== t.sha256 || object.size !== t.size) {
        this.setXfer(id, 'failed', { error: 'The received file did not match what was offered (integrity check failed).' });
        throw new PeerError('corrupt', 'The received file did not match what was offered.');
      }
      tx(this.db, () => {
        const ref = this.store.ref(object.id, { module: 'people', entity: 'transfer', entityId: id, scope: { kind: 'personal', ownerId: this.me() }, name: t.name, createdBy: this.me() });
        this.setXfer(id, 'complete', { received: t.size, objectId: object.id, refId: ref.id });
        this.queue(this.must(t.conv_id).peer_key, { kind: 'file.done', transferId: id });
      });
    } finally { release(); }
    return this.transfer(id)!;
  }
  failDownload(id: string, error: string) { const t = this.xfer(id); if (t.direction === 'in' && t.state !== 'complete') this.setXfer(id, 'failed', { error: error.slice(0, 200) }); }
  retryDownload(id: string) { const t = this.xfer(id); if (t.direction === 'in' && t.state === 'failed') this.setXfer(id, 'accepted', { error: null }); }
  filePath(id: string) { const t = this.xfer(id); return t.state === 'complete' && t.object_id ? this.store.object(t.object_id)?.location ?? null : null; }
  private async dropTransferBytes(id: string, state: Transfer['state']) {
    const t = this.db.prepare('SELECT * FROM people_transfers WHERE id = ?').get(id) as XferRow | undefined;
    if (!t) return;
    if (t.ref_id) this.store.unref(t.ref_id);
    this.setXfer(id, state);
    if (t.object_id) { try { this.store.collectOwned(t.object_id); } catch { /* retried at the next sweep */ } }
  }

  nearbyAlerts(on?: boolean): boolean {
    if (on !== undefined) this.db.prepare('UPDATE people_profile SET nearby_alerts = ?').run(on ? 1 : 0);
    return !!(this.db.prepare('SELECT nearby_alerts n FROM people_profile').get() as { n: number } | undefined)?.n;
  }
  friendReachable(key: string) {
    const c = this.contact(key); if (!this.nearbyAlerts() || !c?.verified || !this.isFriend(key) || this.isBlocked(key)) return;
    const last = this.db.prepare('SELECT at FROM people_nearby_alerts WHERE key = ?').get(key) as { at: number } | undefined;
    const global = this.db.prepare('SELECT max(at) at FROM people_nearby_alerts').get() as { at: number | null };
    if (last && this.now() - last.at < 3_600_000 || global.at !== null && this.now() - global.at < 15 * 60_000) return;
    this.db.prepare('INSERT INTO people_nearby_alerts (key, at) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET at = excluded.at').run(key, this.now());
    this.bus.publish(PeopleAlert, 'people', { id: randomUUID(), key, kind: 'friend.nearby', convId: this.convWith(key)?.id });
  }

  // ---------------- calls (live only) ----------------
  /** Signaling envelope for the call module; refused unless they are a friend or share an active chat. */
  callSignal(key: string, body: Extract<PeerBody, { kind: `call.${string}` }>) {
    this.assertCallable(key);
    if (!LIVE_KINDS.has(body.kind)) throw new PeerError('invalid', 'Only fresh call signals may ring.');
    return signEnvelope(this.sgn(), { id: randomUUID(), to: key, at: this.now(), body });
  }
  queueCallAttempt(key: string, callId: string) {
    this.assertCallable(key); z.uuid().parse(callId);
    tx(this.db, () => { this.dropQueued(key, 'call.attempt'); this.queue(key, { kind: 'call.attempt', callId, expiresAt: this.now() + 24 * 3_600_000 }); });
  }
  private assertCallable(key: string) {
    const c = this.convWith(key);
    if (this.isBlocked(key) || !(this.isFriend(key) || (c && c.state === 'active'))) throw new PeerError('not_allowed', 'You can call friends and people you are chatting with.');
  }
  logCall(o: { id: string; peerKey: string; direction: 'in' | 'out'; connectedAt?: number | null; endedAt?: number | null; outcome?: string }, notify = true) {
    const previous = this.db.prepare('SELECT ended_at, peer_key, direction FROM people_calls WHERE id = ?').get(o.id) as { ended_at: number | null; peer_key: string; direction: string } | undefined;
    if (previous && (previous.peer_key !== o.peerKey || previous.direction !== o.direction)) throw new PeerError('refused', 'Call identity does not match its history.');
    this.db.prepare(`INSERT INTO people_calls (id, peer_key, direction, started_at, connected_at, ended_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (id) DO UPDATE SET connected_at = coalesce(excluded.connected_at, connected_at), ended_at = coalesce(excluded.ended_at, ended_at), outcome = coalesce(excluded.outcome, outcome)`)
      .run(o.id, o.peerKey, o.direction, this.now(), o.connectedAt ?? null, o.endedAt ?? null, o.outcome ?? null);
    if (o.endedAt) {
      const c = this.convWith(o.peerKey);
      if (c) { const row = this.db.prepare('SELECT * FROM people_calls WHERE id = ?').get(o.id) as { connected_at: number | null; started_at: number; direction: string };
        const secs = row.connected_at ? Math.round((o.endedAt - row.connected_at) / 1000) : 0;
        this.addMessage(c.id, { id: `call-${o.id}`, author: o.direction === 'out' ? this.myKey() : o.peerKey, kind: 'call', text: o.outcome === 'attempt-later' ? 'Call attempt received after reconnecting (did not ring)' : o.outcome === 'unreachable' ? 'Call attempt — recipient was unreachable' : row.connected_at ? `Call · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}` : `Missed or declined call (${o.outcome ?? 'ended'})`,
          createdAt: row.started_at, state: o.direction === 'out' ? 'delivered' : 'received', expiresAt: this.expiry(c, row.started_at) });
        this.changed('messages', { convId: c.id }); }
    }
    this.changed('calls', { key: o.peerKey });
    if (notify && o.direction === 'in' && o.endedAt && !previous?.ended_at && !o.connectedAt && (o.outcome?.startsWith('missed') || o.outcome === 'attempt-later')) this.bus.publish(PeopleAlert, 'people', { id: randomUUID(), key: o.peerKey, kind: o.outcome === 'attempt-later' ? 'call.attempt' : 'call.missed', convId: this.convWith(o.peerKey)?.id });
  }

  // ---------------- outbox ----------------
  private assertPeer(key: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(key) || key === this.myKey()) throw new PeerError('invalid', 'Unknown person.');
    if (!this.db.prepare('SELECT 1 FROM people_contacts WHERE key = ?').get(key)) throw new PeerError('not_found', 'Meet this person first (nearby or by QR).');
  }
  private queue(key: string, body: PeerBody, msgId: string | null = null) {
    if (this.isBlocked(key)) return;
    const count = this.db.prepare('SELECT count(*) n FROM people_outbox').get() as { n: number };
    if (count.n >= 2000) throw new PeerError('full', 'The pending delivery queue is full. Reconnect or cancel pending items first.');
    const env = signEnvelope(this.sgn(), { id: randomUUID(), to: key, at: this.now(), body });
    this.db.prepare('INSERT INTO people_outbox (id, to_key, envelope, msg_id, created_at, next_at) VALUES (?, ?, ?, ?, ?, ?)').run(env.id, key, JSON.stringify(env), msgId, this.now(), this.now());
  }
  private dropQueued(key: string, kind: string) {
    for (const r of this.db.prepare('SELECT id, envelope FROM people_outbox WHERE to_key = ?').all(key) as { id: string; envelope: string }[]) if ((JSON.parse(r.envelope) as PeerEnvelope).body.kind === kind) this.db.prepare('DELETE FROM people_outbox WHERE id = ?').run(r.id);
  }
  /** Due envelopes, oldest first (the transport delivers them in order per person). */
  private pruneQueued() {
    const at = this.now();
    for (const [id, until] of this.activeSends) if (until <= at) this.activeSends.delete(id);
    this.db.prepare('DELETE FROM people_outbox WHERE msg_id IN (SELECT id FROM people_messages WHERE expires_at IS NOT NULL AND expires_at <= ?)').run(at);
    for (const row of this.db.prepare('SELECT id, envelope FROM people_outbox WHERE msg_id IS NULL').all() as { id: string; envelope: string }[]) { const e = JSON.parse(row.envelope) as PeerEnvelope; if (e.body.kind === 'call.attempt' && e.body.expiresAt <= at) this.db.prepare('DELETE FROM people_outbox WHERE id = ?').run(row.id); }
  }
  due(at = this.now(), limit = 100) { this.pruneQueued(); return (this.db.prepare('SELECT id, to_key, envelope FROM people_outbox WHERE next_at <= ? ORDER BY created_at, rowid LIMIT ?').all(at, limit) as { id: string; to_key: string; envelope: string }[]).map((r) => ({ id: r.id, to: r.to_key, envelope: JSON.parse(r.envelope) as PeerEnvelope })); }
  queuedFor(key: string) { this.pruneQueued(); return (this.db.prepare('SELECT envelope FROM people_outbox WHERE to_key = ? ORDER BY created_at, rowid').all(key) as { envelope: string }[]).map((r) => JSON.parse(r.envelope) as PeerEnvelope); }
  sending(id: string) {
    const r = this.db.prepare('SELECT msg_id FROM people_outbox WHERE id = ?').get(id) as { msg_id: string | null } | undefined;
    if (!r?.msg_id) return;
    const previous = this.activeSends.get(r.msg_id) ?? 0;
    this.activeSends.set(r.msg_id, this.now() + 30_000);
    if (previous <= this.now()) this.changed('messages');
  }
  delivered(id: string, recipient?: string) {
    const r = this.db.prepare('SELECT msg_id, to_key FROM people_outbox WHERE id = ?').get(id) as { msg_id: string | null; to_key: string } | undefined;
    if (!r || recipient && r.to_key !== recipient) return;
    if (r.msg_id) this.activeSends.delete(r.msg_id);
    tx(this.db, () => {
      this.db.prepare('DELETE FROM people_outbox WHERE id = ?').run(id);
      if (r.msg_id) this.db.prepare("UPDATE people_messages SET state = 'delivered' WHERE id = ? AND state IN ('queued','failed')").run(r.msg_id);
    });
    if (r.msg_id) this.changed('messages', { convId: (this.db.prepare('SELECT conv_id c FROM people_messages WHERE id = ?').get(r.msg_id) as { c: string } | undefined)?.c });
  }
  /** Not reachable now: retried with backoff (queued messages survive restarts). A refusal is final. */
  deliveryFailed(id: string, error: string, final = false) {
    const r = this.db.prepare('SELECT tries, msg_id FROM people_outbox WHERE id = ?').get(id) as { tries: number; msg_id: string | null } | undefined;
    if (!r) return;
    if (r.msg_id) this.activeSends.delete(r.msg_id);
    if (final) {
      tx(this.db, () => { this.db.prepare('DELETE FROM people_outbox WHERE id = ?').run(id); if (r.msg_id) this.db.prepare("UPDATE people_messages SET state = 'failed' WHERE id = ?").run(r.msg_id); });
    } else this.db.prepare('UPDATE people_outbox SET tries = tries + 1, next_at = ?, last_error = ? WHERE id = ?').run(this.now() + Math.min(5 * 60_000, 2_000 * 2 ** Math.min(r.tries, 8)), error.slice(0, 200), id);
    if (r.msg_id) this.changed('messages');
  }
  /** Peer came online (discovered or connected): retry its queue now. */
  wake(key: string) { this.db.prepare('UPDATE people_outbox SET next_at = ? WHERE to_key = ?').run(this.now(), key); }
  retryMessage(msgId: string) {
    const m = this.db.prepare("SELECT * FROM people_messages WHERE id = ? AND state = 'failed'").get(msgId) as MsgRow | undefined;
    if (!m) throw new PeerError('bad_state', 'Only failed messages can be retried.');
    const c = this.must(m.conv_id);
    if (!this.canMessage(c)) throw new PeerError('not_allowed', 'This conversation is not active.');
    if (m.kind !== 'text') throw new PeerError('bad_state', 'Send the file again.');
    tx(this.db, () => { this.db.prepare("UPDATE people_messages SET state = 'queued' WHERE id = ?").run(msgId); this.queue(c.peer_key, { kind: 'msg.text', msgId, text: m.text! }, msgId); });
  }

  // ---------------- incoming ----------------
  /**
   * Verifies and applies one envelope that arrived over an authenticated connection from `transportKey`. Returns what
   * the transport should do next. Throws PeerError (refused/invalid) — the sender learns only a generic refusal.
   */
  receive(raw: unknown, transportKey: string): { kind: PeerBody['kind']; live?: PeerEnvelope; download?: string } {
    const p = PeerEnvelope.safeParse(raw);
    if (!p.success) throw new PeerError('invalid', 'Malformed message.');
    const e = p.data, at = this.now();
    if (e.from !== transportKey || e.to !== this.myKey() || !envelopeValid(e)) throw new PeerError('invalid', 'Message is not signed by the connected person or not for this device.');
    if (this.isBlocked(e.from)) throw new PeerError('refused', 'Not accepted.');
    if (LIVE_KINDS.has(e.body.kind)) {
      if (Math.abs(at - e.at) > LIVE_MAX_AGE_MS) throw new PeerError('stale', 'Expired call signal.');
      this.assertCallable(e.from);
      if (this.db.prepare('SELECT 1 FROM people_seen WHERE id = ?').get(e.id)) return { kind: e.body.kind };
      this.db.prepare('INSERT INTO people_seen (id, at) VALUES (?, ?)').run(e.id, at);
      if (e.body.kind === 'call.invite') this.bus.publish(PeopleAlert, 'people', { id: e.id, key: e.from, kind: e.body.kind, convId: this.convWith(e.from)?.id });
      return { kind: e.body.kind, live: e };
    }
    if (e.at < at - REPLAY_WINDOW_MS || e.at > at + REPLAY_WINDOW_MS) throw new PeerError('stale', 'Message too old.');
    if (this.db.prepare('SELECT 1 FROM people_seen WHERE id = ?').get(e.id)) return { kind: e.body.kind }; // replay or retry: already applied
    const rel = this.rel(e.from), friend = rel?.state === 'friend', c = this.convWith(e.from), body = e.body;
    const unsolicited = body.kind === 'friend.request' || (body.kind === 'chat.invite' && !friend && c?.state !== 'active');
    if (unsolicited) this.limit(e.from);
    let download: string | undefined, alertAttempt = false;
    tx(this.db, () => {
      this.db.prepare('INSERT INTO people_seen (id, at) VALUES (?, ?)').run(e.id, at);
      this.touch(e.from);
      switch (body.kind) {
        case 'call.attempt':
          this.assertCallable(e.from);
          if (body.expiresAt <= at || body.expiresAt > e.at + 24 * 3_600_000) throw new PeerError('stale', 'Expired call attempt.');
          const previousCall = this.db.prepare('SELECT peer_key FROM people_calls WHERE id = ?').get(body.callId) as { peer_key: string } | undefined;
          if (previousCall) { if (previousCall.peer_key !== e.from) throw new PeerError('refused', 'Call history belongs to another person.'); break; }
          this.logCall({ id: body.callId, peerKey: e.from, direction: 'in', endedAt: at, outcome: 'attempt-later' }, false); alertAttempt = true;
          break;
        case 'friend.request':
          if (rel?.state === 'friend') { this.queue(e.from, { kind: 'friend.accept' }); break; }
          if (rel?.state === 'outgoing') { this.setRel(e.from, 'friend'); this.queue(e.from, { kind: 'friend.accept' }); this.ensureConversation(e.from, 'active', 'permanent', null); break; }
          this.setRel(e.from, 'incoming', body.note ?? null); break;
        case 'friend.accept':
          if (rel?.state !== 'outgoing' && rel?.state !== 'friend') throw new PeerError('refused', 'No request to accept.');
          this.queue(e.from, { kind: 'presence.key', key: this.presenceKey() }); // also for a friend's newly accepted device
          this.setRel(e.from, 'friend');
          if (!c || c.state !== 'active') this.ensureConversation(e.from, 'active', 'permanent', null);
          break;
        case 'device.links': {
          if (!friend) throw new PeerError('refused', 'Only friends share their devices.');
          for (const d of body.devices) {
            if (d.key === e.from || d.key === this.myKey() || !verifyStatement(d.key, personDeviceStatement(body.account, d.key), d.sig)) continue;
            const r = this.rel(d.key);
            if (r?.blocked || r?.state === 'friend') continue;
            this.db.prepare("INSERT INTO people_device_offers (from_key, key, name, state, at) VALUES (?, ?, ?, 'pending', ?) ON CONFLICT (from_key, key) DO UPDATE SET name = excluded.name WHERE state = 'pending'").run(e.from, d.key, d.name, at);
          }
          this.changed('relations', { key: e.from });
          break;
        }
        case 'presence.key':
          if (!friend) throw new PeerError('refused', 'Only friends share presence.');
          this.db.prepare('UPDATE people_contacts SET presence_key = ? WHERE key = ?').run(body.key, e.from);
          break;
        case 'friend.reject': if (rel?.state === 'outgoing') this.setRel(e.from, 'none'); break;
        case 'friend.cancel': if (rel?.state === 'incoming') this.setRel(e.from, 'none'); break;
        case 'friend.remove': if (rel?.state === 'friend') { this.setRel(e.from, 'none'); this.forgetPresence(e.from); } break;
        case 'chat.invite': {
          const same = c?.state === 'active' && c.mode === body.mode && c.ttl_ms === body.ttlMs;
          if (same) { this.queue(e.from, { kind: 'chat.accept', mode: body.mode, ttlMs: body.ttlMs }); break; }
          if (c?.state === 'invited_out' && c.mode === body.mode && c.ttl_ms === body.ttlMs) { this.ensureConversation(e.from, 'active', body.mode, body.ttlMs); this.queue(e.from, { kind: 'chat.accept', mode: body.mode, ttlMs: body.ttlMs }); break; }
          this.ensureConversation(e.from, 'invited_in', body.mode, body.ttlMs); break;
        }
        case 'chat.accept':
          // Only the terms we proposed become active (a peer cannot silently change the retention policy).
          if (!c || c.state !== 'invited_out' || c.mode !== body.mode || c.ttl_ms !== body.ttlMs) { if (c?.state === 'active' && c.mode === body.mode && c.ttl_ms === body.ttlMs) break; throw new PeerError('refused', 'No matching invitation.'); }
          this.db.prepare("UPDATE people_conversations SET state = 'active', updated_at = ? WHERE id = ?").run(at, c.id); this.changed('conversations', { convId: c.id }); break;
        case 'chat.decline': if (c?.state === 'invited_out') { this.db.prepare("UPDATE people_conversations SET state = 'declined', updated_at = ? WHERE id = ?").run(at, c.id); this.changed('conversations', { convId: c.id }); } break;
        case 'chat.end': if (c && c.state !== 'ended') { this.db.prepare("UPDATE people_conversations SET state = 'ended', updated_at = ? WHERE id = ?").run(at, c.id); this.changed('conversations', { convId: c.id }); } break;
        case 'msg.text': {
          if (!c || !this.canMessage(c)) throw new PeerError('refused', 'No active conversation.');
          if (this.addMessage(c.id, { id: body.msgId, author: e.from, kind: 'text', text: body.text, createdAt: Math.min(e.at, at), state: 'received', expiresAt: this.expiry(c, Math.min(e.at, at)) })) this.changed('messages', { convId: c.id });
          break;
        }
        case 'msg.read': if (c) { this.db.prepare('UPDATE people_conversations SET peer_read_at = max(peer_read_at, ?) WHERE id = ?').run(Math.min(body.upTo, at), c.id); this.changed('messages', { convId: c.id }); } break;
        case 'file.offer': {
          if (!c || !this.canMessage(c)) throw new PeerError('refused', 'No active conversation.');
          const f = body.file, voice = !!f.voice;
          if (voice && (f.size > VOICE_MAX || !(VOICE_MIME as readonly string[]).includes(f.mime))) throw new PeerError('refused', 'Unsupported voice message.');
          if (this.db.prepare('SELECT 1 FROM people_transfers WHERE id = ?').get(f.transferId)) break;
          const retention = c.mode === 'temporary' ? 'temporary' : f.retention, expires = this.expiry(c, Math.min(e.at, at));
          this.db.prepare(`INSERT INTO people_transfers (id, conv_id, msg_id, direction, name, mime, size, sha256, retention, voice_ms, state, expires_at, created_at, updated_at)
            VALUES (?, ?, ?, 'in', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(f.transferId, c.id, body.msgId, f.name, f.mime, f.size, f.sha256, retention, f.voice?.durationMs ?? null, voice ? 'accepted' : 'offered', expires, at, at);
          this.addMessage(c.id, { id: body.msgId, author: e.from, kind: voice ? 'voice' : 'file', transferId: f.transferId, createdAt: Math.min(e.at, at), state: 'received', expiresAt: expires });
          if (voice) { this.queue(e.from, { kind: 'file.accept', transferId: f.transferId }); download = f.transferId; }
          this.changed('transfers', { convId: c.id }); break;
        }
        case 'file.accept': {
          const t = this.db.prepare('SELECT * FROM people_transfers WHERE id = ?').get(body.transferId) as XferRow | undefined;
          if (!t || t.direction !== 'out' || this.must(t.conv_id).peer_key !== e.from) throw new PeerError('refused', 'Unknown transfer.');
          if (t.state === 'offered') this.setXfer(t.id, 'accepted'); break;
        }
        case 'file.done': {
          const t = this.db.prepare('SELECT * FROM people_transfers WHERE id = ?').get(body.transferId) as XferRow | undefined;
          if (!t || t.direction !== 'out' || this.must(t.conv_id).peer_key !== e.from) throw new PeerError('refused', 'Unknown transfer.');
          if (['accepted', 'transferring'].includes(t.state)) this.setXfer(t.id, 'complete'); break;
        }
        case 'file.decline': case 'file.cancel': {
          const t = this.db.prepare('SELECT * FROM people_transfers WHERE id = ?').get(body.transferId) as XferRow | undefined;
          if (!t || this.must(t.conv_id).peer_key !== e.from) throw new PeerError('refused', 'Unknown transfer.');
          if (!['complete', 'expired'].includes(t.state)) this.setXfer(t.id, body.kind === 'file.decline' ? 'declined' : 'cancelled'); break;
        }
      }
    });
    if (alertAttempt || ['msg.text', 'file.offer', 'file.done', 'friend.request', 'chat.invite'].includes(e.body.kind)) this.bus.publish(PeopleAlert, 'people', { id: e.id, key: e.from, kind: e.body.kind, convId: this.convWith(e.from)?.id });
    if (e.body.kind.startsWith('friend.')) this.wake(e.from);
    return { kind: e.body.kind, download };
  }
  private limit(key: string) {
    const at = this.now(), keep = (a: number[]) => a.filter((t) => t > at - RATE.windowMs);
    const mine = keep(this.rate.get(key) ?? []), all = keep(this.rate.get('*') ?? []);
    if (mine.length >= RATE.perSender || all.length >= RATE.overall) throw new PeerError('rate_limited', 'Too many requests; try later.');
    this.rate.set(key, [...mine, at]); this.rate.set('*', [...all, at]);
  }

  // ---------------- retention ----------------
  /** Deletes expired temporary messages and their files on this device (call about once a minute and at start). */
  async sweep(at = this.now()) {
    this.pruneQueued();
    const expired = this.db.prepare('SELECT id, conv_id, transfer_id FROM people_messages WHERE expires_at IS NOT NULL AND expires_at <= ?').all(at) as { id: string; conv_id: string; transfer_id: string | null }[];
    for (const m of expired) if (m.transfer_id) await this.dropTransferBytes(m.transfer_id, 'expired');
    if (expired.length) tx(this.db, () => {
      for (const m of expired) { this.db.prepare('DELETE FROM people_messages WHERE id = ?').run(m.id); if (m.transfer_id) this.db.prepare('DELETE FROM people_transfers WHERE id = ?').run(m.transfer_id); }
    });
    this.db.prepare('DELETE FROM people_seen WHERE at < ?').run(at - 2 * REPLAY_WINDOW_MS);
    if (expired.length) this.changed('messages');
    return expired.length;
  }
  /** Removes leftover partial downloads the transport owns (called with their paths when transfers end). */
  async removePartial(path: string) { await rm(path, { force: true }); }

  // ---------------- personal sync (friends & blocks follow you to your linked devices) ----------------
  syncProviders(): SyncProvider[] {
    const kind = 'people-relation';
    const In = z.object({ state: z.enum(['none', 'outgoing', 'incoming', 'friend']), blocked: z.boolean(), profile: z.unknown().nullable() }).strict();
    const one = (key: string) => { const c = this.contact(key); if (!c || (c.relation === 'none' && !c.blocked)) return null; const row = this.db.prepare('SELECT profile FROM people_contacts WHERE key = ?').get(key) as { profile: string | null };
      return { state: c.relation === 'friend' ? 'friend' : 'none', blocked: c.blocked, profile: row.profile ? JSON.parse(row.profile) : null }; };
    const devKind = 'people-device', Dev = z.object({ name: z.string().min(1).max(80), account: z.string().min(1).max(80), sig: z.string().max(100), at: z.number().int() }).strict();
    const devices: SyncProvider = {
      kind: devKind, policy: 'lww',
      all: () => new Map((this.db.prepare('SELECT key, name, account, sig, at FROM people_my_devices').all() as { key: string; name: string; account: string; sig: string; at: number }[]).map((r) => [r.key, { name: r.name, account: r.account, sig: r.sig, at: r.at }] as const)),
      one: (_o, id) => { const r = this.db.prepare('SELECT name, account, sig, at FROM people_my_devices WHERE key = ?').get(id) as { name: string; account: string; sig: string; at: number } | undefined; return r ?? null; },
      apply: (_o, id, payload) => {
        if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return;
        if (payload === null) { this.db.prepare('DELETE FROM people_my_devices WHERE key = ?').run(id); return; }
        const d = Dev.parse(payload);
        if (!verifyStatement(id, personDeviceStatement(d.account, id), d.sig)) return; // a device can only be added by itself
        this.db.prepare('INSERT OR REPLACE INTO people_my_devices (key, name, account, sig, at) VALUES (?, ?, ?, ?, ?)').run(id, d.name, d.account, d.sig, d.at);
      },
    };
    return [devices, {
      kind, policy: 'lww',
      all: () => new Map((this.db.prepare('SELECT key FROM people_relations').all() as { key: string }[]).map((r) => [r.key, one(r.key)] as const).filter(([, v]) => v !== null)),
      one: (_owner, id) => one(id),
      apply: (_owner, id, payload) => {
        if (!/^[A-Za-z0-9_-]{43}$/.test(id)) return;
        if (payload === null) { this.db.prepare('DELETE FROM people_relations WHERE key = ?').run(id); return; }
        const p = In.parse(payload);
        // Only verified profiles become contacts; friendship itself was authenticated by the device that made it.
        if (p.profile && profileValid(p.profile as SignedProfile) && (p.profile as SignedProfile).profile.key === id) this.meet({ profile: p.profile });
        else this.touch(id);
        this.db.prepare(`INSERT INTO people_relations (key, state, blocked, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (key) DO UPDATE SET state = excluded.state, blocked = excluded.blocked, updated_at = excluded.updated_at`)
          .run(id, p.state === 'friend' ? 'friend' : 'none', p.blocked ? 1 : 0, this.now());
      },
    }];
  }
}
