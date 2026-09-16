# Technical Specification — Pass Counter

## Overview

A "pass" is one complete playthrough. SAM should count them, show the count live
during playback, and break them out per snippet on the pause screen.

The reason this feature exists: practice instructions are written as a tempo plus
a number of passes — "Pastorale No. 3 at 60, four to six passes." Today there is
no way to know from inside the app whether that instruction was followed. The
counter closes that gap, and recording the tempo alongside each pass is what makes
a pass count mean something later.

## What counts as a pass

A pass is credited at the instant playback crosses the final measure of whatever
range is currently loaded.

Rules, all of them decided:

1. **Looping counts per cycle.** A song set to repeat and left running through six
   cycles is six passes, not one. This is the primary use case.
2. **Must start at the beginning of the loaded range.** Starting from measure 20 of
   a song and playing to the end is not a pass for that song.
3. **A snippet is its own range.** A snippet defined as measures 20 to the end
   earns a snippet pass when it completes, because measure 20 is the beginning of
   that range.
4. **Pause does not break a pass.** Pause, come back, finish — that is a pass.
5. **Stop and reset break the pass in progress only.** They never remove passes
   already banked. Play twice, stop, restart, play twice more: the counter reads
   4 at the end, and reads 2 the moment playback restarts.
6. **A whole-song pass never credits a snippet.** Snippet passes come only from
   playing the snippet.
7. **Every pass records the tempo** in force at the instant it completed.

## Every practice run is attributable

A pass can only be recorded against something. A whole-song pass records the
song; a snippet pass records the snippet. There is no third case, and a range
the app cannot name is a range whose practice is lost.

That used to be possible. The snippet panel's **Apply** button loaded a range
with no database id attached, so practising it recorded as whole-song practice
(`sam_sessions.snippet_id` came out null) and, once passes existed, recorded
nothing at all. Adopting a matching saved snippet's id on Apply fixed the
attribution but left ad-hoc ranges — ranges typed in and never saved — as a
permanent hole.

The hole is closed by removing the choice rather than reporting it:

1. **Play saves the range it is about to play.** If the active range is not the
   full song and has no database id, Play finds or creates a `sam_snippets` row
   for it before playback begins. No prompt, no dialog, no naming step — the
   existing auto-title is used.
2. **Matching comes first.** A range identical to a saved snippet adopts that
   snippet rather than creating a second one. Without this, replaying the same
   ad-hoc range on consecutive days would fill the saved list with duplicates
   and split that snippet's practice history across them. Identity is four
   properties — start measure, end measure, rest count, hand mode — the same
   four the auto-title renders. Archived snippets are never matched; archiving
   retires a snippet.
3. **A failed save never stops playback.** The failure is logged and the run
   plays on without an id. One lost row beats a Play button that doesn't play.
4. **Apply is gone.** With every range saved on Play, a separate "load this
   range" gesture is redundant. The measure inputs, rest stepper and hand-mode
   buttons load the range directly as they are committed.

**Archiving is visibility, not identity.** A snippet IS its range, rests and
hand mode. `archived` hides a snippet from the list; it does not make it a
different snippet, and two rows with the same identity must never coexist
whatever their archive state — practice history would split across them and
neither total would be right. So matching searches archived snippets too, and a
match that happens to be archived is restored and adopted, keeping its id and its
attached history, rather than duplicated. Its `created_at` is left alone: a
restored snippet is the same snippet it always was, not a new one.

The one place archive state does matter is the offer to save. Save New stays on
offer when the only match is archived, because restoring it is a real action;
it disappears only when a live snippet already covers the combination.

**A snippet is never edited in place.** There is no "save over the selected
snippet" action. A snippet IS its range, rests and hand mode, so changing any of
them makes it a different snippet — which the match-first path finds or creates.
Overwriting the row instead would retroactively rewrite every `sam_passes` and
`sam_sessions` row already pointing at that id: practice history changing under
the user, with nothing recording that it happened. Banking a range without
playing it (Save New) goes through the same match-first path, so it can never
disagree with Play about whether a snippet already exists.

