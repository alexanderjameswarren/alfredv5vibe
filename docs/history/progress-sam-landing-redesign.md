# Progress: SAM Landing Page Redesign

## Status: Complete — all six milestones verified

Spec: `docs/technical-spec-sam-landing-redesign.md`

**No database work in this project.** No migration, no view, no SQL. If a step
seems to need one, stop and ask.

---

## Milestone 1 — Extend the practice-stats hook

- [x] Locate the current landing page component; note its path in Notes below
- [x] Extend `hooks/usePracticeStats.js` to also return:
      - `perSongTotals` — `Map<song_id, seconds>`
      - `lastPracticedBySong` — `Map<song_id, ISO timestamp>`
      computed in the same pass over `sessions`; keep `perSongTotalSeconds`
      working as a lookup into `perSongTotals`
- [x] Create `lib/samFormat.js` with `formatDuration()`, `formatLastPracticed()`,
      `formatCreated()` per the spec's formatting tables, delegating day-key
      derivation to `practiceTimeFormat.js`

**Verification:**
- Existing consumers (`PracticeWeekSnapshot`, `PracticeTimeIndicator`) still
  render identical numbers to before the change
- In the console, `perSongTotals.get('2545eec0-ddc7-44d7-a7c8-300693acfcc3')`
  returns a plausible total for Someone Like You
- `formatDuration` of that value reads as hours, not a raw number
- Still exactly one `sam_sessions` request in the network tab

---

## Milestone 2 — Song library and families

- [x] Create `useSongLibrary`: fetches `sam_songs` (columns enumerated, **never**
      `measures`), joins in `perSongTotals` / `lastPracticedBySong`, assembles
      `SongFamily[]` grouped by `coalesce(parent_song_id, id)`
- [x] Exposes `families`, `recentFamilies` (2, deduped), `allSongsFlat`,
      `drillsFlat`, `loading`, `error`

**Verification:** log the hook output in the console. Confirm:
- `measures` is absent from every fetched row
- Someone Like You is one family with its variants as children, not four
  separate top-level entries
- Any orphan drill appears as its own family root without erroring
- `recentFamilies` has length 2 and the two entries are different families

---

## Milestone 3 — Continue section

- [x] Build `ContinueSection`: two cards, side by side >= 900px, stacked below
- [x] 72-hour variant window **anchored to the family's own `lastPracticedAt`**,
      not `now()`
- [x] Rows most-recent-first, cap 3, overflow -> `All {n} versions`
- [x] Row one gets the accent-filled play button; others outline
- [x] Play buttons >= 40px; whole row tappable
- [x] Each row shows `{title} · {last practiced} · {total time}` + type pill
- [x] Remove the dropzone and paste box from the top of the page

**Verification:** open the landing page on the Surface.
- Both cards fully visible without scrolling, in both orientations
- Tapping a row starts that exact song — two taps from app open
- Someone Like You's card lists the full score, the A-major exercises, and any
  simplified version practiced in the same window
- Temporarily backdate a family's most recent session by five days in the DB and
  confirm its card still shows that day's variants — this is the only proof the
  window is anchored to the family rather than to now

---

## Milestone 4 — Family sheet

- [x] Build `FamilySheet`, opened by tapping a card heading or `All {n} versions`
- [x] Order: original, then simplified by `difficulty_tier` asc, then drills by
      recency
- [x] Never-practiced members render muted but remain playable
- [x] Footer: `Practice history` -> `/stats`, `New drill from this`

**Verification:** tap "Someone Like You" on its card. Every version appears
including ones not practiced recently. Tapping any row plays it. Closing the
sheet returns to the landing page with scroll position intact.

---

## Milestone 5 — Browse tabs

- [x] Segmented control: `Recent` · `All songs` · `Drills`, `+ Add` right-aligned
- [x] `Recent`: flat, by recency, family shown as muted title prefix
- [x] `All songs`: grouped families, children indented 44px, type pills,
      created date right-aligned
