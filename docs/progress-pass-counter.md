# Progress: Pass Counter

## Status: M1 through M4 part 1 verified. M4.5 implemented, awaiting verification.

Spec: `docs/technical-spec-pass-counter.md`

Stop after each milestone and wait for human verification before starting the next.

---

### M0 — Database migration (human runs this, not the CLI)
- [x] Run `2026-09-14-sam-passes.sql` in the Supabase SQL editor
      (the file is at `docs/2026-09-14-sam-passes.sql`, not `docs/migrations/` —
      the spec and this file both cite the wrong path)
- [x] Confirm `check_platform_conformance` returns CONFORMANT
- [ ] CLI confirms `sam_passes` is visible from the app's Supabase client
      — not independently confirmed; the first M1 verification step below is
      what proves it, since a missing or unreadable table shows up there.

### M1 — Pass detection and write
- [x] Locate the playback transport's end-of-range event; identify where a loop
      cycle restarts, and confirm the event fires once per cycle
- [x] Add pass-eligibility state: set when playback starts at the first measure of
      the loaded range; cleared by stop, reset, and any seek or scrub; NOT cleared
      by pause
- [x] On end-of-range with eligibility intact, insert a `sam_passes` row with
      `song_id`, `snippet_id` (null for whole song), `session_id`, and the current
      `bpm`
- [x] Re-arm eligibility immediately for the next loop cycle
- [x] Write fails must not interrupt playback — log and continue
- [x] Notes on what the transport event actually turned out to be:

      There is no single named "end of range" event — there are two, and they
      are the same geometric instant reached through different branches of one
      `if` in `ScrollEngine`'s requestAnimationFrame loop
      (`src/sam/components/ScrollEngine.jsx`). The condition is
      `copy1ScreenX <= targetX`: ScrollEngine lays the score out as three
      identical copies side by side, and the range is finished exactly when the
      *second* copy's first measure reaches the target line.

        - Looping (`loop === true`, i.e. any snippet, or whole-song repeat on):
          the engine teleports the scroll back by one copy width, increments its
          internal `loopCount`, and calls `onLoopCount(loopCount)`. That is the
          per-cycle event. It fires once per cycle, and `loopCount` increments by
          exactly one each time, so `n > 0` is one completed playthrough.
        - Not looping (`loop === false`, whole song with repeat off): the same
          branch instead cancels the animation frame and calls `onEnded()`, once.

      The two are mutually exclusive — the non-looping path returns before the
      increment — so wiring both cannot double-count. `onLoopCount(0)` is also
      emitted when a run initialises; that is the arming signal, not a
      completion, which is why only `n > 0` credits.

      Two wrinkles that shaped the implementation:

      1. `onLoopCount` is captured inside ScrollEngine's scroll effect, and that
         effect's dependency list does not include the callback. A
         `handleLoopCount` whose identity changed mid-playback would therefore
         never be called again. `handleLoopCount` has to stay referentially
         stable, so the song, snippet and bpm used to build the row are read
         through `passContextRef` rather than closed over. This is also what
         makes the row carry the tempo at the finish line rather than at the
         start, per spec rule 7.
      2. That same effect *does* depend on `bpm`, `timingWindowMs` and
         `audioElement`, so changing one of those mid-playback restarts the
         scroll and resets ScrollEngine's internal `loopCount` to 0. Across one
         sitting the sequence can read 1, 2, 3, 0, 1. Crediting on
         `n > 0 && n !== lastLoopCount` counts that trailing 1 as the new cycle
         it is.

      Also worth recording: when a snippet (or whole-song repeat) has rest
      measures configured, those rests are appended to `activeMeasures` and are
      part of the looped copy. The teleport therefore fires after the rests, not
      at the last musical measure. The count is identical either way — one credit
      per cycle — but the increment lands a beat or two later than the final
      note. Detecting the last musical measure separately would mean a second
      source of truth racing the teleport's beat-event reset, which is not worth
      it.

- [x] Eligibility also cleared when the loaded range changes (snippet selected,
      cleared, or Full Song) and when a different song is loaded

### M1.5 — Every practice run is attributable
Scope change out of M1 testing. The Apply fix stopped saved snippets being
loaded anonymously, but left ad-hoc ranges unattributable for good. Close the
hole instead of displaying it.

Auto-save on Play:
- [x] Play ensures a `sam_snippets` row exists for the active range before
      playback starts, when the range is not the full song
- [x] Look for a matching saved snippet FIRST and adopt its id — never create a
      duplicate. Identity is start measure, end measure, rest count, hand mode
- [x] Only create when nothing matches; title from the existing auto-title logic,
      no prompt and no input
- [x] Archived snippets are not searched for a match
- [x] A failed save logs and plays on — playback never blocked

Removing Apply:
- [x] Determine whether the score redraws on measure-input change or only on
      Apply. **Finding: only on Apply.** The inputs wrote to SnippetPanel's local
      `startMeas`/`endMeas` state (committed on blur); the displayed range comes
      from SamPlayer's `snippet` state, which only changed when `onSnippetChange`
      fired — from Apply, Save, Save New, or clicking a saved snippet. Typing in
      the inputs changed nothing on screen until Apply was pressed.
- [x] Make the measure inputs drive the displayed range directly, BEFORE removing
      the button
- [x] Remove the Apply button
- [x] Clicking a saved snippet still loads its range into the inputs and displays
      it (unchanged — `handleLoadSnippet` already did both)

Must not regress:
- [x] Full Song stays a distinct state; playing the full song creates and selects
      no snippet, not even one spanning every measure
- [x] Whole-song passes still write a null `snippet_id`
- [x] `sam_sessions.snippet_id` populates for auto-saved ranges

### M1.6 — Remove Save; verification-file cleanup
- [x] Remove the Save button and `handleSaveUpdate` — overwriting a snippet row
      in place retroactively rewrites every `sam_passes` and `sam_sessions` row
      pointing at that id
- [x] Keep Save New for banking a range without playing it
- [x] Save New uses the same match-first path as auto-save (`ensureSnippetSaved`),
      so it adopts a matching snippet instead of inserting a duplicate
- [x] Check for orphaned state left by the removal — none beyond the button's own
      `snippet?.dbId &&` render gate; `saving` is still used by Save New and the
      `snippet?.dbId === s.id` test in the saved list is selection highlighting,
      not editing state
- [x] Confirm the removed path wrote nothing else: `sam_snippets.notes` and
      `.tags` are **not written by any code in the app** — not by the removed
      handler, not anywhere else. Nothing was dropped silently
- [x] Give the two verification SQL files globally unique query labels

### M1.7 — Panel refinements
- [x] Save New is hidden whenever the current range, rest count and hand mode
      match a saved snippet; shown only when no match exists
- [x] Uses `findMatchingSnippet` — the same identity rule as auto-save, not a
      second one
- [x] Label stays "Save New"; with the button gone on a match it always creates
- [x] Reappears the moment a defining property changes away from a saved
      combination, and disappears again when changed back
- [x] Full Song resets Start to 1 and End to the song's last measure, so the
      panel stops looking like a snippet is active — and the real measure count
      is visible
- [x] That reset emits nothing: no snippet created, none adopted, Full Song
      state intact, whole-song passes still write a null `snippet_id`
