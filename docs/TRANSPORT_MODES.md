# Transport modes (Milestone 2.75)

Two independent axes (`packages/protocol/src/network.ts`):

| Axis | Values | Today |
|---|---|---|
| **connectivity** — how devices reach each other | `lan` (existing Wi-Fi/router/Ethernet), `direct` (Windows Wi-Fi Direct AP), `mesh_experimental` | `lan` implemented; `direct` interface only (Milestone 3); mesh research only |
| **distribution** — who serves official data | `teacher`, `peer_assisted` | both implemented |

Named presets: **TEACHER_SERVER** / **LAN** = lan + teacher · **PEER_ASSISTED** = lan + peer_assisted · **DIRECT** = direct +
(either distribution once Milestone 3 exists) · **MESH_EXPERIMENTAL** = documentation only.

The **control plane is the same in every mode**: teacher-authoritative, pinned HTTPS/WSS, teacher signatures.

## Boundaries (`packages/client/src/transports.ts`)

| Interface | Implemented by | Notes |
|---|---|---|
| `ResourceTransport.acquire(resource)` | `PeerAgent` (desktop/Node), mobile `download()` | files never call "download from teacher URL" directly |
| `EventTransport` | `ClassroomConnection` (pinned WSS) | future peer relay may only forward teacher-signed commands |
| `PeerDiscovery` | teacher tracker + cache | hints only; identity from endorsement + pin |
| `MediaTransport` | — (placeholder) | Milestone 4 decides: teacher SFU, relay peer(s), multi-relay |
| `ConnectionHealth` | `ClassroomConnection` quality/RTT | student sees Excellent/Good/Poor/Disconnected |

## Switching

Session state (class, members, resources, ids, assignments, receipts) is independent of the transport. Implemented now:
**Teacher Server ↔ Peer-Assisted** at any time from the teacher's Network panel (`class.peerAssist`). Downloads in progress keep
verified progress across the switch (swarm → stream keeps the verified contiguous prefix; stream → swarm adopts every whole chunk
after hashing). Direct ↔ LAN switching comes after Milestone 3 (it changes connectivity, not the session).

## Recommendation (experimental)

`recommendDistribution({students, largestResourceBytes, teacherBytesPerSec})` drives a hint in the teacher's Network panel:
small class (< 8) or small files (≤ 4 MB) → teacher only; otherwise peer assistance, with an estimate from the measured teacher
rate when available. Labelled experimental; it is not a guarantee and ignores airtime effects (PEER_ASSISTED_MODE.md).