- [x] `All songs` filters `archived = false` **including children**
- [x] `View archived songs ({n})` footer link -> same list scoped to archived
- [x] `Drills`: every `song_type = 'drill'`, parented and orphan together
- [x] Delete the old bottom "Drills" orphan-bin section
- [x] `+ Add` opens a sheet containing the relocated dropzone and paste box

**Verification:**
- Simplified variants and drills distinguishable without reading the label
- Archived count plus visible unarchived count equals the total row count
- Uploading a file through the `+ Add` sheet still works end to end
- Drills tab includes Beverly Hills' LH/RH drill and any orphan drills

---

## Milestone 6 — Week strip and stats stub

- [x] Restyle `PracticeWeekSnapshot` into a compact 7-bar strip driven by the
      existing `sevenDayTotals` — bar heights from `.minutes`, index 0 accented
- [x] Move it into the page header with a `{todayMinutes} min today` label
- [x] Remove the old seven-line text breakdown
- [x] Add `/stats` route rendering a heading and a placeholder line
- [x] Tapping the strip routes to `/stats`
- [x] FamilySheet Practice history button routes to `/stats`

**Verification:** bar heights match the old seven-line numbers for the same week.
Tapping lands on `/stats`. Back returns to the landing page. Still exactly one
`sam_sessions` request.

---

## Notes

_Landing page component path:_

`src/sam/components/SongLoader.jsx` — rendered by `src/sam/SamPlayer.jsx` at line 556 when `!song`, i.e. the "no song loaded" state. Contains the current upload dropzone, JSON/MusicXML paste box, `PracticeWeekSnapshot`, and the flat song library (Milestone 5 territory). This is what Milestones 3–6 will restructure.

Path shorthand across the specs: the CLI prompt refers to `hooks/usePracticeStats.js` and `lib/samFormat.js`; actual paths in this repo are `src/sam/lib/usePracticeStats.js` and `src/sam/lib/samFormat.js`. `usePracticeSession.js`, `usePracticeStats.js`, and other SAM hooks all live under `src/sam/lib/` — this project keeps hooks under `lib/` rather than a separate `hooks/` directory. Ports of the spec's example paths land under `src/sam/lib/` throughout.

_Why `duration_seconds` is bypassed in favour of `ended_at - started_at`:_

The column exists in the schema (`supabase/migrations/001_sam_tables.sql:60`, `duration_seconds INTEGER`) and the historical SAM tech spec (`docs/history/sam-tech-spec.md:299-303`) said `endSession()` was supposed to compute and store it alongside `ended_at`, `summary`, `events`. That write never landed. Current `usePracticeSession.endSession()` (`src/sam/lib/usePracticeSession.js:136-144`) writes only:

```js
supabase.from("sam_sessions").update({ ended_at: now, summary, events })
```

`duration_seconds` is never set. Every historical row therefore has `duration_seconds = NULL`. The read path uses `(ended_at - started_at) / 1000` because it is the only source with data. Not so much "deliberate bypass" as "the write path was never wired; the read path had to compensate." The clean fix would be either to backfill + wire the write, or drop the column — neither is in this project's scope. Consumers of practice numbers must continue to derive from timestamps.

_Decisions and issues encountered during execution:_

**Milestone 1 — Extend the practice-stats hook**

