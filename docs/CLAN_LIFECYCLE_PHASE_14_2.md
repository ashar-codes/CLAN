# CLAN lifecycle boundaries

## Local archive and restore

An appended `clans` migration stores archive preferences keyed by CLAN and local user. It changes only list
presentation on this device. Canonical CLAN identity, membership, files and permission queries remain intact.
An archived CLAN stays readable and can be restored. This preference is not a global host-authorization or personal
cloud-sync event. The old canonical archive operation for ended Temporary CLANs retains its original meaning.

## Member leave

Desktop/mobile provide a separate Leave membership action with confirmation; the existing session-exit action still
disconnects without deleting membership. Only the local member may leave; owners are rejected before network work.
The local membership becomes `left`, session downloads/peer activity stop, and desktop forgets this CLAN's reconnect
routes while preserving receipt anchors and signing identities. New paired-session records retain the authenticated
canonical CLAN ID (optional for existing profiles), so offline leave clears only the correct CLAN's routes.

`POST /api/member/leave` accepts a canonical CLAN ID and authenticated member token. The host verifies approval and
CLAN match, then invokes the existing removal path for the caller only. Pending members, hosts, wrong CLANs and
caller-selected member IDs are refused. This revokes the token, socket, peer and media rights; retries with the old
token are unauthorized. A subsequent join uses the existing pairing/approval policy.

UI wait is bounded to five seconds so an unavailable host cannot trap a local leave. Desktop aborts its HTTP request;
the mobile native request may finish later within its existing transport deadline and can only revoke the caller.
Failure/delayed acknowledgement is explicitly shown as **remote revocation unconfirmed**, never a promise that the
offline host revoked rights. An offline room's Leave action has the same local-only warning. Private study data and
stored copies are retained; leave does not claim to erase files already downloaded.

## Remaining actions (implementation pending)

The core cleanup foundation is implemented, but destructive controls are **not exposed yet**. An appended migration
records authorized remove/delete intent, candidate object IDs and completion separately. Pending intent fences reads,
membership restoration and host capabilities; owner deletion cannot be undone by startup classroom imports. Only a
completed member-copy removal may be cleared by the authenticated join coordinator. The composition root calls each
module's scoped cleanup API in one transaction. Private notes/Saved items, personal boards and other CLAN references
survive. File references used by personal Courses (including archived Courses) retain their stable IDs in Personal Space.

Owned object collection uses exact hash-store paths, refuses referenced or in-flight content, and is retryable after
unlink-before-metadata crashes. Adopted classroom objects still require server-owned cleanup and preservation of
referenced bytes. Cleanup completion must wait for host/download cleanup; clearing projections is not physical erasure.
The implementation also rechecks file-sharing membership at publication after asynchronous storage.

* **Remove local copy:** confirmation must describe exactly which local cached CLAN data is removed. Modules remove
  their own rows through public APIs; the resource store releases scoped references and preserves blobs referenced
  by personal data or another CLAN. Externally exported files are not CLAN's cache. Never delete personal courses,
  notes, Diary, signing keys or another CLAN. Do not call hiding a list row removal of the stored copy.
* **Owner delete:** require local owner authorization and explicit confirmation, stop an owned live host, record a
  durable deletion marker before cleanup, and prevent startup imports from recreating the deleted CLAN. This device
  cannot erase offline copies on other devices or claim a global deletion acknowledgement.
* **Last copy:** there is currently no verified durable replica registry. Warn that this device may have the only
  copy. Removal of the sole authorized host cannot be offered as retaining availability. A future handoff requires
  a verified durable receipt and fencing, as specified in [hosting design](PHASE_14_2_HOSTING_DESIGN.md).

Controllers coordinate lifecycle through domain interfaces. Visual components receive state and invoke authorized
actions; they do not delete database rows or choose arbitrary filesystem paths. Failed cleanup must be resumable and
must not re-enable deleted authority. These gates must be covered before exposing destructive controls.
