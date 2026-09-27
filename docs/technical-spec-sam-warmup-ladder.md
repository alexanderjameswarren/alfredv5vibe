# SAM Warm-up Ladder — Technical Spec

Status: approved design, not started. Written 2026-09-27.
Related: `docs/technical-spec-sam-practice-plans.md`, `docs/sam-scoring-definitions.md`.

---

## 1. Purpose

Alex cannot land a passage at target tempo cold. He warms into it, and today that costs him: the
first attempt of a sitting drags down every pooled figure, and the plan counts a fumbled cold run
as an attempt like any other. He already does the right thing by hand — on 2026-09-24 he dropped
bars 20–21 from 40 to 30 BPM, got clean, and went back to 40 — but nothing supports it and nothing
records it.

**The warm-up ladder makes that a feature.** A short range is played at a fraction of its target
tempo until it is reliable, then faster, then at target. The rungs are data, so Claude can write a
ramp for a passage and the app follows it.

**Scope: drills and snippets, typically 1–5 bars.** Not the whole song of a full piece — though a
drill's own song IS in scope, because a drill is already a short range. Short ranges already loop, so
there is no whole-song branch to design.

## 2. Settled decisions (do not re-open)

1. **A ladder is an ordered array of rungs.** Each rung is a tempo percent, an accuracy target, a
   pass count, and whether that count is consecutive or cumulative.
2. **Percent of the TARGET tempo**, not of the song's goal, so a ladder still makes sense when the
   target moves. See §4 for what the target is.
3. **Ladders are NOT plan items.** A pass at 100% would also satisfy a 50% rung, which is the
   double-counting the one-item-per-range rule exists to prevent — and three rungs on one snippet
   would be three items with the same song and snippet, which the unique index rejects. Rungs
   borrow the vocabulary of items, not their table.
4. **Four levels, first one that has a ladder wins:** plan item, then snippet, then song, then the
   app default.
5. **A plan item's ladder overrides the snippet's while the plan is active**, including after the
   item is complete for the day. It is not silent: the player says where the ladder came from.
6. **A plan item can make the warm-up its goal** ("warm-up item"): the item is complete when the
   ladder is finished, not when a pass count is reached.
7. **A streak is within one session.** Consecutive means passes in a row without stopping. Stop or
   pause and the streak is gone, because pause ends a session.
8. **Cumulative counts across a Pacific day**, exactly as plan items work today. It stays the
   default, so nothing existing changes.
9. **Ladder progress is never stored.** It lives in memory for the session. Pressing Warm up always
   starts at rung one.
10. **Ladder passes are recorded as normal passes**, marked with their rung. Lower rungs never
    qualify for a plan item because they are below target tempo; the top rung's passes qualify
    under the existing rules with no special handling.
11. **When the ladder completes it keeps looping at target tempo** until he stops.
12. **Hand mode comes from the snippet.** No per-rung hand mode.
13. **Nothing is ever saved to the song.** The tempo box follows the ladder for the session only.

## 3. The app default ladder

```
[ { target_percent: 70,  accuracy_target: null, target_passes: 2, consecutive: true },
  { target_percent: 85,  accuracy_target: null, target_passes: 2, consecutive: true },
  { target_percent: 100, accuracy_target: null, target_passes: 2, consecutive: true } ]
```

A null `accuracy_target` on a rung means "use the item's accuracy target", or 85% off-plan.

Claude writing a ladder for a hard passage would look like:

```
[ { target_percent: 50,  accuracy_target: 100, target_passes: 2, consecutive: true },
  { target_percent: 70,  accuracy_target: 95,  target_passes: 2, consecutive: true },
  { target_percent: 100, accuracy_target: 95,  target_passes: 3, consecutive: false } ]
```

## 4. Resolving the target tempo and the ladder

**Target tempo**, in order:
1. The plan item's `target_bpm` / `target_playback_speed`, when the loaded range matches an item.
2. Otherwise the song's confirmed goal (`goal_effective_bpm`, only when `goal_set_at` is set).
3. Otherwise whatever is in the tempo box when Warm up is pressed.

Rung tempo = `round(target_effective_bpm * target_percent / 100)`, floored at 20 BPM. If two rungs
round to the same BPM, keep both — the accuracy bar may differ.

**Ladder**, in order: plan item → snippet → song → app default.

**Report which level supplied it** in the player (§7) and in the tools, so a ladder is never a
surprise.

## 5. Data model

### 5.1 The ladder column

A `jsonb` array, same shape everywhere, on three tables:

