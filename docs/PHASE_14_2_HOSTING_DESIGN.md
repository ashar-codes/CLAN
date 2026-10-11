# Phase 14.2 persistent local CLAN hosting

Design prerequisite for P1. Implementation must pass the security cases below before host handoff is exposed. No cloud authority or online database is introduced.

## Identity and authority

A CLAN has one stable UUID, one owner public key and a durable authority record: epoch, host device public key, previous record hash, owner-approved delegation and signed transition. Session UUIDs, short-lived codes and bearer tokens remain separate. The owner key stays in its original OS keystore; it is never copied to a standby device. Delegation specifies the CLAN, destination key, allowed host actions and expiry/revocation. Possession of a personal sync link or a classroom join code grants no hosting rights.

Every host operation is scoped to the current epoch and authoritative device. Persist the highest accepted epoch and record hash before serving or acknowledging a write. A conflicting record for the same epoch is an error requiring recovery, never last-write-wins. Clients pin the authorized host's TLS through the existing authenticated pairing path and verify its delegation chain. Legacy sessions remain single-host; they cannot participate in handoff until upgraded.

## Safe handoff sequence

1. The owner explicitly authorizes a destination device using proof of its device key and confirmed consent. The current host validates the delegation and the candidate's protocol/storage support.
2. The current host durably enters **frozen** state, finishes admitted writes, and rejects new writes. It creates a consistent CLAN-scoped checkpoint and immutable file manifests with hashes. It does not include personal study/Diary data, other CLANs, private keys, bearer tokens or OPAQUE setup.
3. The destination stages the checkpoint, verifies every required byte and record, fsyncs/commits it, and signs an acknowledgment of the exact checkpoint hash and predecessor epoch. Resume is idempotent; interrupted replication does not activate the candidate.
4. The current host durably records that it has relinquished epoch N before signing the transition to N+1 and the destination key. It may only replay this same transition after a restart; it cannot resume N. The candidate validates the chain and atomically records the checkpoint and N+1 before accepting writes.
5. The new host starts with its own fresh session keys, OPAQUE record, TLS identity and tokens. Members authenticate again; approvals remain tied to proven device keys, not names. Notify connected clients of the transition without transmitting secrets. The old host retains a readable backup but refuses writes and hosting at the old epoch.

Any uncertain transition is **unavailable for writes** until the authority record is resolved. A frozen host may abort before relinquishment only when the candidate has no transition and the durable protocol proves it cannot activate. After a transition has been signed, unilateral rollback to the previous epoch is forbidden. Recovery uses the signed chain and durable checkpoint, with a new owner-authorized transition where needed.

## Availability and split-brain constraints

An offline owner may coexist with an already authorized active host. An offline authoritative host does **not** make a standby authoritative. Without a successful relinquishment or an independently designed quorum/fencing service, automatic takeover during a partition cannot safely preserve a single writer. Phase 14.2 must use explicit safe handoff and show “No authorized host is online” when none is available. Epoch numbers alone do not fence a partitioned old writer. Never use timeout, mDNS presence, wall-clock lease expiry or a copied owner key as proof of takeover rights.

“Mobile-created” means the phone creates the stable CLAN and owns its authority; it may delegate hosting to a linked, explicitly approved desktop. Show the selected host and current availability. Native Android hosting must reuse the existing server/domain and permission code through a supported embedded runtime, with a user-visible foreground service and encrypted app-private storage. Pause/stop when Android revokes service permissions; never promise background availability. iOS cannot promise an always-on background LAN host; foreground hosting or delegation needs explicit platform evidence.

## Replication and security gates

Replication is a separate authenticated host protocol, never the personal sync provider list. Transfer only the selected CLAN's canonical metadata, membership/role history, chat with exact audience scopes, board log/snapshot, resource metadata and verified bytes. Regenerate session secrets on the destination. Preserve creator/member device identity and existing visibility; removed/revoked members stay removed. Private one-to-one conversations are already host-readable and must retain that exact restriction on the new host.

Required deterministic tests: unauthorized delegation, copied public key, wrong CLAN, expired/revoked grant, replayed transition, stale epoch, equal-epoch conflict, old-host restart after relinquishment, candidate restart during staging, crash before/after every durable step, corrupted checkpoint/file, omitted data, simultaneous handoffs, partition during transfer, and old/new hosts refusing conflicting writes. Cross-device evidence must prove one writable host, durable history and files, preserved permissions, and truthful unavailable state. No feature may advertise successful durable handoff until these gates pass.

## Notifications and Raise Hand

Join requests and raised hands are session-scoped authenticated events. Only the host sees the full pending roster; members see their own status. Raising/lowering a hand never grants presenting, file or hosting permissions. A removed member loses the ability to raise a hand. Deduplicate repeat events, bound rates, clear hands on leave/end, and keep notifications local with privacy-preserving text. Background mobile notices require OS permission; no push service is added.