- [x] Blurring the reset inputs unchanged is also a no-op
- [x] Determine the saved list's current sort order. **Finding: already
      `created_at` descending** — the fetch asks for it (line 31) and the
      non-archived filter preserves it. No change needed to the fetch.
- [x] Fix the one place the invariant broke: restoring from the archive
      prepended an old snippet above everything newer until a reload

### M1.8 — Archive state is visibility, not identity
Bug found in M1.7 testing: archive a snippet, recreate the same range, press
Save New — a duplicate row was inserted, because matching skipped archived rows.

- [x] `findMatchingSnippet` no longer filters on `archived`; the caller chooses
      the candidate set, and a live row wins over an archived one when both exist
- [x] `ensureSnippetSaved` searches archived rows and RESTORES an archived match
      (`archived: false`) instead of inserting — same id, so existing
      `sam_passes` and `sam_sessions` history reattaches intact
- [x] `created_at` untouched, so a restored snippet returns to its original
      position under `newestFirst()` rather than jumping to the top
- [x] Fixed in the shared helper, so Save New and auto-save-on-Play are both
      covered — Play had the identical hole
- [x] A failed restore adopts the archived row's id anyway rather than falling
      through to the insert; a still-archived flag is cosmetic, a second row with
      the same identity is permanent history-splitting
- [x] Save New stays VISIBLE when the only match is archived (the panel passes
      its live-only list), and still hides when a live snippet matches
- [x] Restored rows move out of the panel's archived list into the live one
- [x] Existing duplicates reported and merge SQL written for manual review:
      `docs/sql/merge-duplicate-snippets-2026-09-15.sql`. Not run, not a migration

### M4.1 — Per-snippet numbers onto the snippet rows
M4 part 2 put them in a separate collapsible breakdown table. Wrong place: it
spent screen space reclaimed in M3.5 and M4 part 1, and put the numbers away
from the decision they inform. They belong on the rows you pick from.

- [x] Each saved-snippet row shows its passes and practice time, today and all
      time, on one line beside the title
- [x] Title stays readable (truncates) and the whole row still loads the snippet
      in one click — the numbers sit inside that same button, `pointer-events-
      none`, so there is no dead strip on the right
- [x] A single "today / all time" legend per list replaces the table's column
      headers, so the `a / b` pairs need no per-row labelling
- [x] Archived rows get identical numbers in identical format; the existing
      "View archived snippets" toggle stays the only filter, and an archived
      snippet with no history shows zeros rather than being dropped
- [x] Existing `created_at` descending order untouched — no reordering by
      practice
- [x] Breakdown disclosure, its table, and its persisted open state deleted
- [x] Kept its two good properties: no query until the snippet panel is open,
      and both lists capped with `max-h-48 overflow-y-auto` so a long list
      scrolls rather than growing the page
- [x] Whole-song block on the stats line untouched; zero still renders as 0;
      still one `ptDateKey`; reading still creates, adopts and selects nothing
- [x] Save New visibility, matching and restore-on-adopt all unchanged

### M4.2 — Snippet rows read like the whole-song line
M4.1's abbreviated right-aligned pairs (`6 / 41 passes`, `22m / 1h 5m`) with a
legend were over-engineered. Scrapped.

- [x] Each snippet row is its title followed by the same labelled figures, in
      the same wording, order and spacing as the whole-song stats line
- [x] Extracted `PracticeFigures`, used by BOTH sites, so the wording is written
      once and the two cannot drift
- [x] Left-aligned, flowing after the title; nothing right-aligned
- [x] Full labels: "Practice Time:", "Completed Passes:", "Today", "Total",
      "Today:", "Total:" — no abbreviations
- [x] Legend above each list removed; per-pair tooltips removed
- [x] Rows may be wide — titles no longer truncate, figures wrap rather than
      being cut off
- [x] Snippet "Total:" prints minutes below an hour and switches to
      `formatTotalHours` wording at an hour (`formatTotalHoursOrMinutes`).
      Whole-song line untouched
- [x] `formatMinutesCompact`, added for the scrapped layout, deleted
- [x] Unchanged: same format on live and archived rows, zero reads 0 and
      "0 minutes", whole row still loads the snippet, `created_at` descending,
      one `ptDateKey`, no query until the panel is open, lists still bounded,
      reading still creates/adopts/selects nothing

### M4.3 — Layout option D, and Back goes up one level
Chosen from a four-option static mockup (`src/mockups`, still present — Alex
deletes it). Three rows instead of five, and every figure names its own scope.

- [x] Row 1: Back / Play / Full Song / title / MIDI, with Export…Change Song at
      the right
- [x] Row 2: BPM / Tuning / Repeat / Speed / Metronome / Score playback, with
      **Practiced today 11 min** pushed right to sit under Change Song
- [x] Row 3: Loop / Hits / Misses / accuracies, then **This song** and its
      passes and practice time
- [x] Metronome and Score playback moved from the stats row to the settings row
      — still one click, still outside the collapsed Tuning group
- [x] Snippet rows use the same `PracticeFigures` as "This song", so the two
      cannot drift
- [x] `PracticeTimeIndicator` deleted; its old line was the source of the
      ambiguity
- [x] `usePracticeStats` now also returns `perSongTodaySeconds`, from the same
      single pass over the same fetched rows — no extra query
- [x] Back arrow goes to SAM's song library when a song is open; from the
      library itself it still goes to Alfred, which remains the only route out

### M4.4 — Chrome tidy-up
- [x] Back arrow hidden while playing; still one click from stopped, paused and
      the song library. Leaving mid-play now needs a pause first
- [x] "Change song" removed — the back arrow goes to the song library, so the
      two did the same thing. `handleChangeSong` renamed `handleBackToLibrary`
      and kept as the shared route out; `onChangeSong` dropped from
      `AudioToolbar` and `SettingsBar`
- [x] `pr-2` on "Practiced today" so its right edge matches the `px-2` toolbar
      buttons above it
- [x] Toolbar collapses in three tiers instead of wrapping
- [x] `LiveSessionCounter` relabelled "Practiced today" with `formatMinutesUnits`
      — the last place an all-songs figure wore a bare "Today:"

### M4.5 — Row overflow, and closing sessions on page hide
- [x] Transport row no longer wraps. The title is the one flexible element
      (`flex-1 min-w-0 truncate`, full text on hover); the action cluster is
      `shrink-0` and stays anchored right at every width
- [x] Settings row: segmented-control labels hide below 1280px first; the two
      controls are grouped so Score playback can never be orphaned on its own
      line
- [x] `ended_at` now written on page hide via `fetch(..., {keepalive: true})`
- [ ] The 28 existing orphans — diagnostic SQL written
      (`docs/sql/orphaned-sessions-2026-09-16.sql`), nothing run, awaiting Alex

### M2 — Playback screen counter
- [x] Find the existing "Today: xx minutes" component and its day-boundary helper
      — `LiveSessionCounter` (the playing-state display, rendered by
      `FocusedPlaybackBar`), bucketing on `ptDateKey` via `usePracticeStats`
- [x] Reuse that helper — `usePassCounts` imports `ptDateKey`; no second
      day-boundary anywhere
