


# Technical Spec — SAM Landing Page Redesign

## Overview

The SAM landing page is optimised for the rarest action (uploading a song) and
worst-optimised for the most common one (resuming practice). Today the upload
dropzone occupies the top ~260px, the seven-day practice breakdown occupies
another ~150px, and the songs list is a flat alphabet-soup of originals,
simplified variants, drills, and test files with no family grouping.

This redesign makes resuming practice a two-tap operation on a Surface tablet:
tap SAM, tap the piece. Everything else moves below or behind a control.

**Primary device:** Surface tablet, touch. All interactive targets >= 40px.

## Architecture decisions

### 1. Continue-first, not tabs-first

Tabs were considered and rejected for the primary flow. A "Recently Played" tab
that is correct 90% of the time is not a tab — it is the page. Tabs exist below
the fold for the other 10%.

The top of the page is a **Continue** section: the two most recently practiced
*distinct song families*, each rendered as a card. Tabs (`Recent`, `All songs`,
`Drills`) sit below it and govern only the browse list.

### 2. The existing schema already models families correctly — use it

**No migration is required.** `sam_songs.song_type` is already a three-value
discriminator with a lineage check constraint:

| `song_type`  | Meaning                                                        | Parent          |
|--------------|----------------------------------------------------------------|-----------------|
| `original`   | Imported score, root of a family                                | must be null    |
| `simplified` | Difficulty-reduced variant of a parent score. *Is* the song     | required        |
| `drill`      | Bespoke practice material (scales, LH/RH isolation, arpeggios)  | optional        |

`difficulty_tier` (smallint 1-9) is populated only for `simplified` and enforced
null otherwise by `sam_songs_difficulty_tier_check`.

The current UI collapses everything non-original into a single `drill` pill.
That is a UI defect, not a data gap. The distinction matters:

- A **simplified** variant *is* the piece, reduced. Finishing it is real progress.
- A **drill** is *not* the piece. It builds a capability.

This drives sort order (simplified sorts with the original, drills below),
pill treatment, and which items appear in the Drills tab.

### 3. Practice time replaces session counts everywhere

Session counts are not meaningful — 731 sessions on a song says nothing about
investment. Every row displays `{last practiced} · {total time}`.

### 4. Extend the existing practice-stats hook; do not build a parallel path

`hooks/usePracticeStats.js` already fetches every `sam_sessions` row with
`song_id`, `started_at`, `ended_at`, filtered to `ended_at is not null`, ordered
`started_at` descending. It already computes seven-day buckets and a single
song's total. Everything the landing page needs is derivable from data that hook
already has in memory.

**Duration is `ended_at - started_at`, not `duration_seconds`.** The existing
hook deliberately ignores `duration_seconds` and derives from the timestamps,
and it is what produces the practice numbers currently displayed. Follow it.
Do not switch sources mid-redesign.

Extend the hook's return with two maps, computed in the same `useMemo` pass over
`sessions`:

```
perSongTotals:       Map<song_id, seconds>
lastPracticedBySong: Map<song_id, ISO timestamp>
```

`lastPracticedBySong` is close to free — `sessions` is already ordered
`started_at` desc, so the first occurrence of each `song_id` is its last
practice. Keep the existing `perSongTotalSeconds` return value; it becomes a
lookup into `perSongTotals`.

**Known limitation, accepted for now.** The fetch is unbounded — no `limit`, no
date floor. Every landing page load pulls every session ever recorded. This is
fine at the current volume and degrades somewhere past ~10k rows. When initial
paint gets sluggish, the fix is a `sam_song_stats` aggregate view
(`security_invoker`, grouped by `song_id`) rather than a client-side sum. Do not
build that now; reusing proven code beats new code plus new SQL.

### 5. One source of truth for day boundaries

`practiceTimeFormat.js` derives day keys in Pacific Time via `ptDateKey`, not
local `Date` arithmetic. Any new "today" / "yesterday" logic **must** delegate to
it. Rolling a separate day-boundary check in `samFormat.js` means the landing
page and the week strip can disagree about what day it is — near midnight, and
permanently if practising from another timezone.

## Data model — client side

```
SongFamily {
  root:            Song            // the original, or an orphan drill acting as root
  simplified:      Song[]          // ordered by difficulty_tier asc, then title
  drills:          Song[]          // ordered by last practiced desc
  lastPracticedAt: timestamp       // max across root + all children
  totalSeconds:    number          // sum across root + all children
}
```

Family assembly rule: group by `coalesce(parent_song_id, id)`. A drill with a
null `parent_song_id` is its own family root and renders as a single-row card —
this is legitimate and must not be treated as an error state.

`ON DELETE SET NULL` on `parent_song_id` means orphaning is expected over time.