**The full song is not a snippet.** Playing the full song must never create or
select one, not even a snippet spanning every measure, and its passes keep
writing a null `snippet_id`. Full Song stays a distinct state reachable from the
Full Song button, and opening the snippet panel does not leave it — only editing
a control in it does.

## Data model

New table `public.sam_passes`, created by
`docs/migrations/2026-09-14-sam-passes.sql`. One row per completed pass:

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid | primary key |
| `user_id` | uuid | defaults to `auth.uid()` |
| `song_id` | uuid | always set |
| `snippet_id` | uuid, nullable | null means the pass was the whole song |
| `session_id` | uuid, nullable | the sitting it belonged to |
| `bpm` | integer, nullable | tempo at the moment of completion |
| `completed_at` | timestamptz | when the final measure was crossed |

### Why a new table rather than an existing one

`sam_session_events` is per-note telemetry — one row per expected note per attempt,
constrained to `hit`/`miss`, with its audit trigger deliberately switched off
because of volume. A pass is a different kind of thing: low volume, durable,
something worth auditing. Overloading the telemetry table would mean a `result`
value that is neither a hit nor a miss and a row shape where most columns are null.

`sam_sessions.summary` was also considered and rejected. Passes need to survive
independently of sessions and be countable across them, and a session row that ends
null (tab closed mid-practice) would silently lose its passes.

The table is registered with `p_policy_mode => 'owner'` because it carries its own
`user_id`, and `p_audited => true` because the volume is a few dozen rows a day, not
thousands.

## Counting windows

- **Playback screen** shows today's count only.
- **Pause screen** shows today and total, for the song and for each snippet.

"Today" must be computed by whatever the existing "Today: xx minutes" display
already uses. Do not write a second day-boundary helper. If the existing code
buckets by local midnight, passes bucket by local midnight; if it does something
else, passes do the same thing. Two definitions of "today" that disagree by a few
hours is the kind of bug that never gets noticed and never stops being wrong.

## User interface

### Playback screen

`Completed Passes: N` sits immediately to the left of `Today: xx minutes`.

N is today's count for whatever is loaded — the snippet's count when a snippet is
loaded, the song's count when the whole song is. It increments live, without a
refresh, the moment a pass completes.

### Pause screen

Whole-song block, in this order:

```
Practice time
Completed Passes:  Today 2    Total 37
Today: 18 minutes
Total: 4 hours 12 minutes
```

The pass numbers here count song-level passes only — rows where `snippet_id` is
null. Zero is a normal, correct reading and must display as 0, not be hidden.

Then one row per snippet, each carrying its own pass counts and its own practice
time:

```
Snippet title
Completed Passes:  Today 6    Total 41
Today: 22 minutes
Total: 1 hour 5 minutes
```

Snippet practice time comes from `sam_sessions` filtered on `snippet_id`, which
already exists and is already indexed.

## Success criteria

- Looping a song six times with repeat on shows 6.
- Playing twice, stopping, restarting, and playing twice more shows 4.
- Starting mid-song and playing to the end leaves the count unchanged.
- Pausing mid-pass and resuming to the end increments by 1.
- Completing a snippet increments the snippet's count and not the song's.
- Completing the whole song increments the song's count and no snippet's.
- Every row written has a non-null `bpm`.
- A song with no passes today reads 0 on the pause screen rather than blank.
- `check_platform_conformance` returns CONFORMANT after the migration.
- Playing an unsaved range creates exactly one snippet, and playing the same
  range again adopts it rather than creating a second.
- Playing the full song creates no snippet and writes a null `snippet_id`.
- A snippet save that fails still plays.

## Out of scope for now

Pass **goals** — "four to six passes" as a stored target with progress shown as
3/4 — are coming but are not part of this build. The tempo column is being added
now specifically so that when goals arrive they can be tempo-qualified without a
backfill that is impossible to do honestly.