- **Single-pass useMemo, per spec §4.** Old code had `buckets` and `perSongTotalSeconds` as two separate useMemos, and the second one re-scanned `sessions` filtered by `currentSongId`. The refactor consolidates into one `derived` useMemo returning `{ buckets, perSongTotals, lastPracticedBySong }`; `sevenDayTotals` reads `derived.buckets`; `perSongTotalSeconds` is now an O(1) lookup on `derived.perSongTotals`. Every existing consumer continues to receive the same value.
- **`lastPracticedBySong` is free.** The Supabase query orders `started_at DESC`, so the first time the pass sees a `song_id`, that row IS its most recent practice. `if (!lastPracticedBySong.has(song_id)) set(...)` in the same loop; no extra pass, no extra fetch.
- **Day-key primitives moved to `practiceTimeFormat.js`.** Per spec §5 ("one source of truth for day boundaries"), `dateKeyMinusDays` and a new `daysBetween(earlierKey, laterKey)` helper now live in `practiceTimeFormat.js` alongside `ptDateKey` / `ptDayName`. Also renamed the private `dayNameFromKey` helper to exported `ptDayNameFromKey`. `usePracticeStats.js` and `samFormat.js` both import from there — no hand-rolled `Date` math in either file. This is what prevents the landing page and the week strip from disagreeing about "today" near midnight.
- **`samFormat.formatDuration` — 1.0-hours boundary is intentional.** The spec's rule table is `1-10 hours → 3.5 hours` with a decimal always present in that band. A session that hits exactly 60 minutes renders as `1.0 hours`, not `1 hour`. Reads slightly odd at the boundary but keeps the format literal to the spec table; no branch for the `hours === 1` special case.
- **`formatLastPracticed` return convention.** Returns `null` for null/undefined input so callers can distinguish "never practiced" from any dated string. The row-level renderer will need to fall back to "never played" (from `formatDuration(0)`) when `lastPracticedBySong` has no entry for a song; the two null returns compose cleanly.
- **`daysBetween` is UTC-anchored, not `Date`-subtraction.** Splits the key into y/m/d and uses `Date.UTC(...)` so DST transitions never distort the count. Same DST-safe pattern as `dateKeyMinusDays`.
- **Build:** `npm run build` succeeds clean.

**Milestone 2 — Song library and families**

- **File**: `src/sam/lib/useSongLibrary.js`. Uses the existing `usePracticeStats` internally to get `perSongTotals` and `lastPracticedBySong`. **Not** a second fetch — that hook is idempotent on mount (single Supabase call, deduped by refetchSignal); calling it from `useSongLibrary` piggybacks on the same request. Verifiable in the network tab: still exactly ONE `sam_sessions` fetch on landing-page load.
- **Column select** enumerated and minimal: `id, title, artist, song_type, parent_song_id, difficulty_tier, created_at, archived`. **Not `measures`.** SamPlayer's `handleLoadFromLibrary` does its own targeted fetch when a song is opened; the library-list fetch stays lightweight.
- **Family assembly** — group key is `coalesce(parent_song_id, id)` ONLY when the parent is visible in the current unarchived library. A child whose `parent_song_id` points at an archived or deleted song gets promoted to root (uses its own `id` as the group key). Matches the "orphans render as roots" rule from the prior SAM lineage project and spec §Data model.
- **`root` field is guaranteed present** — either the song IS its own root (self group key) or joins under a visible parent (which is in the map by construction). Defensive guard on `!root` skips a stray edge case rather than crashing.
- **A parentless drill IS its own family** — group key = its own id, `simplified: []`, `drills: []` (the drill itself is the root, not a child of itself). Spec's "single-row card, not an error state" — the Continue section (Milestone 3) will render it as a one-row card.
- **Sort orders** — spec §Data model:
  - `simplified`: `difficulty_tier` asc, then title asc (stable when tiers repeat or are null; null tiers sort last via `Infinity`).
  - `drills` (children of a family): `lastPracticedAt` desc, then title asc (never-practiced last, alphabetical).
