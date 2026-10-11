# CLAN lifecycle boundaries

## Local archive and restore

An appended `clans` migration stores archive preferences keyed by CLAN and local user. It changes only list
presentation on this device. Canonical CLAN identity, membership, files and permission queries remain intact.
An archived CLAN stays readable and can be restored. This preference is not a global host-authorization or personal
cloud-sync event. The old canonical archive operation for ended Temporary CLANs retains its original meaning.

## Remaining actions (implementation pending)

* **Leave:** only an active member may leave. The owner cannot leave while retaining the sole hosting authority.
  The local membership becomes `left`; personal data is retained. A live-session leave must revoke the caller's own
  host token and peer role through an authenticated operation, then disconnect. Offline leave cannot promise remote
  revocation while the host is unavailable. A subsequent join goes through the existing pairing and approval policy.
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