- [x] Render `Completed Passes: N` immediately to the left of the Today display
- [x] N is today's count for the loaded range (snippet if loaded, else song)
- [x] Count updates live on each pass, no refresh
- [x] Seeded from the database on load, so it never starts at zero after a
      morning's practice
- [x] Switching range swaps N to that range's count
- [x] Stop then Play leaves N at what was banked, and climbs from there
- [x] A range with no snippet yet reads 0, not blank and not a dash
- [x] Adopting or restoring a snippet on Play refetches, so N jumps to that
      snippet's real count instead of staying at 0
- [x] Reading counts never creates, adopts or selects a snippet; Full Song stays
      Full Song and whole-song passes keep writing a null `snippet_id`

### Pre-M2 — snippet delete now that `sam_passes.snippet_id` no longer cascades
- [x] Checked `Alfred.jsx`. Two paths: `recyclePermanentDelete` (single) and
      `recycleBulkDelete` (bulk), both in the Recycle Bin
- [x] **Both could already fail** — `sam_sessions.snippet_id` has always been
      RESTRICT, so a snippet with sessions already raised. The cascade change
      adds passes as a second trigger and makes it far more likely
- [x] Failures were never silent: both `throw` and `alert()`. The problem was the
      message — raw Postgres naming a constraint, with no hint to archive
- [x] `recycleDeleteErrorMessage` now translates 23503 into an explanation and
      points at archiving; the bulk message says how many rows are blocked and
      that nothing was deleted, since the delete is one statement

### M3 — Pause screen, whole-song passes
- [x] Insert `Completed Passes: Today N  Total M` between practice time and Today
      (in `PracticeTimeIndicator`, the stopped/paused display)
- [x] Count only rows where `snippet_id` is null — a loaded snippet's passes
      never appear in these numbers
- [x] Zero renders as the digit 0, not blank, hidden or dashed
- [x] Today uses the same `ptDateKey` boundary as M2; still only one of them
- [x] Total is lifetime, unbounded by date, fetched as a `head` count so no rows
      cross the wire however long the history gets
- [x] Current the moment playback stops — the numbers are incremented as each
      pass lands, not refetched on stopping, so nothing stale can be shown
- [x] Playing and paused agree across a stop: with no snippet loaded both read
      the same `songTodayCount` state, rather than two numbers that merely
      usually match
- [x] Reading counts still never creates, adopts or selects a snippet
- [x] M2's live counter unchanged in behaviour

### M3.5 — Density pass above the score
Layout only, ahead of M4 adding a row per snippet to the practice-time block.

- [x] Timing ±ms, Chord ms and Measure W moved behind a collapsible **Tuning**
      group, collapsed by default, remembered between sessions in localStorage
      (wrapped in try/catch — storage throws outright in some contexts)
- [x] BPM, Repeat, Speed, Loop/Hits/Misses/accuracies, Practice Time and
      Completed Passes, and every transport button all stay always visible
- [x] Metronome and Score playback are compact segmented controls instead of two
      groups of radio buttons — still one click per change, and narrow enough
      that the stats row stops wrapping
- [x] Neither went into the collapsed group
- [x] Fingering mode, Diff and Show Imported moved into SettingsBar's top-right
      cluster; their old row now renders only while fingering mode is on
- [x] No behaviour changes — same handlers, same values, same availability
- [x] App header investigated and left alone, per instruction

### M4 part 1 — Remove the app header
- [x] "Sam — Piano Practice" title and its header row deleted (~68px, the
      tallest row on the page)
- [x] Checked what else the header carried: nothing but the title and the back
      button — but the button's REACH was load-bearing. `onBack` appeared only
      there, and the transport row does not exist while playing or before a song
      is open
- [x] Back button preserved in all three states via a shared
      `BackToAlfredButton`: left of Play in the transport row, left of Pause
      while playing, and above the song library. Still one click everywhere

### M4 part 2 — Per-snippet passes and practice time
- [x] Each snippet shows its own passes, today and total, from rows where
      `snippet_id` is that snippet
- [x] Each snippet shows its own practice time, today and total, from
      `sam_sessions` filtered on `snippet_id`
- [x] Zero renders as the digit 0 in every cell — a snippet saved but never
      played reads 0 across the row
- [x] Today uses `ptDateKey`; still exactly one day boundary in the codebase
- [x] The M3 whole-song block is untouched and still counts only rows where
      `snippet_id` is null
- [x] Layout: compact table behind a collapsed-by-default disclosure, height
      capped and scrolling beyond it
- [x] Archived snippets appear only when they have practice history, labelled
- [x] Reading counts still creates, adopts and selects nothing

### M5 — Optional, only if M1–M4 are clean
- [ ] `get_sam_passes` MCP tool (tier 1, `defineTool`, `ctx.db`, `clampLimit`)
      so pass history is readable from chat when practice instructions are written

---

### Testing — M4.3
- [ ] Three rows above the snippet panel, arranged as option D
- [ ] "Practiced today" sits right, under Change Song
- [ ] "This song" figures share the row with Loop/Hits/Misses
- [ ] Snippet rows read identically to "This song"
- [ ] Back from an open song lands on the song library, not Alfred
- [ ] Back from the song library still reaches Alfred
- [ ] Metronome and Score playback still work, one click each

### Testing — M4.2
- [ ] A snippet row and the whole-song line read identically
- [ ] A zero-practice row reads Today 0, Total 0, Today: 0 minutes, Total: 0 minutes
- [ ] A snippet under an hour shows minutes in Total:, not "<1 hour"
- [ ] The whole-song line still shows "<1 hour" below an hour
- [ ] Rows still load on click, figures included

### Testing — M4.1
- [ ] Saved-but-never-played snippet reads 0 on its row
- [ ] Playing a snippet updates only that row, not the whole-song numbers
- [ ] Clicking a row still loads it
- [ ] Archived snippet with history shows its numbers
- [ ] Archived snippet with no history shows zeros, not hidden
- [ ] Breakdown section is gone

### Testing — M4
- [ ] Header gone; back button works from stopped, paused, playing, and the
      song library
- [ ] Snippet breakdown opens and shows one row per snippet
- [ ] A saved-but-never-played snippet reads 0, not blank
- [ ] Snippet numbers and the whole-song number stay independent
- [ ] Open/closed state survives a reload
- [ ] More of the score visible without scrolling

### Testing — M3.5
- [ ] Tuning group collapsed on load, expands to reveal the three inputs
- [ ] Collapsed/expanded state survives a browser reload
- [ ] Metronome and Score playback change in one click and still work
- [ ] Fingering mode sits in the top row and still toggles
- [ ] The old fingering row is gone when fingering mode is off
- [ ] More of the score visible without scrolling

### Testing — M3
- [ ] Paused/stopped screen shows `Completed Passes: Today N Total M` between
      Practice Time and Today
- [ ] Live counter and the paused Today number agree across a stop
- [ ] A song with no passes today reads Today 0 with a non-zero Total
- [ ] Snippet passes do not inflate the whole-song numbers
- [ ] A song never played reads Today 0, Total 0

