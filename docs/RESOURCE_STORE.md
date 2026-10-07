# Resource Store

`packages/clan/src/core/resources.ts`. Content exists once; everything else holds a reference.

* **Object** (`resources_objects`): `id`, `sha256` (unique), `size`, `mime`, `location`, `origin`.
  * `store`: copied into `<userData>/storage/objects/<aa>/<sha256>` via temp file + re-hash + rename. The user's original file is
    never moved or deleted.
  * `adopted`: an existing classroom file registered **in place** (`storage/resources/<id>`), so the classroom server keeps
    serving it with its own manifest, chunk hashes and Range/resume. No bytes are copied.
* **Reference** (`resources_refs`): `(module, entity, entity_id, scope)` → object, plus an optional display name. Unique per owner
  + scope, so repeated adds are idempotent. Scope is `personal` (owner) or `clan`.
* **Dedupe**: `put()` hashes first; equal SHA-256 → the existing object. Safe because identity is the full hash and objects are
  immutable. Legacy duplicate files already on disk stay where the classroom expects them.
* **Sharing** a file into a CLAN creates a new ref to the same object (`Files.share`).
* **Removal** deletes the ref; objects with no refs are reported by `orphans()` (adopted files are never deleted by CLAN).
* **Integrity**: `verify(objectId)` re-hashes the stored bytes. Classroom manifests and SHA checks are untouched.
* Not yet: automatic GC of orphaned `store` objects, quotas.
