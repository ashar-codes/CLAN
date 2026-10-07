# Events

`packages/clan/src/core/events.ts`. Each event: `id` (UUID), `type`, `version` (schema version), `producer`, `ts`, `payload`
(validated by a zod schema on publish). Stored in `core_events` in the producer's transaction.

* **Producers never call consumers.** Consumers subscribe at the composition root.
* **Persistent consumers** (`{ persistent: true }`) record `(consumer, event_id)` in `core_consumed` in the same transaction as
  their effect: a crash or failure rolls both back and `deliverPending()` (run at startup) retries; nothing applies twice.
* **Versioning**: a new shape gets a new version with `upcast: { from, up }`; readers decode older stored events through it.
  An event that cannot be decoded fails loudly.
* **Payloads carry ids, not content.** Consumers read content through the producer's public API (and permissions).
* No broker: in-process bus over SQLite.

| Event | v | Producer | Payload | Consumers |
|---|---|---|---|---|
| ResourceAdded | 1 | resources | objectId, sha256, size, origin | — |
| ResourceShared | 1 | files | refId, objectId, scope, by | — |
| CLANCreated | 1 | clans | clanId, type, createdBy, importedFrom? | home activity |
| MemberJoined | 1 | clans | clanId, userId, role | home activity |
| NoteCreated / NoteUpdated / NoteShared | 1 | notes | noteId (+ ownerId / clanId, shared) | search (`search.notes`) |
| SavedItemAdded / SavedItemChanged / SavedItemShared | 1 | saved | itemId (+ …) | search (`search.saved`) |
| ReminderCreated | 1 | reminders | reminderId, ownerId, dueAt | — |
| ExamCreated | 1 | exams (contract) | examId, ownerId, at | — |

Diary produces no events.