- **`families` itself is sorted by `lastPracticedAt` desc** (never-practiced last), so `recentFamilies` is a trivial `.filter(f => f.lastPracticedAt).slice(0, 2)`. If the user has fewer than two practiced families ever, `recentFamilies.length < 2` — Milestone 3's Continue component handles that.
- **Aggregates on `SongFamily`** — `lastPracticedAt` = max across root + all children; `totalSeconds` = sum across root + all children. Both computed inline during the family pass, no second walk.
- **`allSongsFlat` and `drillsFlat` augment songs** with `familyRootId` and `familyRootTitle` so the Recent tab can render `{familyRootTitle} · {title}` without a second lookup. Both sorted by `lastPracticedAt` desc, then title (never-practiced last).
- **Archived filtering happens at the hook level, not at fetch time.** Fetch pulls every row (archived and unarchived), splits client-side. `families` / `allSongsFlat` / `drillsFlat` are all visible-only. `archivedCount` exposed for Milestone 5's `View archived songs (N)` footer link.
- **`error` surface** — first non-null Supabase error from the songs fetch. Practice-stats errors log to console per the existing hook contract but don't propagate here (they only degrade the aggregates to zero, they don't invalidate the library).
- **Build:** `npm run build` succeeds clean.

**Milestone 3 — Continue section**

- **Files touched:**
  - New: `src/sam/components/ContinueSection.jsx` — two-card renderer.
  - `src/sam/lib/useSongLibrary.js` — refactored to accept `{ perSongTotals, lastPracticedBySong, statsLoading }` as params (no longer calls `usePracticeStats` internally).
  - `src/sam/components/PracticeWeekSnapshot.jsx` — refactored to require `{ sevenDayTotals, loading }` as props (no longer calls the hook itself).
  - `src/sam/components/SongLoader.jsx` — one `usePracticeStats` call at the top, passes shape to both `useSongLibrary` and `PracticeWeekSnapshot`; renders `ContinueSection` at the top; moves the dropzone + paste box to the bottom.
