# Restructure Phase 2 — progress

Notes and execution history.
Worktree / owner: `restructure_p2-q7m`

**Phase 2 complete (2026-10-10).** Merged and deployed; `executions.notes` dropped (migration 111). Step 6 stays deferred.

| Step | What | Status |
|---|---|---|
| 1 | Migration: `notes` table, sharing-aware RLS, target delete triggers, backfill of `executions.notes`, `last_completed_at` on items and intents, search functions, recent-completions function | done: `100_restructure_p2_notes_and_last_completed.sql` applied 2026-10-08, verified (4 notes backfilled, 96 intentions / 49 items with last_completed_at, 0 mismatches), CONFORMANT (52 tables) |
| 2 | Execution page: previous notes at top, note field open while running, note box on Complete; stop writing `executions.notes` | done: phone-tested 2026-10-09; both new notes saved as target_type intention with execution_id. Migration 100 checkpointed, db: claims released |
| 3 | `src/notes/` input and timeline (edit/delete, add on closed not archived); item detail timeline; intention detail history replaces `PreviousExecutions` (deleted) | done: phone-tested 2026-10-09 with all polish (grouped notes list, speech-bubble icon, "during an execution" link, caret-free completion cards) |
| 4 | List cards: last-done date and the open execution's notes | done: phone-tested 2026-10-10 with all polish (header links, note source icons, single notes layout) |
| 5 | Migration: copy any late `executions.notes`, then drop the column | done: applied 2026-10-10 after merge + Vercel deploy (run as `_pending_`, then numbered `111_restructure_p2_drop_execution_notes.sql`). Verified: column gone, 7 notes with execution_id across 7 executions, no duplicate author+run, 0 conformance failures; CONFORMANT (58 tables) |
| 6 | MCP tool descriptions (deferred; `mcp/index.ts` held by drive_mix-v7r) | deferred |

## Decisions (2026-10-08)
- `notes`: id, user_id (author), target_type, target_id, body, nullable execution_id, applied_at (unused until Phase 10), created_at, updated_at.
- Target is target_type + target_id, no FK. target_type in ('item', 'intention'). Deleting an item or intention deletes its notes (trigger).
- execution_id references executions with on delete cascade.
- Existing execution notes move to `notes`, targeted at the execution's intention. One place to write notes.
- Notes follow the record's sharing: whoever can see the target item or intention can read and add notes (EXISTS on items/intents, inheriting their RLS). Only the author edits or deletes. Registered `p_policy_mode => 'none'` with hand-written policies (contract case a).
- Notes can be added to closed records, not archived ones. Editing and deleting stay open to the author.
- `last_completed_at` on items and intents, owned by triggers: latest close time of a closed + done execution. Recalculates on execution insert, update and delete, and when an intention's item_id changes or it is deleted. An item counts executions linked both through `executions.item_ids` and through `intents.item_id` (0 mismatches on 2026-10-08).
- List cards show only the last-done date and the open execution's notes. The last three completed executions with notes appear on item and intention detail pages only.
- One timeline on item detail mixing general notes and execution notes.
- A new execution shows previous notes at the top; the notes field stays open while it runs; closing offers a note box only.
- `platform_search_items` also matches note bodies; `platform_search_executions` returns each execution's notes. No TypeScript change: both RPCs' rows pass straight through.
- Avoid `src/Alfred.jsx`, `supabase/functions/mcp/index.ts` and `tool-handlers.ts` this phase.

## Step 2 (2026-10-09)
- `src/notes/`: `notesApi` (list previous, list per execution, save = insert/update/delete-when-empty), `useExecutionNotes` (queued saves, saves on unmount), `PreviousNotes`, `CompleteNoteDialog`.
- The note box binds to the signed-in user's own note for the execution; other people's notes on it show read-only, marked "shared". Execution notes target the intention.
- Complete opens a note-only dialog, prefilled with the running note; a failed save keeps it open and does not complete.
- `storage.set`/`patch` never send `executions.notes` or `last_completed_at` (`withoutDbOwned`). `updateExecutionNotes` removed; `Alfred.jsx` still destructures and passes it (undefined, unused) — tidy when that file is claimed.