- `sam_snippets.warmup_ladder`
- `sam_songs.warmup_ladder`
- `sam_practice_plan_items.warmup_ladder`

Null means "fall through to the next level". An empty array means "no warm-up here", which is how
a song or item opts out of an inherited ladder.

Validate on write (a database check or a trigger — decide and say which):
- 1 to 6 rungs, in ascending `target_percent` order
- `target_percent` between 10 and 100; the last rung must be 100
- `accuracy_target` null or 1–100
- `target_passes` at least 1
- `consecutive` boolean, required

### 5.2 Warm-up as a plan item's goal

`sam_practice_plan_items.goal_is_warmup boolean not null default false`.

When true, the item is complete for the day once the ladder has been completed at least once that
Pacific day. Its `target_passes` and `accuracy_target` still apply to the top rung and must still be
supplied, since the ladder's top rung uses them when its own are null.

### 5.3 Consecutive plan items

`sam_practice_plan_items.consecutive boolean not null default false`.

False keeps today's behaviour exactly. True means the item's `target_passes` must be met as a
streak within one session.

### 5.4 Recording ladder passes

On `sam_passes`:
- `warmup_rung smallint null` — 1-based index of the rung this pass belongs to
- `warmup_target_percent smallint null` — that rung's percent, denormalised so analysis does not
  need the ladder that was in force

Both null on an ordinary pass. Add the same two columns to `sam_sessions` if a session is entirely
a warm-up; decide whether that is useful and say so.

**Immutability note:** plan items are immutable after insert, so all three item columns are set at
creation and never change. That is consistent with everything else in a plan.

## 6. How the ladder runs

1. Alex presses **Warm up** on a loaded snippet or drill. A session starts as normal.
2. Resolve the target tempo and the ladder (§4). Start at rung 1: set the tempo box to that rung's
   BPM, turn looping on if it is not already.
3. Each completed pass is evaluated against the CURRENT rung's accuracy target:
   - **Qualifies** → increment that rung's counter.
   - **Does not qualify** → if the rung is `consecutive`, reset its counter to 0; otherwise leave it.
4. When a rung's counter reaches its `target_passes`, advance: set the tempo box to the next rung's
   BPM and reset the counter. The advance happens at the same moment a pass is credited (the rest
   measure, per the existing rule), so the next cycle plays at the new tempo.
5. At the last rung, once its count is met the ladder is **complete**: keep looping at target tempo,
   and stop laddering. Passes continue to be recorded, now with `warmup_rung` set to the last rung.
6. **Stop or pause ends the session and therefore the ladder.** Resuming starts a new session at
   rung 1. This is deliberate: consecutive means without stopping.
7. **Three failed passes at one rung** shows a quiet suggestion in the player: start lower, or
   shorten the range. It never auto-adjusts — a rung that keeps failing is information the next plan
   conversation should get.

**Pause is worth one check during the build:** pause currently ends a session and resume starts a
new one, so a pause breaks a streak. That is the intended behaviour. Confirm it works that way
rather than accidentally continuing.

## 7. UI

### 7.1 The button

A third transport button, **Warm up**, between Play and Practice.

- Outline style by default, matching Practice.
- **Primary style, and first in the row before Play**, when the loaded range matches a plan item
  with `goal_is_warmup` true.
- Label is "Warm up"; after the ladder has been completed in this session it reads "Warm up again",
  and pressing it restarts from rung 1.
- **Shown for snippets and for drills** (§2 scope), and for nothing else: a snippet of any song, or
  a drill played as its whole song. A drill IS a short range — that is what makes it a drill — so it
  gets the button without a snippet. Hidden on the whole song of anything that is not a drill.
  (Corrected 2026-09-27: this bullet used to read "hidden on whole songs", which described a drill's
  own song as out of scope. It is not, and the app was already right.)

### 7.2 While it runs

A compact strip near the plan line:

```
Warm-up  50% ✓✓ · 70% ●○ · 100% ○○○        from the plan
```

- One group per rung: its percent, and a mark per required pass, filled as the count rises.
- The current rung is emphasised; completed rungs are muted.
- The right-hand label says where the ladder came from: "from the plan", "from this snippet",
  "from the song", or "default".
- The tempo box follows the ladder, so the actual BPM is always visible.
- On completion the strip reads "Warm-up complete — looping at 40 BPM".

### 7.3 The plan line

When the loaded range matches a plan item, add one line under the existing plan line:

```
Warm-up · 50% → 70% → 100% · from the plan
```