### Testing — M2
- [ ] Play shows `Completed Passes: N` immediately left of `Today: xx minutes`
- [ ] N is seeded, not zero, after earlier practice the same day
- [ ] N increments live as passes complete
- [ ] Stop and Play again: N holds at what was banked, then climbs
- [ ] Switching between Full Song and a snippet swaps N
- [ ] A never-played snippet reads 0
- [ ] Play on an unsaved range that adopts an existing snippet jumps N to that
      snippet's real count
- [ ] Deleting a snippet with history explains itself and suggests archiving

### Testing — M1.8
- [ ] Archive a snippet, recreate its exact range, Save New — no new row, the
      archived one returns with its original id
- [ ] The restored snippet's earlier passes are still attached to it
- [ ] Same via Play instead of Save New
- [ ] Save New visible when the matching snippet is archived
- [ ] Save New hidden when the matching snippet is live
- [ ] Duplicate check returns zero rows with archived rows included

### Testing — M1.7
- [ ] Save New hidden on a saved combination, visible after changing hand mode,
      hidden again after changing it back
- [ ] Full Song resets Start/End to 1 and the last measure
- [ ] Full Song with reset inputs, repeat off, writes a whole-song pass with a
      null snippet id and creates no snippet
- [ ] Blurring the reset inputs without editing creates and selects nothing
- [ ] A new snippet with a LOW start measure still lists first

### Testing — M1.6
- [ ] Snippet panel shows Save New only — no Save button
- [ ] Save New on an unsaved range creates one snippet
- [ ] Save New again on the same range adopts it — no duplicate
- [ ] Editing a saved snippet's range no longer offers to overwrite it

### Testing — M1.5
- [ ] Type an unsaved range, press Play — it appears in Saved snippets, once
- [ ] Play that same range again — still ONE snippet, no duplicate
- [ ] Passes from an auto-saved range carry its snippet id
- [ ] Full Song run creates no snippet and writes a null snippet_id
- [ ] Editing a measure input redraws the score with no Apply press
- [ ] Opening the snippet panel on Full Song does not select a snippet

### Testing
- [ ] Loop a song 6 times with repeat on — reads 6
- [ ] Play 2, stop, restart, play 2 — reads 2 on restart, 4 at the end
- [ ] Start from a middle measure, play to the end — unchanged
- [ ] Pause mid-piece, resume, finish — increments by 1
- [ ] Complete a snippet — snippet count up, song count unchanged
- [ ] Complete the whole song — song count up, every snippet count unchanged
- [ ] Every written row has a non-null bpm
- [ ] Change tempo mid-pass, finish — row carries the finishing tempo

### Notes

#### M1 — verification round 1 (2026-09-14)

Confirmed working, by SQL against `sam_passes`:

- Looping credits one pass per cycle.
- Stop then restart banks the earlier passes rather than losing them.
- Stopping mid-cycle credits nothing.
- **Whole song with repeat off credits exactly one pass.** Recording this
  explicitly because it was briefly reported as broken and then retracted — the
  report was a misreading of a newest-first result set, not a defect. Nothing in
  this file ever claimed it was broken, so there was no wrong note to correct;
  this is the positive confirmation in its place. Every verification query in
  `docs/sql/verify-pass-counter-m1.sql` is sorted newest-first, and now says so
  in its header comment.

One real bug found: **playing a saved snippet credited nothing at all** — no
snippet row, no song row.

#### The snippet bug: what it actually turned out to be

Neither of the two things it looked like, though it is much closer to the first.

The hypothesis on the table was that the deliberate skip for snippets without a
database id was firing for saved snippets too, because the object the player
holds doesn't carry the saved id through to the credit path. That is exactly what
was happening — but the id was not being *lost* somewhere in the credit path. It
was never attached in the first place, by a button that predates this feature.

`SnippetPanel`'s **Apply** button built its snippet object with a hardcoded
`dbId: null`:

```js
function handleApply() {
  onSnippetChange({ startMeasure, endMeasure, restMeasures, handMode, dbId: null });
}
```

Apply is the primary-coloured button in the panel and is how a range gets loaded
for playback. Saving a snippet (**Save New** / **Save**) and loading one from the
saved list both do attach `dbId` correctly — but pressing Apply afterwards, which
is the natural "now make this the active range" gesture, replaced the loaded
snippet with an anonymous copy of the same range. From the user's side the panel
looks identical either way: same title, same highlight, same measures.

**The evidence that settled it**, rather than inference from reading the code:
`usePracticeSession.startSession` writes `snippet_id` from the same
`snippet?.dbId` the pass writer reads, and it has been doing so since long before
this milestone. Every `sam_sessions` row for the test song has `snippet_id` null
— including the 22:24:16Z session whose summary shows `loopCount: 2` with
four-beat playthroughs, i.e. two complete cycles of a one-measure range. So at
the moment Play was pressed, `snippet.dbId` was already falsy. The pass writer
behaved exactly as specified; it was handed an anonymous range.

That same evidence kills the second hypothesis outright: `loopCount: 2` on a
one-measure range proves ScrollEngine's end-of-range detection fires correctly
for a single-measure snippet. The geometry is fine.

It also means this was never a pass-counter bug. `sam_sessions.snippet_id` has
been silently null for every snippet practice session the app has ever recorded.
The pass counter is simply the first feature that made the omission visible.

**The fix** (`src/sam/components/SnippetPanel.jsx`): Apply now looks for a saved
snippet matching the range about to be applied and adopts its id. Identity is the
four properties `formatSnippetTitle` already treats as defining a snippet —
start measure, end measure, rest count, hand mode — so two snippets agreeing on
all four are the same snippet. No match means a genuinely ad-hoc range, which
still gets `dbId: null` and still earns nothing, as intended. Archived snippets
are not searched, since `savedSnippets` excludes them and archived means retired.

Side effect worth knowing: `sam_sessions.snippet_id` starts being populated
correctly from now on too, for free. Historic session rows stay null — they
record what was actually known at the time and are not being rewritten.

#### M4.5 — breakpoints were not the bug

The toolbar collapsed correctly and the rows still broke, which is the tell: the
tiers were fine, the row's flex model was not. `justify-between` plus
`flex-wrap`, with nothing in the row allowed to shrink, leaves flexbox exactly
one way to resolve an overflow — push the last item onto a new line. A longer
title made the left group wider, and the actions were what moved.

So this is not fixed by measuring. Measuring with a `ResizeObserver` would
compute what CSS can already work out, add a resize-driven re-render, and still
need something to give once the answer came back. What makes it reliable across
any title length is designating the flexible element: the title takes
`flex-1 min-w-0 truncate`, everything else takes `shrink-0`, and the row drops
`flex-wrap` entirely. `min-w-0` is the load-bearing half — without it a flex
item will not shrink below its content width, `truncate` never engages, and the
row overflows instead of ellipsing.

Breakpoints stay for the toolbar's three tiers, but their job has changed. They
are no longer guessing whether things fit — truncation guarantees that — they
are a coarse device-class choice about how much label is worth showing.

**What gives on the settings row: the segmented controls' text labels.** Hidden
below 1280px, not removed, with `title` and `aria-label` on the wrapper so the
control stays identifiable by hover and to a screen reader. That frees about
195px, which is what keeps the row on one line on a laptop. The two controls are
also wrapped in a single flex item, so if the row ever does wrap they move as a
pair — a wrap point between them is what put Score playback alone on a row.