## Step 3 (2026-10-09)
- Item and intention detail, in order after the existing sections: Current execution (intention page; the item page's Executions badges) with its notes read-only; Recent completions (`alfred_recent_completions`, 3, item page names the intention); Notes timeline.
- Timeline: general and execution notes newest first, 100 max. Item page = the item's notes plus every intention whose item_id is the item (archived intentions included), each labelled "on the item" or with the intention's name.
- Add on any non-archived record (closed included); archived hides the input with the reason. Author edits inline (Save brown) and deletes (red outline, confirm); others' notes marked "shared", no buttons.
- `PreviousExecutions.jsx` and its test deleted; no references remain.

## Step 3 fixes (2026-10-09, after phone test)
- Recent completions: no "No note" line; each row opens that execution (fetched with `storage.get`, opened through `onOpenExecution`).
- A closed execution's page is read only: no Complete/Pause/Make Active/Delete, no element ticks, Start/Reset, notification edits, quantity edits or Edit item; header says "Completed <date> · read only". Notes stay writable (timeline for that execution). `useExecutionActions` refuses all six writers for a closed run (`writable`).
- Note controls follow the inbox Original capture pattern: pencil and (red) trash icon buttons; Save brown with check, Cancel tan with X.
- Notes are white cards (`NOTE_CARD`, `src/notes/noteFormat.js`); open-run notes sit inside the teal/amber `ExecutionBadge` on a white inset (badge takes `children`).
- IntentionCard: a disabled Schedule turns tan and flat (was faded brown).
- Claimed for this: `src/executions/ExecutionBadge.jsx`, `ExecutionBadge.test.jsx`, `useExecutionActions.test.js` (new).

## Step 3 polish (2026-10-09)
- Recent completions are cards: ExecutionBadge's shape and execution glyph in neutral tan (`data-state="closed"`; no closed-execution card existed elsewhere), notes on the white inset inside, whole card opens the execution.
- Note icon: `note: StickyNote` added to `OBJECT_ICONS` (`src/shared/ObjectIcon.jsx`, claimed); on timeline cards, previous notes and shared notes on the execution page.
- Bug (SomeDay test 4): the note's execution_id was the paused run `mv1e3hktt3nkss925y`. The card loaded its notes once on mount, and leaving the execution page saves without waiting, so the card could read before the insert landed and never re-read. `notesApi` now announces every write (`onNotesChanged`); the card, the timeline and recent completions reload.
- Bug: completing or deleting a PAUSED execution left it in `pausedExecutions` until reload; `closeExecution` now drops it from both lists.

## Step 3 card styling (2026-10-09)
- Radius rule: `rounded-lg` (= `--radius`, 0.5rem / 8px) for cards and buttons, `docs/design-system/design-system.md` "Tokens". ExecutionBadge and Recent completions cards were `rounded` (4px); both now `rounded-lg`.
- Recent completions cards: white `bg-card border border-border rounded-lg shadow-sm`, like ItemCard.
- Notes inside a card (completions, open-execution badges) are plain `NoteLine`s led by the note icon at the header icon's size and gap; the white inset is gone. Timeline and Previous notes keep the white note cards.
- Open question: the design doc rejected `StickyNote` (capture source glyph) as too close to `File` at 14px; the note icon uses it. Resolved below.

## Step 3 notes as a list (2026-10-09)
- Note icon is `MessageSquareText` (`OBJECT_ICONS.note`), not `StickyNote`.
- Notes timeline, Previous notes and shared notes on the execution page are one grouped list: `NOTE_LIST` (white, card border, rounded-lg, `divide-y`) with unbordered `NOTE_ROW`s. No container when there are no notes.
- "during an execution" in a note's header is a link that opens that execution (read only when completed); nothing else on a note is tappable.
- Recent completions cards: no › caret; the whole card is the tap target, like item and intention cards.

## Step 4 (2026-10-09)
- ItemCard and IntentionCard meta line: "last done: <date>" from `lastCompletedAt` (already on the row via select *), only when set, before "last updated" (unchanged). `shortDate` in `noteFormat.js`.
- Open execution's notes on list cards: `CardExecutionNotes` — up to the 2 newest, one line each (`NoteLine oneLine`). ItemCard puts them inside its execution badges; IntentionCard below its meta line (from `actions.open`).
- One query per list: `useCardExecutionNotes` gathers every card's ask from the same render into one `execution_id in (...)` read (`listNotesForExecutions`), caches per execution, and refetches after any note write.
- No completions on list cards; no new buttons or carets.

## Step 4 polish (2026-10-10)
- One header link row, `src/shared/RecordLinks.jsx` (lifted from the execution header): context pill, intention, item, execution (icon only). Execution page, intention detail (context + linked item) and item detail (context) all use it. Intention detail's Linked Item card is gone.
- Note sources are RecordLinks icon links (item, intention, execution) in every note list, leaving out the page you are on (`sources.here`). "on the item" and "during an execution" wording is gone.
- Execution page notes sit below the steps under "Notes": this execution's one note (autosaving box), then the grouped list of every other note on the intention and its item, with sources. Same on a completed run. `PreviousNotes.jsx` and `listPreviousNotes` removed; `NoteList` shared from `NoteTimeline.jsx`.
- `Alfred.jsx` (claimed): item detail gets `onViewContextDetail`; the execution page gets `onOpenExecution` (switches runs without changing previousView); stale `updateExecutionNotes` removed.

## Step 5 (2026-10-10)
- 🛑 ORDER: the drop migration runs ONLY after this branch is merged into main AND Vercel has deployed it. Until then the live app writes `executions.notes`.
  1. Merge and push this branch; wait for the Vercel deploy.
  2. Run the migration's PRE-CHECK (dependent views, functions, late text, would-duplicate).
  3. gitsync, number the migration, run it, then its VERIFICATION and `check_platform_conformance`.
- Reference search (2026-10-10): nothing in `src/`, `supabase/functions/` (incl. `tool-handlers.ts`, `mcp/index.ts`, `notify-dispatch` selects only `id`), `scripts/` or tests reads or writes `executions.notes`. `storage.set`/`patch` strip it (`withoutDbOwned`). Only SQL reference: migration 100's one-off backfill. Live database functions and views are checked by the PRE-CHECK.
- `StatusEventsSheet.test.jsx` (claimed): expected date built with `formatEventDate`, so it no longer fails on the day it names.
- Done 2026-10-10: Alex ran the whole `_pending_` file after the Vercel deploy; it was then numbered 111 with a header saying so. Verification: `column_still_there` [], notes_with_execution 7, executions_with_notes 7, `two_notes_same_author_same_run` [], `conformance_failures` []. `check_platform_conformance`: CONFORMANT, 58 tables (the file's "52" predates other threads' tables).

## Later, not Phase 2
- Card rule: a bordered card is something you tap; content you read sits in a list.
- Breaks it: Money account cards carry a › caret, which other tappable cards do not.
- Breaks it: Removal history (collections) shows non-tappable rows as bordered cards.

## Data on 2026-10-08
127 executions: 126 closed + done, 1 active with no outcome. 4 have notes, all closed, none orphaned.

## Not in Phase 2
- Close-prompt changes beyond saving a note.
- Home's rebuild.
- Home quick-add and pinned items.
- Restyling the execution page beyond the notes area.
- The Phase 10 note scan.
- Merging items and intentions into one list.
- Stars on close.
