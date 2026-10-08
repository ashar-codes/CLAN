# AI context: what CLAN may use

Every request names **user, action, scope, allowed source kinds and explicit selections** and runs as an **agent
principal** `{ agentId, onBehalfOf: user, scopes }` where scopes = the agent's read capabilities ∩ what the student
included. Sources are collected only through module public APIs (`notes.get/mine/inClan`, `files.get/list`, `saved.get`,
`chat.localThreads/localPage`, `courses.*`, `exams.get`, `tasks.list`, `flashcards.dueCount`, `ContextBroker` for Diary),
so each module's own permission rules apply. The AI layer never reads another module's tables. Candidates are recomputed
on every request: unsharing, removal from a CLAN or a revoked grant take effect immediately.

## Scopes
global · course (+topic) · lecture · exam · note (+ course/lecture for Compare) · resource · saved · clan (+thread) · search
results. Source kinds: My notes, Files, Saved material, Classroom material, Chat, Study data, Diary.
Defaults: everything except Chat and Diary. Explicit choices are remembered per scope kind — never Diary.
The preview (Guide › “Sources CLAN will use”) shows counts and examples per kind before anything is sent.

## Rules
* **Cross-CLAN**: only CLANs the person is an active member of; a request for another CLAN yields no sources.
* **Diary**: DENIED unless the explicit, unexpired `ai → diary` grant exists AND the student ticks Diary for that request;
  the answer is then marked “Diary included”. Global AI being on never includes it. Exam Coach and the other study agents
  cannot read it at all.
* **Direct chat**: only conversations this device's person participates in (`localThreads`). The host's relay copy of
  other people's direct conversations is never AI context. A named thread limits the request to that thread.
* **Saved links**: only what CLAN holds — title, address, source and the student's own note — labelled “link only”.
  CLAN never claims to know a video's or page's contents.
* **Files**: one index entry per canonical Resource Store object (SHA-256), however many places reference it; the
  current request may use it only if one of its references is readable by this person.
* **Prompt injection**: source text is fenced as untrusted data (tag-breaking removed), the rules come first in a single
  system message, the model has no tools, outputs are parsed against schemas, citations must point at given sources,
  and only the agent's allowed proposal kinds can ever be created — by code, not by the model.
* **Budget**: at most 12 passages / 14 k characters per request (4 per source; 10 for a pinned document).

## Future AI boundary
`Agenda.courseContext / lectureContext / examContext / studyContext` remain the reference-only inputs for later agents.