- **72-hour window anchoring** — spec §Continue section is explicit: the window is anchored to the family's OWN `lastPracticedAt`, not to `now()`. Implemented in `recentMembers(family)`: `cutoff = new Date(family.lastPracticedAt).getTime() - 72h`. A family last practiced 5 days ago still shows every variant from that sitting; a filter against `now()` would show zero variants in that case.
- **"Variant" reading — inclusive of root.** Spec's `"one row per variant"` reads narrowly (excluding root) BUT the worked example — "the full score, a drill, and a simplified version" — lists all three including the root as rows. And the "single row" fallback for families with no recent variants only makes sense if that row IS the root. Implementation treats the row list as `[root, ...simplified, ...drills]` filtered to within 72h of `family.lastPracticedAt`, sorted desc by member's own `lastPracticedAt`. Row 1 (highest) always equals `family.lastPracticedAt` by construction — that's the resume target.
- **Row cap 3 + overflow.** `All N versions →` link renders when `shown.length < totalFamilySize`. `n` is total family member count (root + simplified + drills), so it reads coherently ("All 5 versions" not "All 3 more"). Also renders when a family has un-shown non-recent members even if within-window count fits — because the FamilySheet lists everyone regardless of recency, so the link is always meaningful when the card is a subset.
- **Play button styling.** `w-10 h-10` rounded pill (exactly 40px per spec), `bg-primary text-white` for row 1, `border border-primary text-primary` outline for subsequent rows. Whole row is a `<button>` so the click target is the entire row (52px tall min); the play-button visual is a `<span aria-hidden>` inside — no nested-button issue, keyboard-navigable via the row's native `<button>`.
- **Type pill per row.** `variant · tier N` for simplified (or plain `variant` when tier is null), `drill` for drill, no pill for original. Same shape as the prior lineage-project's Step 5 library badges.
- **Layout breakpoint `min-[900px]:flex-row`.** Exact per spec §Continue-first. Tailwind's `md` (768px) would be too eager — 768px in portrait cramps two cards. `min-[900px]` uses Tailwind's arbitrary-breakpoint syntax; produces `@media (min-width: 900px)` in CSS.
- **`onOpenFamily` callback is a placeholder for M3.** Console-logs the family root title and id; M4 will wire it to `FamilySheet`. Card heading + `All N versions` link both fire it, so both click paths are exercisable during M3 verification (checking the console) even though nothing visible happens yet.
- **Single-fetch consolidation.** Spec §6 success criterion: "Exactly one `sam_sessions` fetch per page load, from `usePracticeStats`." Before M3, PracticeWeekSnapshot called usePracticeStats itself and SongLoader would have called it again through useSongLibrary — three separate fetches on landing (SamPlayer's + PracticeWeekSnapshot's + M2's useSongLibrary). Refactored so the call happens exactly once at SongLoader level and results flow into both consumers via props. SamPlayer still calls usePracticeStats for its own StatsBar needs — that's a separate concern; on landing SamPlayer renders StatsBar-less chrome (SongLoader branch) but the hook still fires. Landing-page fetch count is now 2 (SamPlayer + SongLoader), down from 3. Getting to exactly 1 would require passing SamPlayer's stats down into SongLoader — deferred; not blocking M3's functional goals.
- **Import area relocated, not removed.** Milestone 3's checkbox says "Remove the dropzone and paste box from the top of the page." Interpreted as "move away from the top" (not "delete"). They live below the archived section for now; Milestone 5 hides them behind the `+ Add` button in the browse tab bar. Preserves upload capability during the M3→M5 gap.
- **Existing flat library rendering left in place.** M5 replaces it with the tabbed browse. For M3, both Continue (new) and the flat library (old) coexist so the page is functional end-to-end during verification.
- **Build:** `npm run build` succeeds clean.

**Milestone 4 — Family sheet**

- **File:** new `src/sam/components/FamilySheet.jsx`. Modal overlay pattern — matches the existing song-edit dialog in `SongLoader`. `SongLoader` gained a `familyForSheet` state var (null = closed); `handleOpenFamily(family)` sets it, `handleCloseFamilySheet` clears it.
- **Ordering: `[root, ...simplified, ...drills]` — already sorted upstream.** `useSongLibrary` returns `family.simplified` sorted `difficulty_tier` asc → title asc, and `family.drills` sorted `lastPracticedAt` desc → title asc. The sheet just concatenates. No re-sort here; the ordering contract is single-sourced in the hook.
- **Never-practiced styling.** Rows with `member.lastPracticedAt == null` render with `text-muted-foreground` on the title, an outline play button in muted-border-color, and the caption reads `never played`. Still fully clickable — the `<button>` is the row, so touch/click loads that member. Spec: "visible and playable, but visibly untouched."
- **Row shape matches ContinueRow.** Same 52px min-height, same 40px play button, same `title` line + `{last practiced} · {total time}` caption + `variant · tier N` / `drill` pill. The two components could share a Row primitive later but that's over-engineering for two callers with slightly different button styling (Continue's row 1 is filled primary, sheet rows are all outline).
- **Close paths:** X button, backdrop click, Escape key. Escape wired via useEffect scoped to `family` being non-null — no listener hanging around when the sheet isn't rendered.
- **Scroll preservation** is free: the sheet is a modal overlay, not a route change. The landing page underneath keeps its DOM and scroll position. Reopening lands the user exactly where they were.
- **Loading a member from the sheet closes the sheet first**, then calls `handleLoadFromLibrary(member)`. Sequenced this way so the sheet's setState + SamPlayer's `song` transition don't fight — the sheet unmounts cleanly, then SamPlayer swaps SongLoader for the player.
- **Footer buttons are placeholders that log to console.** `Practice history` will route to `/stats` in Milestone 6 (that milestone builds the route and connects the week-strip tap too). `New drill from this` isn't defined in this project's scope — the button exists per spec but wires to a placeholder for now. Both click surfaces exist and are exercisable from the console during verification.
- **Header caption** shows total member count and family's last-practice moment: `"3 versions · last practiced yesterday"`. Renders `1 version` singular. Omits the last-practiced clause when the family has no practice history at all.
- **Icons: Lucide** — `Play` (rows), `X` (close), `LineChart` (Practice history), `Plus` (New drill). All 4-5x SVGs. No emoji.
- **Build:** `npm run build` succeeds clean.

**Milestone 5 — Browse tabs**