#### M4.4 — the toolbar follows Alfred's approach, but not its conclusion

There is no shared component to reuse: Alfred's desktop nav is inline JSX in
`Alfred.jsx` over its `NAV_ITEMS` array, not an extracted widget. So this reuses
the APPROACH, point for point — Tailwind breakpoints rather than measurement or
`ResizeObserver`, the label `hidden lg:inline` so it is hidden rather than
removed, `title` and `aria-label` on the button so the accessible name survives
at every width, and the actions expressed as one array rendered twice rather
than two lists that drift.

It diverges on one point, deliberately. Alfred's own comment rules an overflow
menu out: "burying Sam behind a chevron is the one outcome worth avoiding."
That reasoning is about NAVIGATION — ten destinations that must each stay one
tap away. These are four rarely-used utility actions on a screen whose job is
the score, so below 640px they collapse into a single menu. Export and Audio are
not Sam. The menu is a native `<details>`: no open/close state to hold, no
outside-click handler to get wrong, keyboard accessible as it stands.

Tiers: `>= 1024px` icon and label; `640-1023px` icons only; `< 640px` overflow
menu.

#### M4.3 — what option D actually required

The mockup showed three rows. Implementing it needed four things the mockup did
not show, because the mockup omitted controls the real app has.

**Metronome and Score playback had to move.** The mock stats row held only
Loop / Hits / Misses / accuracies; the real one also carries both segmented
controls. Leaving them there and adding this song's figures would have pushed
that row to roughly 1700px and wrapped it — undoing the row D was trying to
save. They moved to the settings row, where they read as what they are:
playback settings, next to BPM, Tuning and Repeat. Estimated widths at 1500px:
settings row ~920px, stats row ~1330px. The stats row is the tight one.

**This song's practice TODAY did not exist.** `usePracticeStats` returned
all-songs today and per-song lifetime — which is exactly why the old line could
put "Today: 11 minutes" (all songs) beside "Total:" (this song). D needs a
song-scoped today, so `perSongTodaySeconds` now falls out of the same single
pass over the same fetched sessions. No extra query, no second day boundary:
still `ptDateKey`.

**A units-only formatter.** `formatMinutesLong` renders "4 minutes", which four
times per row is what made the earlier layouts unreadable. `formatMinutesUnits`
gives "4 min" and "1 h 5 min" — "min" and "h" are the only abbreviations in
these displays. `formatTotalHoursOrMinutes` and `formatMinutesCompact`, both
added for layouts since scrapped, are gone.

**`PracticeTimeIndicator` was deleted rather than edited.** Its single line WAS
the ambiguity; nothing about it survived.

#### Back walks up one level, not out

`onBack` used to leave SAM entirely from every state. It now depends on where
you are: with a song open it routes through `handleChangeSong` to the song
library, so leaving a piece to pick another one does not eject you from SAM;
from the library it still calls `onBack` and returns to Alfred.

That asymmetry is deliberate and load-bearing. The library is the top of SAM, so
if its Back also went to the library it would do nothing and Alfred would be
unreachable — the same dead end M4 part 1 nearly created by removing the header.
`BackToAlfredButton` is renamed `BackButton` and takes its title from the
caller, because it no longer always goes to Alfred.

**One place the old wording survives, deliberately.** The playing screen's
`LiveSessionCounter` still reads "Today: xx minutes" for the all-songs figure,
beside a range-scoped "Completed Passes" — the same ambiguity D removes
everywhere else. Option D's mockup covered only the stopped and paused chrome,
so it was left alone rather than changed unreviewed. The fix is one line in
`LiveSessionCounter`: relabel it "Practiced today" and format with
`formatMinutesUnits`.

#### M4.2 — one component, two call sites

The requirement was that a snippet row read exactly like the whole-song line.
Transcribing the labels into both places would satisfy that on the day and drift
the first time either changed, so the sequence — `Practice Time:`,
`Completed Passes: Today N Total M`, `Today: …`, `Total: …`, and the `gap-3` /
`gap-2` spacing between the parts — now lives once in `PracticeFigures`, and
both sites render it. It returns a fragment rather than its own row, which is
what lets a snippet row put the title first and flow the figures out beside it.

**The one deliberate difference is a prop, not a fork.** `totalMode="hours"` is
the song line: floored to whole hours, `<1 hour` below that, which is right for
something that accumulates hours. `totalMode="adaptive"` is a snippet row: the
same hours wording once an hour is reached, long-form minutes below it. Without
that, nearly every snippet would read `Total: <1 hour` for months and the figure
would carry no information at all.

The two formatters meet cleanly at the boundary — 59.98 minutes rounds to
"1 hour" through the minutes path, and 3600 seconds gives "1 hour" through the
hours path — so nothing jumps or repeats as a snippet crosses the hour.

**One asymmetry worth knowing about when reading the two side by side**, and it
predates all of this: on the whole-song line, `Today:` is the ALL-SONGS practice
aggregate while `Total:` is this song's lifetime — that is what
`usePracticeStats` has always supplied there. On a snippet row both figures are
that snippet's own. The wording is identical because it was asked to be; the
scope of the song line's `Today:` is simply wider than its neighbours. Worth
correcting one day, but it is existing behaviour and changing it was not part of
this milestone.

#### M4.1 — the format, and what survived the rewrite

**Format chosen: `6 / 41 passes` and `22m / 1h 5m`, right-aligned on the row,
with one `today / all time` legend above each list.**

A table gives four column headers for free; a list row does not. Labelling every
row (`6 passes today, 41 all time, 22m today, 1h 5m all time`) would be
self-explanatory and far too wide to sit beside a title. Writing the legend once
per list buys the same clarity for one line total, and every pair on every row
then reads in the same order. Tooltips on each pair spell it out for anyone who
wants it.

Passes carry the word "passes"; time carries its units (`m`, `h`), which is what
distinguishes the two pairs without a second label. Today's figure is emphasised
in both pairs because it is the one being decided on — "have I done my four
passes yet" is the question this panel exists to answer.

`formatMinutesCompact` was added to `practiceTimeFormat.js` for this. The
existing `formatMinutesShort` renders "0 minutes" and "25 minutes", which are too
wide beside a title and a pass count; `formatTotalHours` floors to hours and
would render nearly every snippet as "<1 hour". Same module, no new day
boundary — there is still exactly one `ptDateKey`.

**The row stays one click.** The numbers are rendered INSIDE the row's load
button rather than beside it, so the entire width still loads the snippet. They
carry `pointer-events-none`, without which they would become a dead strip on the
right of the row that silently swallowed clicks meant to load it.

**Archived rows are treated identically, and the filter question disappeared.**
M4 had the hook decide which archived snippets were worth showing — only those
with history. That rule existed because the breakdown was a separate list with
no other filter. The panel already has one: "View archived snippets". So the
hook now decides nothing about visibility, returns a plain lookup keyed by
snippet id, and the panel renders numbers for whatever it was already showing.
An archived snippet with no history reads 0 like any other, which is both
simpler and more honest than hiding it.