## Components

### `ContinueSection`

Two cards. Selection: **the two most recently practiced distinct families**,
ranked by `family.lastPracticedAt` descending. Deduplicated by family — if the
two most recent *songs* belong to one family, that family takes one card and the
next distinct family takes the second.

Each card shows:

- Family name (the root's title) as the card heading
- One row per variant practiced **within 72 hours of that family's own last
  practice** — anchored to `family.lastPracticedAt`, **not** to `now()`

  > This anchoring is deliberate. A family last practiced four days ago would
  > show zero variants under a "72 hours from now" filter, even though that day's
  > sitting covered the full score, a drill, and a simplified version.
  > Anchoring to the family's own last practice reconstructs that session.

- Rows ordered most-recently-practiced first. Row one is the resume target and
  gets the accent-filled play button; subsequent rows get outline buttons.
- **Capped at 3 rows.** Overflow renders `All {n} versions ->` opening the family
  sheet. Uncapped, a heavy day pushes the tab row below the fold.
- Each row: `{title} · {last practiced} · {total time}`, plus a type pill for
  non-original rows.

A family with no recent variants renders a single row — visually balanced, not
an empty state.

### `FamilySheet`

Opened by tapping a card heading, or `All {n} versions`. Lists every member of
the family regardless of recency: original first, then simplified ascending by
`difficulty_tier`, then drills by recency. Each row is a play target. Footer
actions: `Practice history` (routes to the stats stub), `New drill from this`.

Never-practiced members render with muted text and a muted play button — visible
and playable, but visibly untouched.

### `BrowseTabs`

Segmented control: `Recent` · `All songs` · `Drills`, with `+ Add` right-aligned.

- **Recent** — flat list, all songs by last practiced desc, family context shown
  as a muted prefix on the title (`Someone Like You · Arpeggios`).
- **All songs** — families grouped. Root row at full weight; children indented
  44px with type pills. Filter `archived = false`, **including children** — an
  archived child under an unarchived parent stays hidden, or the archive count
  will not reconcile. Footer link `View archived songs ({n})` loads the same
  list scoped to `archived = true`.
- **Drills** — flat list of every `song_type = 'drill'` regardless of parent, so
  orphan and parented drills sit together. This replaces the current bottom
  "Drills" section, which is really an orphan bin leaking an implementation
  detail into the UI.

### `+ Add` sheet

Relocates the existing dropzone and the JSON/MusicXML paste box, unchanged in
behaviour, behind a button. The paste contract is unaffected.

### `WeekStrip`

`PracticeWeekSnapshot` already renders the seven-day data as a text list. This
is a **restyle of that component**, not a new one: seven bars sized by
`sevenDayTotals[i].minutes`, index 0 (today) accented, followed by
`{todayMinutes} min today`. It moves into the page header. Tapping routes to
`/stats`.

Both values come from `usePracticeStats` unchanged — no new data work here.

### `/stats` — stub, this pass

Route exists, renders a heading and a "coming soon" line. It is a link
destination only. Full stats are out of scope.

## Formatting rules

Centralise in `lib/samFormat.js`, delegating day-key derivation to
`practiceTimeFormat.js` per decision 5. Do not inline these.

**Duration:**

| Total            | Renders     |
|------------------|-------------|
| 0 / no sessions  | `never played` |
| < 60 min         | `45 min`    |
| 1-10 hours       | `3.5 hours` |
| >= 10 hours      | `42 hours`  |

**Last practiced:** `today` · `yesterday` · weekday name if within 7 days ·
otherwise `Jul 12` (append year if not the current year). Day comparisons use
`ptDateKey`, never raw `Date` differences.

**Created:** `added Mar 3` (append year if not the current year). Shown on the
All songs tab only, right-aligned in the row.

## Out of scope

- The `sam_song_stats` aggregate view (see decision 4 — deferred, not cancelled)
- Sorting controls on All songs
- Real practice statistics beyond the stub route
- Any change to `SamPlayer.jsx` or playback behaviour
- Archiving the ~5 junk rows currently in the library (`d — d`, duplicate
  Entertainer, test files) — a data cleanup task, not a code change

## Success criteria

1. From a cold load on the Surface, resuming the most recent piece is two taps
   and requires no scrolling.
2. A family practiced across three variants in one sitting shows all three on
   its card, whether that sitting was today or five days ago.
3. Simplified variants and drills are visually distinguishable at a glance.
4. All songs shows only unarchived rows and reconciles with the archived count.
5. Every row displays practice time; no session counts remain in the UI.
6. Exactly one `sam_sessions` fetch per page load, from `usePracticeStats`.
7. The landing page and the week strip never disagree about what "today" is.
