# CLAN Intelligence

A permission-aware study layer over the student's own material — not a general chatbot. Everything it suggests is a
**proposal**; nothing in Notes, Courses, Tasks, Exams, Flashcards, Reminders or Study Sessions changes until the student
accepts, and then the owning module applies it.

## Layers (`packages/clan/src/modules/ai`, shared core in `packages/protocol/src/ai.ts`)
| Boundary | Where | Job |
|---|---|---|
| AIProvider | protocol `ai.ts` | text generation, JSON output, optional embeddings, streaming, cancellation, usage. Injected by the host (`openClan({ aiProvider })`) or absent |
| AIContext | `context.ts` | which sources a request may use: built only from module public APIs called as an agent principal (AI_CONTEXT.md) |
| Retrieval | `retrieval.ts` + `extract.ts` | local, rebuildable knowledge index (FTS5/BM25; optional vectors) |
| AIProposal | `proposals.ts` | typed suggestions, validated on creation and on acceptance, applied by owning modules |
| AIConversation | `index.ts` | local conversation turns (question, answer, citations); deletable in Me › AI |

No product module imports a provider; changing providers touches nothing in Notes/Courses/Chat/Exams/Flashcards/Saved.

## Experiences
| | Where | What happens |
|---|---|---|
| Ask CLAN | top bar, Guide lamp, Course, Search results, Saved | defaults to the current place (course / exam / everything); context preview; streamed, cited answer |
| Ask this document | course Resources | one file; page-referenced |
| Explain / Simplify / Summarize / Turn into questions / Generate flashcards | Notes editor | result is a preview: Insert, Append, Create new Note, or close (discard); Save stays explicit |
| Compare My Notes | Notes editor | missing concepts / conflicts / covered, each cited; proposals: add a section, create a checklist task; Ignore all |
| Quiz Me | Course, Exam Coach | mcq / short / true-false, graded locally, explanations cited; weak topics become *suggested* mark changes |
| Draft flashcards | Course, Exam Coach, note | drafts → edit / untick / Accept → Flashcards creates only accepted cards (note “Drafted with CLAN from …”, ref to the source) |
| Prepare Lecture | course Lectures | summary, concepts, definitions, details, questions, cards, checklist from linked material; each piece accepted separately; says no recording/transcript exists |
| Past-paper analysis | a file marked Past paper | numbered questions found in the text layer with page; topic suggestions (AI, else word match) the student confirms; confirmed topics → “Add to exam scope” proposal |
| Exam Coach | Exam Command Center | gaps from explicit data (marks, sessions, confirmed paper questions); study plan proposal (Accept / edit minutes, untick / Dismiss); quiz; cards; explain a topic |
| Summarize discussion | chat header | only messages this person can read in that conversation |

## Grounding and citations
Sources are numbered `[S1]…` and sent fenced as untrusted data. Answers come back in two sections — **From your CLAN
material** (every paragraph must cite a given source; paragraphs without a valid citation are dropped into “left out:
not supported by your sources”) and, only if the student allows general knowledge, **General explanation · not from your
material**. `NOT_FOUND` → “Not found in your selected CLAN material.” Structured outputs (cards, quiz, comparison, lecture,
plan) keep only items with valid citations. Citation labels: `Lecture 6.pdf · page 14`, `My Note: Deadlocks`,
`OS Study Group · Ali · message`, `Past Paper 2025.pdf · Q3 · page 2`, `Diary · 2027-03-09`; each opens its source.

## Proposals and agents
Kinds: CREATE_FLASHCARDS, CREATE_TASKS, CREATE_REMINDERS, CREATE_STUDY_PLAN, APPEND_NOTE, UPDATE_TOPIC_CONFIDENCE,
ADD_EXAM_SCOPE (zod schemas in protocol). A proposal has the data, its source citations, an explanation, 14-day expiry.
Acceptance (user principal only) re-validates — including the student's edits — and runs the owning module's API in one
transaction; a failure applies nothing. The model never emits commands: the code chooses what to propose.
Agents (`agents.ts`) are constrained definitions: name, read capabilities, allowed proposal kinds, provider/model, owner,
and explicit “cannot” list. Built-ins: Guide, Note Coach, Quiz Master, Lecture Prep, Past-paper Analyst, Exam Coach
(no Diary, no chats, no unrelated courses, no writes). No background agents exist.

## Offline / no provider
Without a provider (or offline), generation says “Connect an AI provider…” / “AI model unavailable offline”, and the same
request still returns the retrieved passages (local search). Study, search, extraction and past-paper question finding
work offline. A future on-device model plugs in as a provider with `caps.local = true`.

## Streaming, cancel, errors
Text answers stream; Cancel aborts the provider request. A cancelled, timed-out, rate-limited, offline or invalid
(structured output retried once) run creates no proposal and saves no turn. Student data is never touched by a failure.

## Performance (`node tools/sim/bench-ai.ts`, M-series laptop)
40 text PDFs × 20 pages + 100 notes: first index 0.54 s → 141 sources, 901 passages, 452 k chars; whole device DB 1.8 MB;
retrieval (incl. permission re-check of every candidate) 8 ms. Indexing is incremental (one primary-key lookup per
unchanged source). Renderer: AI UI is a lazy chunk (Sheet 19.5 kB, Settings 4.7 kB); eager entry points +4.9 kB
(main chunk 372.5 → 377.4 kB, +1.4 kB gzip). PDF.js loads only in the main process on first extraction.
Storage is bounded: 60 MB per file, 400 k chars / 400 chunks per source, 12 passages / 14 k chars per request; entries
unused for 60 days are dropped (they re-index on demand); Me › AI › Rebuild index clears it.