For a warm-up item, the plan line itself reports ladder progress instead of a pass count:
`Plan · m.20–21 · warm-up · rung 2 of 3 · Both hands land together.`

### 7.4 Editing a ladder

Ladders must be editable without Claude.

- **Snippet:** a Warm-up section in the snippet panel row's editor (or a small dialog from the row)
  — a table of rungs with percent, accuracy, passes, and a consecutive toggle, plus add/remove row.
- **Song:** the same control in the Edit Song dialog, under the goal tempo.
- **Plan item:** read-only in the app. Plans are immutable; changing it means a new plan.
  **Not testable until milestone 4** (noted 2026-09-27): the read-only view is built — it appears in
  the snippet's ladder dialog, above the snippet's own editor, whenever a plan item's ladder overrides
  it — but nothing can WRITE an item ladder yet. `sam_create_practice_plan` takes no ladder argument
  and plan items are immutable after insert, so there is no way to produce the row that makes the
  block appear. **Milestone 4 must test it**: create a plan whose item carries its own
  `warmup_ladder`, load that item's snippet, open the ladder dialog from its row, and check that the
  item's rungs are shown, uneditable, and that editing the snippet's ladder underneath changes nothing
  about what runs.
- Every editor shows the resolved ladder and where it came from, with a "clear" control that sets
  the column back to null (inherit) and a separate way to store an empty array (no warm-up here).

## 8. Tools

- `get_sam_snippets`, `get_sam_songs`, `get_sam_practice_plan`: return `warmup_ladder`, and on plan
  items `goal_is_warmup` and `consecutive`.
- `create_sam_snippet`: optional `warmup_ladder`.
- `update_sam_song_goal`: optional `warmup_ladder` for the song. Tier 3, as now.
- `create_sam_practice_plan`: each item takes optional `warmup_ladder`, `goal_is_warmup` and
  `consecutive`. Validate as §5.1, and reject `goal_is_warmup` on an item whose resolved ladder is
  empty.
- `get_sam_passes`: return and filter on `warmup_rung`.
- `get_sam_measure_stats`: **exclude warm-up passes below the top rung by default**, with a
  parameter to include them. A 50%-tempo pass is not evidence about a bar's difficulty at target
  tempo, and mixing them would quietly corrupt the settled rate.
- `get_sam_plan_progress`: unchanged for cumulative items. For consecutive items it must compute a
  streak within a session, and for warm-up items report ladder completions rather than a pass count.

## 9. The progress function

`sam_plan_item_progress` gains two behaviours. Keep it as the single source of progress — the app
and the tools must never count separately.

- **Consecutive items:** order the day's matching passes by `completed_at`, group by session, and
  find the longest run of qualifying passes within a session. Report that alongside the existing
  cumulative count, so both numbers are visible.
- **Warm-up items:** report how many times the ladder was completed that day. A completion is a
  session in which a pass exists at the top rung meeting that rung's bar, after the lower rungs
  were satisfied. Simplest robust definition: a top-rung pass exists in a session whose earlier
  passes include the required counts at every lower rung. State the definition you implement in the
  function's comment.

## 10. Where the skill fits

`sam-practice` gains: write a ladder for a passage the data shows he cannot land cold; put it on
the snippet when it is a property of the passage, on the plan item when it is this week's decision;
and use a warm-up item when the week's goal is the ramp itself rather than a pass count. Record the
ladder in the plan's internal notes so the next conversation knows why it was set that way.

## 11. Milestones

1. **SQL** — the three ladder columns, `goal_is_warmup`, `consecutive`, the two pass columns,
   validation, and the progress-function changes. Alex runs it.
2. **The ladder engine and the button** — resolution, rung advance, recording, the strip, the plan
   line. No editors yet; test with a ladder written by SQL.
3. **The editors** — snippet and song.
4. **The tools** — read, write, and the measure-stats exclusion.
5. **The skill** — §10.

## 12. Success criteria

- Pressing Warm up on a snippet, or on a drill, starts at the first rung's tempo and advances on the
  rule.
- A failed pass resets a consecutive rung to zero and leaves a cumulative rung alone.
- Stopping or pausing ends the ladder; pressing Warm up again starts at rung one.
- Top-rung passes count toward an ordinary plan item with no special handling.
- Lower-rung passes never qualify, and never appear in measure stats by default.
- The player always says which level supplied the ladder — including the app default, and including a
  range that is in no plan item.
- A warm-up item completes when the ladder completes, and the checklist shows rung progress.
- `check_platform_conformance` returns CONFORMANT after milestone 1.