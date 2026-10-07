# Peer-assisted mode (Milestone 2.75)

The teacher stays the **only authority**; peers only **carry bytes** whose correctness is decided by teacher signatures.

```
                         CONTROL PLANE (always the teacher; pinned HTTPS/WSS)
   ┌──────────────────────────────────────────────────────────────────────────────────┐
   │ Teacher app (Ed25519 identity)                                                   │
   │  approvals · permissions · lock/end · official resources · assignments          │
   │  signs: resource manifests, peer endorsements, peer capabilities, receipts      │
   │  tracker: who holds which chunks (/api/peer/sources)  ·  revocation push        │
   └───────────────▲───────────────────────────▲──────────────────────────▲──────────┘
                   │ manifests, capabilities,  │ have/announce,           │ peer.revoked,
                   │ endorsement, sources      │ stats                    │ resource.seed
   ................│...........................│..........................│...............
                         DATA PLANE (teacher or peers; every byte verified)
   ┌──────────┐  chunks  ┌──────────┐  chunks  ┌──────────┐
   │ Teacher  │─────────▶│ Student A │─────────▶│ Student B │◀──── chunks ─── Student C
   │ (Range)  │          │ peer srv  │◀─────────│ peer srv  │
   └──────────┘          └──────────┘          └──────────┘
        Each student: TLS (teacher-endorsed key) · capability + holder proof · SHA-256 per chunk + whole file
```

## Objects (all canonical JSON, signed with the teacher's Ed25519 key)

| Object | Binds | Lifetime | Used by |
|---|---|---|---|
| **Resource manifest** | resource id, session id, name, MIME, size, SHA-256, chunk size, ordered chunk SHA-256s, version, teacher key | resource lifetime | every receiver, before any chunk is accepted |
| **Peer endorsement** | session, member, device public key + fingerprint, peer TLS CA + leaf SPKI pin | 60 min (renewed) | requester: who is at that address, and how to pin its TLS |
| **Peer capability** | session, member, holder public key, scope `resources:read` | 15 min | serving peer: is this requester an approved member |
| **Request proof** (signed by the *holder's* device key) | capability id, serving peer's fingerprint, time | per serving peer | stops a capability shown to one peer being replayed to another |

A peer's own key can sign none of the teacher objects; verification always uses the teacher key learned through OPAQUE
pairing. **Network role ≠ authority** (tests: a peer-signed manifest/capability is rejected even while the teacher is offline;
capabilities are not bearer tokens; peers' teacher commands are refused).

## Acquisition

1. Small files (≤ **4 MB**) or peer assistance off → the existing streaming downloader from the teacher (Range resume).
2. Otherwise fetch the manifest (teacher, or the cached copy while the teacher is unreachable) and verify it.
3. Chunk store: `.partial/<id>.part` written at chunk offsets + a verified-chunk bitmap (debounced). A streaming partial is
   adopted chunk-by-chunk after hashing; switching to streaming keeps the verified contiguous prefix.
4. Scheduler (`acquireChunks`, platform-neutral):
   * **sources** = teacher (always a valid fallback while online) + peers from the teacher's tracker (endorsement verified,
     pinned TLS), refreshed every 0.5 s; when the teacher is unreachable, cached peers are asked directly for what they hold.
   * **flash-crowd control**: each student takes only its *own slice* (≈ 1/(peers+1) of the chunks, starting at a per-device
     offset) from the teacher immediately; for other chunks it prefers peers and only falls back to the teacher after 2 s
     without a peer offering them, or if every peer holding them is unhealthy.
   * **choice**: peers before teacher; then least in-flight, fewest failures, fastest; final tie-break per student (otherwise
     every student picks the same peer).
   * **health** (local, per session — not reputation): corrupt/wrong bytes → avoid that source 10 min; refusals/timeouts → avoid
     15 s; `429` → 0.3 s back-off; `404` → that chunk from that peer is skipped, the peer is still used.
   * every chunk is hashed against the manifest **before** it is written; the assembled file is hashed again before the
     atomic rename. A stall (no progress for 60 s) fails cleanly instead of hanging.
5. Verified chunks are seeded **while downloading**; finished files keep seeding from their final location.

## Seeding, limits and consent

* Desktop seeds by default when the teacher turns Peer Assistance on; the student can untick **Share with classmates**.
* Peer server limits (defaults): 4 concurrent uploads, 1 200 requests/min per requester, optional bandwidth cap
  (`maxBytesPerSec`), pause switch. It binds only to the interface on the teacher's subnet.
* **Phones**: download from peers, never seed (`MOBILE_PEER_CAPABILITIES`), so a phone isn't kept awake or drained.
* Classroom peer traffic uses only the classroom LAN interface; nothing ever goes over cellular or the internet.
* **Seed strategy**: when the teacher sends a resource of ≥ 8 chunks to everyone with Peer Assistance on, the 4 most recently
  active registered peers receive `resource.seed` and start immediately; their verified chunks are offered as they arrive.
* Assignments are **never** peer-shared: submissions go student → teacher only (private data).

## Revocation

Removing or blocking a student: the teacher stops issuing capabilities/endorsements, drops it from the tracker, and pushes
`peer.revoked {fingerprints}` to every student; peer servers refuse that device immediately (tested). If a peer missed the push,
the removed device's capability still expires within **15 minutes**. Files it already downloaded cannot be recalled.

## Teacher temporarily offline

Students keep acquiring **already published** resources from peers using the cached manifest and peer list (and fresh
availability fetched from peers), as long as their capability (15 min) is valid. They see "Teacher temporarily disconnected.
Previously published resources remain available." Nothing official can happen without the teacher: no new resources, approvals,
permission changes, assignments or ending the class. When the teacher returns, the WSS connection resumes the same session.

## Discovery of peers

Through the teacher's tracker (an authenticated control-plane channel) plus the last-known list. Peer-to-peer mDNS was
considered and **not** added: a joined student always reached the teacher at least once, and the cache covers outages, while
mDNS would add a second untrusted advertisement surface. Any source entry, however learned, is only used after its
teacher-signed endorsement verifies and the TLS key matches the endorsed pin.

## Teacher handoff (designed, not implemented)

Authority never moves because the teacher disappeared. A future handoff is an explicit `SignedDelegation
{session, delegateDeviceKey, permissions, expiresAt}` signed by the teacher key, shown on both devices, and countersigned by the
delegate; clients would then accept that delegate key for the listed permissions until expiry. Not built in 2.75.

## Important caveat: shared Wi-Fi airtime

On a **single access point**, peer traffic travels A → AP → B, using the same shared airtime as teacher → AP → B. Peer assistance
then removes the *teacher machine* as the bottleneck (its CPU, disk and a weak teacher radio link) but does **not** add channel
capacity. It adds real capacity on multi-AP / multi-channel networks and wired LANs. Measure with `tools/sim/lan-bench.ts
--mode classroom` before recommending it for a given room.

## Not implemented

Mesh/multi-hop (MESH_MODE.md), media relays (Milestone 4), peer seeding on phones, teacher handoff, rarest-first swarm logic.