**What was kept from the deleted section:** laziness (no query until the snippet
panel is open) and a bounded height (`max-h-48 overflow-y-auto` on both lists,
so twenty snippets scroll rather than pushing the score off screen). What was
dropped: the sort by practice — the panel's `created_at` descending order is
deliberate and M1.7 established it.

One loose end, harmless: browsers that opened the M4 breakdown still hold a
`sam.snippetPracticeTable.open` key in localStorage. Nothing reads it now.

#### M4 — the header's hidden dependency, and why the block is a table

**Part 1: what the header was really holding.** Nothing but the title and the
back button, as reported in M3.5 — but the button's *reach* turned out to be
load-bearing in a way the contents list did not show. `onBack` and `ArrowLeft`
appeared ONLY in that header, and the header rendered in every state, while the
transport row exists in neither of two:

- **No song open** (the song library). Moving the button to the transport row
  alone would have left Alfred unreachable from that screen entirely — a dead
  end, not an inconvenience.
- **While playing.** `FocusedPlaybackBar` replaces `SettingsBar`, so leaving
  would have cost a pause first: one click becoming two, against the standing
  rule for this work.

So the button became a shared `BackToAlfredButton` rendered at the far left of
whichever control row is on screen — transport row when stopped or paused, the
playback bar while playing, and its own slim row above the song library. One
click from anywhere, which is what it was before.

One deliberate loss worth recording: the old header was `sticky top-0`, so the
back button stayed pinned while scrolling. Nothing is sticky now. That matters
less than it sounds, because the point of M3.5 and this milestone is that the
controls fit above the score without scrolling — but if scrolling does become
normal again, pinning the transport row is the fix.

**Part 2: why a table rather than the spec's stacked block.** The spec draws
each snippet as four lines — title, passes, today, total. That reads well for
one snippet and badly for six; a song with a dozen would push the score off
screen and undo M3.5 and part 1 in a single milestone. Four numbers per snippet
is tabular data, so the column headers are written once instead of being
repeated as a label on every row, which is most of the saving. One line per
snippet, ~22px.

It is collapsed by default, and lazy: `useSnippetPracticeSummary` does not query
at all until the block is open. Closed, it costs one 20px toggle row and zero
requests. The choice is remembered in localStorage, so wanting it open is a
one-time click. Height is capped at `max-h-40` with `overflow-y-auto`, so twenty
snippets scroll rather than growing the page — the failure mode this block would
otherwise have had.

**Which snippets appear: live always, archived only if they have history.**

Archiving answers "stop offering me this to play". It does not answer "pretend I
never practised it". This block is a practice-history readout, not a picker, and
an archived snippet with 41 passes is a real part of the record — hiding it would
make the numbers a lie by omission, and those passes appear nowhere else, since
the whole-song block deliberately excludes them. An archived snippet with no
history has nothing to say and stays hidden, so retiring a snippet does still
declutter this list. Archived rows are labelled `(archived)` so it is obvious why
something absent from the snippet picker is listed.

To change it, it is one predicate in `useSnippetPracticeSummary`: the `visible`
filter. Drop the `|| r.passesTotal > 0 || r.practiceTotalSeconds > 0` to hide
archived snippets outright, or drop the whole filter to show them all.

**Practice time is formatted with `formatMinutesShort`, not `formatTotalHours`.**
The per-song Total display floors to whole hours and renders anything under one
as "<1 hour", which is fine for a song and useless for snippets, where most
totals are minutes — every row would read "<1 hour". `formatMinutesShort` gives
"22 minutes" and "1h 5m" and already exists, so no new formatter was written.

#### M3.5 — the header answer, and what was actually costing the space

**The header belongs to SAM, not to the Alfred shell.** `Alfred.jsx` renders
`if (view === "sam") return <SamPlayer onBack={...} />` — an early return with no
wrapper and no Alfred chrome around it. The `<header>` holding "Sam — Piano
Practice" is inside `SamPlayer.jsx`'s own return. Nothing else uses it, and
changing it would affect only SAM. The one thing it carries besides the title is
the `ArrowLeft` back-to-Alfred button, which is the only way back from this
screen, so that has to survive whatever happens to the title. Left untouched
pending a decision.

**Where the vertical space was actually going.** Measuring the CSS rather than
guessing, on a ~1500px viewport with a song stopped:

| Row | Height | What M3.5 did |
|---|---|---|
| SAM header | ~68px | untouched, pending decision |
| Transport + title + MIDI + audio tools | ~52px | absorbed the score-tool buttons |
| Numeric settings | ~56px, wrapping to ~112px | three inputs collapsed; fits one line |
| Stats + metronome + score playback + practice time | ~24px, wrapping to ~48px | radios → segmented; fits one line |
| Snippet panel header | ~44px | untouched |
| Fingering-mode row | ~52px | gone unless fingering mode is on |

The single biggest win was the row that looked least important: the fingering
row rendered unconditionally while stopped, and almost always held nothing but
one right-aligned button. Moving that button (with Diff and Show Imported) into
the top row's right-hand cluster removes the row outright.

The two wrapping rows are the subtler win. Neither row was tall; both were
*doubling* because their contents overflowed 1500px. Removing three numeric
inputs (~390px) and shrinking two radio groups to segmented controls (~200px)
brings each back under the fold.

**Estimate: roughly 130–160px reclaimed** in the common case (fingering off,
Tuning collapsed) — about 52px from the fingering row and another 80–110px from
the two rows no longer wrapping. Two to four more staff lines, depending on
measure width. Worth confirming by eye rather than trusting the arithmetic,
since wrapping depends on the actual song title and MIDI device name.

**Segmented, not dropdown.** A `<select>` would have been narrower still, but
changing a value costs two interactions, and the rule for this pass was that
nothing reachable in one click may become more than one. The segmented control
keeps every option one tap away and is still much narrower than the radios.

**One thing worth knowing about "reachable while playing":** the metronome and
score-playback controls are not reachable during playback and never have been —
the whole StatsBar is unmounted while `playbackState === "playing"`, which is
what fixes each mode for the duration of a run (spec D5, and the reason the old
comment said so). M3.5 changed how they look, not when they exist. If they
should be adjustable mid-run, that is a behaviour change and a separate piece of
work.

#### M3 — how playing and paused are made to agree

The requirement was that the paused number be current the instant playback stops
— no stale count from whenever the screen last rendered — and that it match what
the live counter read. Two ways to do that: refetch on stopping, or never let the
numbers go stale in the first place.

Refetching on stop is the tempting one and it is worse. It races the session's
own `ended_at` write, it shows a brief wrong number while the query is in flight,
and it makes "do the two screens agree?" depend on timing.

So `usePassCounts` holds the song's today/total as state, seeded once per song
and incremented as each pass lands. With no snippet loaded the playing screen's
`rangeTodayCount` IS `songTodayCount` — the same state object, not a second
number derived the same way — so the two cannot disagree. Stopping renders a
different component around the same value.

**Which pass belongs to which counter is decided by the written row.**
`useSamPasses` passes the `snippet_id` it actually wrote to `countPass`, rather
than letting the counter read whatever range is currently loaded. A snippet pass
increments only the snippet's number; a whole-song pass increments the song's
today AND its lifetime total. This is what keeps snippet practice out of the
whole-song block, and it stays correct even if the loaded range changed between
a pass completing and its insert landing.