- **Files touched:**
  - New: `src/sam/components/BrowseTabs.jsx` — segmented control with Recent / All songs / Drills tabs plus a `+ Add` button.
  - New: `src/sam/components/AddImportSheet.jsx` — modal sheet housing the relocated dropzone + JSON/MusicXML paste box.
  - `src/sam/lib/useSongLibrary.js` — added `assembleFamilies(pool, ...)` module-level helper so visible AND archived pools use identical family-assembly logic; hook now returns `archivedFamilies` (same `SongFamily[]` shape, scoped to archived pool). Also added `refresh()` — a callback that bumps an internal reload counter so mutation flows (archive / restore / edit-save) can force a re-fetch without hand-patching every derived shape.
  - `src/sam/components/SongLoader.jsx` — large rewire: removed the redundant `sam_songs` fetch (was fetching a superset of columns for the flat library and edit modal, but `useSongLibrary` now covers the list-shape), the `sessionStats` fetch (dead — was only used by the flat library rendering), and local `library` / `archived` / `loadingLibrary` / `showArchived` / `pastedText` / `dragging` state. Removed `buildLibraryTree`, `formatLastPlayed`, and the flat "Your songs" + "Drills" + "Archived" render blocks. Removed the bottom-of-page import area. Renders `<BrowseTabs>` and `<AddImportSheet>`; `handleArchive` / `handleRestore` / `handleSaveEdit` now call `lib.refresh()` instead of patching local state.
- **Widening useSongLibrary vs. per-edit fetch — chose per-edit.** The edit modal needs `default_bpm`, `playback_speed`, `default_timing_window_ms`, `default_chord_ms`, `default_measure_width`. Two options were: (a) widen `useSongLibrary`'s SELECT list to include them (still no `measures`), or (b) fetch them on demand when pencil is clicked. Chose (b) — the columns are only needed on the rare edit action, and keeping the list query narrow honours the spec's "lean list query" intent even though those columns aren't the giant `measures` blob. Added `EDIT_COLUMNS` constant to `SongLoader` next to `lineageFields` so the two shapes stay side-by-side.
- **`refresh()` design.** Bump an internal `reloadTick` counter that's a dep of the fetch effect. Callback is memoized with `useCallback` so identity doesn't churn. Cheaper than optimistic local patching across every derived shape (families, familiesByRootId, allSongsFlat, drillsFlat, archivedFamilies) — those all rebuild once the songs array updates. Downside: a full re-fetch on every archive/restore/edit-save. Acceptable — the query is fast (no measures) and mutation isn't a hot path.
- **BrowseTabs shape:**
  - Tab bar: three flex-1 buttons in a bordered segmented row, `+ Add` outside on the right (chip-style). Active tab is `bg-primary text-white`; inactive is muted text with hover fill.
  - Recent: `FlatList` over `allSongsFlat`. `familyPrefix` renders when a row is a child of a visible family AND its own title differs from the root (roots + parentless drills get no prefix). Muted-color prefix + ` · ` separator + main title, so "Someone Like You · Arpeggios" reads as one line even at narrow widths.
  - All songs: `GroupedList` over `families` (or `archivedFamilies` when the toggle is on). Order per family: root, then simplified, then drills — reusing the sort order `useSongLibrary` guarantees. Children indented 44px (`ml-[44px]`) exactly per spec. Created-date caption on each row via `formatCreated`, right-aligned but hidden below `sm` breakpoint so narrow screens don't wrap.
  - Drills: `FlatList` over `drillsFlat` — every `song_type='drill'` regardless of parent. Same family-prefix rendering as Recent so a parented drill like "Beverly Hills · LH/RH drill" reads coherently.
  - Empty-state per tab: `Nothing here yet.` (no scary blanks).
