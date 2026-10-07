# Privacy model

**Scopes**: every readable thing is in a person's **Personal Space** (`personal`, owner only) or a **CLAN** (`clan`, active
members only; removed members and expired TEMPORARY CLANs lose access at once). `Permissions.canRead` is the single check.

| Data | Default | How it becomes shared |
|---|---|---|
| Notes | private | owner shares into a CLAN with the `notes` capability → `notes_shares` reference (live, revocable) |
| Saved items | private | owner shares into a CLAN → `saved_shares` reference |
| Files | private or the CLAN they were added to | new Resource Store ref per scope |
| Reminders, study data | private | never shared |
| Diary | private | **never**: no sharing, no search, no events with content, agents refused |
| Classroom history | the CLASSROOM CLAN's members | existing classroom rules still apply on the wire (assignments are teacher-only) |

**Search** (`search_docs`) is a projection filtered by the caller's scopes at query time; Diary can't be registered. Rebuildable.

**AI Context API** (`core/context.ts`; boundary only: no providers, no agent execution):
* An agent is a principal acting **on behalf of** one user with explicit scopes (`notes:read`, …). Missing scope → DENIED.
* Results are references + short excerpts the user could read anyway; every item's scope is re-checked.
* Diary is `private`: **DENIED** unless the user grants `ai → diary` (Me → Privacy). Grants can expire and are revocable.
  Even granted, only the owner's entries are returned.

Writes are user-only: agent principals cannot create or modify notes, saved items, reminders or diary entries.
