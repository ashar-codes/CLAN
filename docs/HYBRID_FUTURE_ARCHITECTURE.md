# Hybrid future architecture (decision record, 2026-10-10)

**Decision:** keep `@clan/core`, its per-device database, LAN classroom server, and direct sync authoritative for local work. Add an optional, separately authenticated online boundary in stages. No online service is required to open, edit, search, or share locally. This document authorizes no deployment, migration, or Phase 15 feature.

## Boundaries and identity

| Identity | Authority | Link rule |
|---|---|---|
| Local device | OS-protected device key, local database and personal sync trust | Possession of the key; remains useful without an account |
| CLAN member | Host-issued capability after OPAQUE join and approval | Host controls membership; join code is never a global credential |
| Optional global account | Online identity provider/session | Link only after a fresh signed device challenge, authenticated account session and clear user approval on the device; record/revoke each link |
| Public social profile | User-published projection of an account | Separate publishing action and visibility settings; never an automatic mirror of local data |
| Recruiter/professional profile | Distinct verified account and role | Organization vetting, limited scopes and audit trail; no inherent access to student private data |

Account recovery restores the **online account**, not a lost local key. Recover with verified email/passkey plus step-up for sensitive changes; notify other linked devices and delay risky relinking. A remaining trusted device can authorize a replacement; revoke the lost device's online sessions and links, rotate shared sync keys, and let each LAN host revoke its classroom membership separately. Recovery of encrypted cloud data requires a user-held recovery secret or a surviving trusted device. If both are lost, ciphertext is unrecoverable; never give the server a silent master key. Local exports remain usable without account recovery.

## Ownership, encryption and consent

| Data class | Examples | Default and storage | Publication path |
|---|---|---|---|
| Local only | Diary, unsynced notes, AI history, device keys, private classroom files | Device; OS-protected key where supported | Diary and keys never public; any other share requires item-level consent |
| Optional encrypted sync | Explicitly selected personal course/notes/study rows and attachments | Client-encrypted ciphertext on object storage; server sees minimal routing metadata | Sync is private to linked devices; never feeds search, social or recruiter views |
| Shared CLAN | Group chat, host board, assignments, table files | Existing host authority and member capabilities | No automatic upload to a global account; permission to export does not imply permission to publish |
| Public social | Approved profile fields, posts, Shorts, research, public portfolio | Online database/media after explicit preview and publish | Search/feed only from this dedicated projection |
| Recruiter visible | Opted-in portfolio, contact route, verified credentials | Separate consent record with scope, expiry and audit | Student can revoke; recruiter role alone grants no private classroom access |

Server transport uses TLS; private sync payloads are encrypted on the client with per-account content keys wrapped separately for each approved device and an optional offline recovery secret. Avoid convergent encryption and plaintext server search of private content. Public media is scanned and transcoded in quarantine before delivery. Provide export for local data and online public/profile data; deletion revokes access immediately, queues object removal, and documents backup-retention limits. Classroom host retention and student-owned copies are separate responsibilities. No online service receives a local database file or direct SQL access to `@clan/core`.

## Small-scale online stack decision

Use **managed PostgreSQL** for accounts, public profiles, content metadata, consent, moderation and job records. For a closed online pilot, **Supabase is a reasonable default** for managed Postgres, Auth and private Storage, with a small CLAN API for device-link challenges, authorization, publishing and moderation. The client never receives service-role credentials. Every exposed table and storage bucket needs narrowly tested row-level policies; API publication also depends on explicit grants and Data API settings. Authorization uses server-owned roles and fresh checks, not user-editable metadata or a stale JWT alone. Private sync ciphertext lives in a separate schema/bucket with no public API read path. Keep schema migrations, exports and object-key naming portable.

A custom managed backend gives more direct control over account linking, abuse controls and complex feeds, but adds on-call work, auth security, backups and media operations. Keep the CLAN API as a boundary so either backend can replace Supabase without changing local modules. Review costs monthly by active users, database/storage growth, media transcoding minutes, CDN egress, notifications and moderation labor. Social video egress is likely to dominate small database costs; defer transcoding/CDN until content has an audience. Supabase release notes already show managed Postgres upgrades can require extension/index maintenance, so pin and test migrations before adopting extensions.

Use object storage for media, an asynchronous scan/transcode worker, and a CDN only for approved public derivatives. Notifications carry opaque references and follow user preferences. Start search/feed with indexed PostgreSQL queries over published records; add a dedicated search/feed system only after measured scale. Moderation needs reports, takedown/appeal, rate limits, spam controls, audit logs, age-aware defaults and an abuse response owner before public posting. Never put private diary or CLAN data into public embeddings, feeds or media pipelines.

## Module seams

The existing `syncProviders()` and `SyncTransport` remain the only path from local modules to optional sync. An online adapter sends selected encrypted provider rows and applies them through the existing merge/conflict rules. A cloud outage queues work locally with bounded retries and visible status; LAN/direct sync and classroom sessions continue. Online service modules own **global profiles, posts/Shorts, research publishing, follows/communities, public portfolios, achievement attestations, professional connectors, recruiter accounts and opportunities**. They accept explicit publish commands or approved references. They never import local repositories, classroom server internals or the renderer's database bridge.

A verified achievement is an issuer-signed, scoped claim with subject, issuer, evidence URL/hash, issue/expiry time and revocation status; a student's own description is labeled *self-reported*. GitHub/OAuth linking proves control of that external account at link time. It does not prove authorship, skill, employment or course completion. Request minimum scopes, store tokens in a server-side vault, refresh/expire them safely, expose disconnect and data-deletion controls, and stop refresh jobs when revoked. Use provider APIs and webhooks within terms; no scraping.

## Migration gates

1. **Closed beta:** fully local-first; stabilize whiteboard and hardware release gates. Prepare versioned export, consent vocabulary and service interfaces on paper only.
2. **Online account foundation:** optional account, device-link/revocation, recovery and audit; local launch remains account-free.
3. **Optional cloud sync:** opt-in client encryption, key recovery, selected providers, bounded offline queue and conflict tests. LAN/direct sync stays available.
4. **Global CLAN Social:** separate published projections, moderation, storage/transcoding and abuse operations before opening posting.
5. **CLAN Careers:** vetted recruiter roles, scoped opportunities, credential verification, consent and anti-abuse review.

Safe early preparation: stable opaque IDs, export versions, explicit ownership labels and interface tests. Defer social schema in local DB, cloud credentials, public search/feed, video infrastructure and recruiter data collection until their stage gates.

Sources checked for this decision: [CLAN architecture](ARCHITECTURE.md), [sync contract](SYNC.md), [privacy model](PRIVACY_MODEL.md); [Supabase Auth identities](https://supabase.com/docs/guides/auth/identities), [Storage access control](https://supabase.com/docs/guides/storage/security/access-control), [Data API security](https://supabase.com/docs/guides/api/securing-your-api), [Supabase changelog](https://supabase.com/changelog), including the [2026 PostgreSQL maintenance notice](https://supabase.com/changelog/postgres-15-19-17-11-breaking-changes). Backend choice is provisional until cost and threat reviews at Stage 2.