**The totals query is a `head` count** — `select("id", { count: "exact", head:
true })` — so the lifetime number costs one round trip and transfers no rows,
however many years of passes accumulate. Only the today window fetches rows, and
it is bounded to 48 hours; the exact day test is still `ptDateKey`.

**One layout note.** The spec draws the pause block as four stacked lines.
`PracticeTimeIndicator` is a single inline row today, so Completed Passes was
inserted into that row — between the "Practice Time:" label and Today, which is
the position the milestone asks for — rather than restructuring the component.
M4 adds per-snippet rows in this same block and is where a stacked layout would
naturally be decided, so that choice is deliberately left until then.

#### M2 — which "Today" this is, and the three-way range question

**Which display.** The spec has two: "Playback screen shows today's count only"
and a pause screen showing Today and Total. There are two "Today: xx minutes" in
the app to match — `LiveSessionCounter`, rendered by `FocusedPlaybackBar` while
playing, and `PracticeTimeIndicator` in the StatsBar while stopped or paused.
M2 is the first; M3's checkboxes describe the second. So the counter renders
while playing, and the count is *seeded* on load so it reads correctly the
instant Play is pressed rather than counting up from zero each sitting.

**The three-way range question, which is the part worth getting right.**
`snippet_id` being null means two completely different things:

| loaded | query | reads |
|---|---|---|
| Full Song (`snippet === null`) | `snippet_id is null` | the song's own passes |
| saved snippet | `snippet_id = <id>` | that snippet's passes |
| range never saved (`dbId` null) | no query at all | 0 |

Collapsing the first and third — the obvious `snippet?.dbId ?? null` — would show
the whole song's count against an unsaved range, crediting it with practice it
never had. `usePassCounts` distinguishes them explicitly. That third row barely
happens any more since M1.5 auto-saves on Play, but it is reachable between
typing a range and pressing Play, which is exactly when someone is looking at it.

**Reading must not write.** The hook only ever SELECTs. Resolving an unsaved
range to a snippet id just to count it would convert Full Song into a snippet —
the M1.5/M1.7 trap arriving a third time, through the back door. The count for an
unsaved range is 0 by construction, with no lookup.

**Incrementing on success, not on queue.** `useSamPasses` notifies only after the
insert lands. The number is a claim about what has been recorded, so a failed
write leaves it alone — the run genuinely banked nothing. The cost is that the
increment trails the last note by however long the insert takes.

**Effect deps are primitives** (`songId`, `snippetId`, `isUnsavedRange`), not the
snippet object, so the seed query does not re-run every time a new snippet object
is created with the same identity. Stop and Play change none of them, which is
what makes the count hold across a restart rather than resetting.

#### M1.8 — the two foreign keys do not behave the same way

Worth writing down, because it decided the shape of the cleanup SQL and would
decide the shape of any future snippet delete:

- `sam_passes.snippet_id` → **ON DELETE CASCADE**. Deleting a snippet silently
  deletes every pass credited to it. No error, no warning.
- `sam_sessions.snippet_id` → **no ON DELETE clause (NO ACTION)**. Deleting a
  snippet with sessions attached raises instead.

So the sessions FK protects you and the passes FK does not. Any merge must
repoint `sam_passes` before the delete, which is why the merge script wraps
repoint-then-delete in one transaction with a guard that refuses to delete while
anything still references the row.

**Duplicate audit on "Pass Counter Test":** six snippets, exactly one duplicated
identity — `e409ab5e` and `6726c464`, both 1-2 / rests 0 / both. Everything else
is distinct: 1-2 LH differs from 1-2 Both by hand mode, and 2-2 Both from 2-2 RH
likewise, which is correct — hand mode is part of identity. Note the MCP snippet
listing may exclude archived rows, so STEP 2 of the merge script re-checks
against the table directly with archived rows included.

**Why keep the older row.** `6726c464` (19:31:36Z) is the original; `e409ab5e`
(19:45:41Z) is the accident. Any history predating 19:45 can only reference the
older id, so keeping it moves the fewest rows, and its `created_at` is the
snippet's real age — which is what the newest-first list orders on.

**The restore-failure branch is deliberate.** If un-archiving a matched row
fails, `ensureSnippetSaved` adopts that row's id anyway rather than falling
through to the insert. A snippet stuck with `archived: true` is a cosmetic
problem someone can fix in one click; a second row with the same identity splits
practice history permanently, and is the exact bug this milestone exists to end.

#### M1.7 — the sort answer, and the one effect that had to stay silent

**Sort order was already correct.** The saved list is fetched with
`.order("created_at", { ascending: false })` and `.filter(s => !s.archived)`
preserves that order, so it has always been newest-created first. With two
snippets whose creation order, start measures and titles all agree there was no
way to tell by looking — the code is the only witness, and it says created_at
descending.

What was NOT correct was what happened after local mutations, which the fetch
does not re-run for. Restoring a snippet from the archive did
`[{...s}, ...prev]`, parking a possibly months-old snippet above everything
newer until the next reload. M1.6's adopt path could do the same with a row the
panel's list had not seen. Both now go through `newestFirst()`, so the invariant
holds however the list is mutated rather than only on first load.

**The Full Song reset is a mirror effect, and it must never emit.** The panel's
defaults are start 1, end `totalMeasures` — the whole song expressed as a range.
An effect that pushed those values out through `onSnippetChange` would convert
Full Song into a snippet spanning every measure the instant it ran: the same trap
M1.5 avoided by emitting only from real user edits, arriving from the opposite
direction. So the effect sets local control state only. Full Song state survives
it, no snippet is created or adopted, and whole-song passes keep writing a null
`snippet_id`.

Blurring the reset inputs is a no-op for free: every commit handler already
returns early when the committed value has not changed, which was put in for
`RestControl`'s zero-step and pays off again here.

It runs on every `snippet` change rather than only on clear, so the controls stay
honest after loading a saved snippet too. In the common case it is a no-op —
React bails on identical state — and it cannot loop, because it writes only local
state and reads only `snippet`.

#### M1.6 — what `loopCount` means, and why the two 2-2 RH runs are consistent

Asked whether a session can legitimately end with `summary.loopCount` 0 after a
completed playthrough. Short answer: for a snippet, **almost never — but
`loopCount` is not a reliable pass oracle, and the `playthroughs` array is.**

`summary.loopCount` is `loopCountRef.current` at the moment the session ends, and
that ref only moves when ScrollEngine calls `onLoopCount(n)`. A snippet always
loops, and a completed playthrough always reaches the teleport, which increments
to 1 and emits it. So a completed cycle normally leaves `loopCount` ≥ 1.

The exception worth knowing: ScrollEngine's scroll effect depends on
`[playbackState, svgReady, bpm, timingWindowMs, audioElement, firstPassStart]`.
Change the tempo (or timing window) mid-run and that effect re-runs, ScrollEngine's
internal counter resets, and it emits `onLoopCount(0)` — so a session that
genuinely completed cycles and then had its tempo changed ends with `loopCount` 0
in the summary. Passes are unaffected: the pass counter credits on
`n > 0 && n !== lastLoopCount`, which handles the reset. But it does mean
**`loopCount` alone cannot prove a run had no completed playthrough.**

