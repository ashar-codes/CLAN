# Flashcards

Manual decks (general, or for a course / topic / exam). A card has a front, a back, an optional note and an optional
reference to a note, file or saved item (by id, never copied).

## Scheduling: SM-2
`sm2()` in `@classroom/protocol` (study.ts) — the same code on desktop and phone. Each card keeps an interval (days), an
easiness factor EF (starts 2.5, never below 1.3), successful repetitions in a row, and lapses.

| Button | SM-2 quality q | Result |
|---|---|---|
| Again | 2 | repetitions restart, lapse +1, interval 1 day; shown once more in 10 minutes |
| Hard | 3 | pass |
| Good | 4 | pass |
| Easy | 5 | pass |

On a pass: interval = 1 day (1st), 6 days (2nd), then round(previous × EF). Always EF' = EF + (0.1 − (5 − q)(0.08 + (5 − q)·0.02)).
The review buttons show the interval each answer will produce, so the schedule is never a black box.

## Storage
`flashcards_cards` holds the current state (due date, interval, EF, reps, lapses). Every answer is appended to
`flashcards_reviews` (time, grade, interval before/after, EF, due date) in the same transaction, so the history explains
the schedule. Reviews are personal and offline.

## Performance
The review queue loads only cards due now (indexed by `deck_id, due_at`, max 200); “N cards due” is a single count query;
deck lists return counts, not cards; card lists are paginated.

## Review UI
Keyboard: Space/Enter flips, 1–4 grade. Touch: tap the card, large grade buttons. Screen readers: the card is a button
whose label is the question or the answer, and a polite live region announces each change.