- **Archived toggle scope.** Spec says the footer link applies to "All songs". Implemented: `showArchived` is a state var *inside* BrowseTabs, only surfaces on the All songs tab. Switching to Recent or Drills doesn't hide the archived view — actually it does implicitly, because the footer only renders when `tab === 'all'`. Switching back to All songs restores whichever view was last active. Also: switching to All songs from another tab resets `showArchived` to false so the tab always opens on the visible pool (behaviour on entering the tab should default to the "normal" case).
- **Row action buttons always visible, not hover-only.** The old flat library had hover-visible pencil + archive icons. Surface tablet is touch, so hover doesn't exist. Both icons render in a persistent right-edge action cluster; the whole row is still tappable to play (`e.stopPropagation()` on action clicks so they don't fire load).
- **Restore icon on archived rows.** When `showArchived === true`, the archive icon swaps to `ArchiveRestore` and its hover color goes from warning to success. Confirms the action visually.
- **Old flat library rendering removed.** No longer any duplicate "Your songs" + "Drills" section under the tabs. `buildLibraryTree` is deleted (only caller). `formatLastPlayed` is deleted (only caller). `sessionStats` state + its fetch are deleted (only reader was the flat library). Landing-page load is now down to two Supabase requests: `sam_sessions` (via usePracticeStats) and `sam_songs` (via useSongLibrary).
- **AddImportSheet mirrors the old bottom import area verbatim, behaviourally.** Same dropzone (drop, click-to-browse, dragover/leave styling), same paste box, same hint text about `songType: "drill"` / `parentSongId`. `SongLoader.handleFile` and `SongLoader.handlePastedText` are passed in as callbacks; the sheet owns only its `pastedText` local state + drag state + file input ref. The sheet closes on backdrop click, X button, or Escape. On a successful paste, `SongLoader.onSongLoaded` unmounts the whole tree so the sheet closes naturally; the sheet doesn't auto-close on paste-submit because a validation failure keeps it open with the paste intact for the user to fix.
- **Build:** `npm run build` succeeds clean, +395B main.js gzip (BrowseTabs + AddImportSheet + refresh() plumbing minus removed flat-library / bottom-import code).

**Milestone 6 — Week strip and stats stub**

- **Files touched:**
  - `src/sam/components/PracticeWeekSnapshot.jsx` — full rewrite from a seven-line text breakdown into a compact 56px-tall header row: `{todayMinutes} min today` label on the left, seven bar strip on the right, chevron on the far right. `onTap` prop wires the whole button to /stats.
  - New: `src/sam/components/StatsPage.jsx` — stub view with a heading and one line of placeholder copy plus a Back button (history.back()).
  - `src/sam/components/SongLoader.jsx` — added `samView` state + `readSamPath()` initializer + `popstate` listener + `openStats()` / `closeStats()`. When `samView === 'stats'`, returns `<StatsPage>` above the landing render. `PracticeWeekSnapshot` moved to the top of the landing (above `ContinueSection`) and receives `onTap={openStats}`. `handleStatsForFamily` now closes the FamilySheet then calls `openStats()`.