`playthroughs` can. `setLoopIteration` pushes the outgoing playthrough onto the
log at every boundary, including a reset to 0, so a run that completed a cycle
always leaves an entry tagged with the loop it finished on.

Applied to the two runs of "Measures 2-2 RH No Rest" (one measure, four scored
beats per cycle, bpm 40):

| Run (PT) | loopCount | totalBeats | playthroughs |
|---|---|---|---|
| 11:37:35 | 1 | 7 | `{loop:0, beats:4}`, `{loop:1, beats:3}` |
| 11:38:30 | 0 | 2 | `{loop:0, beats:2}` |

The first run completed one cycle (four beats) and was stopped three beats into
the second — one pass, correctly credited. The second run logged a single
playthrough tagged `loop: 0` holding two of the four beats, and no `loop: 1`
entry anywhere. Had a teleport fired and then been reset, a finished `loop: 1`
entry would be in that array. It is not. The run never completed a playthrough;
it was stopped about halfway through its first one. Durations agree — 17.8s and
9.9s against a six-second cycle plus lead-in.

**Conclusion: the two sessions and the single credited pass are consistent. No
pass was dropped.** No behaviour changed for this item.

#### M1.6 — the query-label collision

Neither verification file was internally inconsistent: in
`verify-pass-counter-m1.sql`, C was sessions and D was the bpm check; in
`verify-pass-counter-m15.sql`, C was passes and D was sessions. The M1.5 write-up
saying "Query D shows session attribution" was right about its own file and wrong
about the one that happened to be open. Two files lettering their queries A–D for
different things is the actual defect. Labels are now `M1-A`..`M1-D` and
`M1.5-A`..`M1.5-D`, which cannot collide.

#### M1.5 — how it was built, and the two traps in it

**The Apply finding, in full.** The score only redrew on Apply. The measure
inputs are a two-stage control: `startInput`/`endInput` hold raw text and update
on every keystroke, while `startMeas`/`endMeas` hold the clamped number and are
set on blur. Both pairs are local to `SnippetPanel`. What is actually drawn comes
from `SamPlayer.activeMeasures`, which slices on the `snippet` state — and that
only moved when `onSnippetChange` fired. So Apply was not a confirmation step on
top of a live display; it was the only thing connecting the inputs to the score.

Making the inputs drive the display took a shared `emitRange()` in the panel,
called from four commit points — measure blur, rest step, hand-mode pick, and
loading a saved snippet — each of which resolves the range against the saved list
so it arrives carrying an id when one exists. Commit-on-blur was kept rather than
commit-on-keystroke: the blur/clamp pair already existed, and redrawing the score
on every digit of "125" would rebuild the SVG three times.

**Trap 1 — emitting on defaults would have destroyed Full Song.** The panel
initialises to start 1, end `totalMeasures`, which *is* the whole song as a
range. Had the emit been wired through a `useEffect` on those values, merely
opening the panel while the full song was loaded would have selected a whole-span
snippet and quietly ended the Full Song state — breaking the one thing M1.5 was
told not to regress. So there is no effect: emits happen only from explicit user
commits, and every commit handler returns early when the value did not actually
change. That last guard is load-bearing in a way that is easy to miss —
`RestControl`'s "−" button at zero calls `onChange(Math.max(0, -1))`, i.e. fires
with the value it already had, and tabbing through a measure input blurs
unchanged. Either would have selected a snippet the user never asked for.

**Trap 2 — attaching the id was read as switching snippets.** SamPlayer has an
effect that resets playback whenever `snippet` changes, so that snippet ↔ full
song transitions land in the stopped state. Play auto-saving a range means
swapping in a new snippet object at the same moment playback starts — which that
effect saw as "the user picked a different snippet" and answered with
`handleFullStop()`. Play would have stopped itself. The effect now ignores
changes where `sameLoadedRange` holds: same start, end, rests and hand mode means
the loaded range did not change, only its identity got resolved.

A second, quieter version of the same trap: `activeMeasures` was keyed on the
snippet *object*, so the swap produced a fresh measures array, and ScrollEngine's
render effect tears the SVG down (`setSvgReady(false)`) and rebuilds whenever
`measures` changes identity. That would have restarted the scroll at the downbeat
— after the audio start had already been scheduled against the old one, so the
first pass of every auto-saved range would have played out of sync. The memo is
now keyed on the three range properties that actually change what is drawn.

**Where the shared logic lives.** `src/sam/lib/snippetsApi.js` owns the title
format, the identity rule, the match, and `ensureSnippetSaved`. The panel and
SamPlayer both import it. Two copies of "what makes two snippets the same" that
drifted apart would fork practice history — which is precisely the class of bug
M1.5 exists to end, so it gets one definition.

`ensureSnippetSaved` queries Supabase rather than trusting the panel's in-memory
list, because Play may be pressed against a list loaded minutes earlier. A
`playStartingRef` guard covers the await: the Play button is still on screen
until the lookup resolves, and a second click would otherwise run a second
lookup, find nothing saved yet, and insert a duplicate.

Restart goes through the same path. It is only reachable from the paused state,
where the snippet panel is still on screen and the range may have been edited
since Play.

#### M1 — decisions taken, and things Alex should know

- **Day-boundary logic found.** The constraint was to reuse whatever sits behind
  "Today: xx minutes" rather than writing a second one. It is `ptDateKey()` in
  `src/sam/lib/practiceTimeFormat.js`, consumed by `usePracticeStats`. Note that
  it buckets by **Pacific time**, hardcoded — not by browser local midnight. The
  migration's comment on `completed_at` says "local midnight"; the spec's rule
  ("if it does something else, passes do the same thing") settles the conflict in
  favour of Pacific. M2 will use `ptDateKey` and passes will bucket by PT.
  Nothing in M1 depends on this — M1 only writes `completed_at` — but it is the
  answer to the M2 checkbox and it is worth knowing the migration comment is
  slightly wrong.

- **Ad-hoc ranges cannot be credited, and that is deliberate.** A range applied
  without ever being saved has no `sam_snippets` row. A pass on one cannot be
  written as a snippet pass (no id to reference) and must not be written as a
  song pass (spec rule 6 — a snippet pass never credits the song), so it is
  skipped with a console warning. Saving the range makes its passes countable.
  See the M1 verification round below for the bug this originally masked.

- **"Starting mid-range" is currently unreachable.** Spec rule 2 and the success
  criterion about starting mid-song are both implemented, but there is no UI in
  today's build that starts playback from an arbitrary measure: Play and Restart
  always enter at the first measure of the loaded range, and the audio scrubber
  in `AudioControls` renders only while `playbackState === "stopped"`, so it
  cannot interrupt a playthrough. The only mid-range entry is Resume after a
  pause, which rule 4 says *does* count. Eligibility is therefore armed once, at
  the start of a run, and deliberately left alone by pause/resume — so if a
  jump-to-measure control is added later it will arm nothing and the rule will
  hold without further work.

- **A pass's `session_id` is the session open at the moment it completed.**
  Pausing ends the session row and resuming starts a new one, so a pass that
  spans a pause is attributed to the session it *finished* in. The column is
  nullable, which also covers the brief window while a new session's insert is
  still in flight.