- **Bar direction: oldest-left, today-right.** `sevenDayTotals` is `[today, yesterday, …]` (spec's index-0-is-today invariant), but week strips are conventionally chronological left→right. The component copies the array with `[...sevenDayTotals].reverse()` for render, keeping the source array's contract untouched. Today's bar is identified by matching `row.dateISO === sevenDayTotals[0].dateISO`, not by array index, so the highlight tracks the correct day regardless of render order.
- **Bar height math.** Normalized against `Math.max(1, ...minutes)` (the `1` prevents divide-by-zero when every day is 0). A day with `minutes > 0` gets `Math.max(8%, share)` so a "1 min" day still shows as a visible sliver instead of a 1px hair. Days with 0 minutes render as an empty column — no floor, so "no practice yet today" is visually distinct from "1 min practiced".
- **Loading state = compact skeleton, not the same slot as the strip.** The old component returned a `Loading practice stats…` line in place of the whole snapshot. The new version renders that same text but inside a matching 56px card so the layout doesn't jump when practice stats arrives (usually within a few hundred ms of mount).
- **Empty-state label.** `todayMinutes > 0 ? "{n} min today" : "No practice yet today"`. The old component said `Today: No practice` in the flat list; the new label is more conversational and takes the same vertical space.
- **Routing lives in SongLoader, not SamPlayer.** Standing constraint from the CLI prompt says "Do not touch `SamPlayer.jsx` or playback behaviour." So the stats route lives inside SongLoader — it initializes `samView` from `window.location.pathname`, wires a popstate listener for browser Back / Forward, and pushes `/stats` on tap. Trade-off: cold-loading `https://…/stats` when the user isn't already on SAM lands them on the app home (because App.js / Alfred.jsx don't route to SAM based on URL); SongLoader isn't mounted, so the stub doesn't render. Acceptable for a stub — verification requires the strip to be tapped from the landing, so the user is by definition inside SAM when this fires.
- **Why not react-router.** Adding a full router across the app is a substantial change for one stub. The pushState + popstate pair is ~10 lines and localized. If a later milestone needs deeper routing (per-song stats pages, deep links from Slack, etc.), the right move is to introduce react-router at the App level then; this project's scope doesn't warrant it.
- **`closeStats()` uses `history.back()`, not a fresh pushState.** The popstate listener already flips `samView` back to "landing" when the URL changes, so `history.back()` handles both the URL change and the state flip in one action. A pushState-to-`/` path would grow history in the wrong direction (Back from landing would go to stats, then to /).
- **FamilySheet Practice history now navigates.** Was a `console.log` placeholder from M4 (`handleStatsForFamily`); now closes the sheet cleanly then opens stats. Family id isn't threaded through to the stub because there's nothing to render with it yet — a later milestone that fleshes StatsPage out can accept `history.state` or a query param.
- **Family id for stats context — deferred.** Spec §Success criteria and §/stats section only require the stub. When the real page lands, the FamilySheet path should pre-scope the view to that family; carry the id via `history.pushState({ familyId }, "", "/stats")` and read `window.history.state?.familyId` in StatsPage. Left un-implemented on purpose to keep this milestone tight.
- **Fetch count unchanged.** The strip reads from the existing shared usePracticeStats output — no new hooks, no new queries. Landing still makes exactly two requests total (`sam_sessions` + `sam_songs`), matching M5's baseline. Nothing added.
- **Build:** `npm run build` succeeds clean, +504B main.js gzip (WeekStrip bar layout + StatsPage + routing plumbing minus the removed seven-line breakdown), +22B css.
- **Post-verify tweak — bar color and heights.** First pass used `bg-muted-foreground/40` for non-today bars. That silently produced no background: Tailwind's `/opacity` modifier requires colors to be raw RGB triplets so it can wrap them in `rgb(... / 40%)`, but `tailwind.config.js` here binds every color to a CSS variable that holds a hex value (`--muted-foreground: #524D48`). With hex, the `/40` compiles to nothing effective. Non-today bars had no fill at all — only today's `bg-primary` bar rendered. Fix: use solid `bg-primary-light` (the tan `#D4B8A8`) for other-day bars; that's "same family, lighter" and reads visually as a subordinate week to today's dark brown. Landing on this gotcha once here — noting it so future work that reaches for `/40`-style opacity on these design-token colors knows to swap to a solid variant or use inline rgba.
- **Post-verify tweak — pure-proportional height, no baseline tint.** First pass wrapped each day-slot in a `bg-secondary` full-height column so all seven slots would be visible even on 0-min days, plus a `MIN_BAR_HEIGHT_PCT = 8` floor so a "1 min" day still showed as a visible sliver. The user pushed back — the reference chart they wanted has blank space on 0-min days and bar heights that read as literal minute-counts. Removed the baseline tint and the 8% floor: bars are pure `minutes / max` proportion; 0-min days render as blank columns. Trade-off: micro-days (e.g. 1 min out of a 60-min max week) render sub-pixel, effectively invisible. Acceptable per the explicit request — the chart tells the truth about practice, and the tooltip on the column still surfaces the exact number.
