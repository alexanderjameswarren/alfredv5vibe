# SAM Practice Plans — Technical Spec

Status: approved design, not started. Written 2026-09-16.
Progress tracker: `docs/progress-sam-practice-plans.md`.

---

## 1. Purpose

Alex is past beginner level but can't yet learn any score he downloads. Six months on
Someone Like You never produced a complete run-through. SAM should build purposeful
practice into the app itself:

- Claude writes a practice plan in conversation, and Alex approves it.
- The plan shows on the Sam tab as a short checklist that crosses itself off as he plays.
- Each plan item says exactly what to play, how fast, how accurately, and how many times.
- A daily job notices when the plan is too hard or too easy, and drops a note in Alfred
  so Alex starts a conversation about the next plan.

Nothing here lets Claude change a plan without Alex. Plans are approved in chat and
never edited after they are saved.

## 2. Settled decisions (do not re-open)

1. **A plan is a flat list of items.** No sittings or segments.
2. **Plans are never edited.** Any change creates a new plan that supersedes the old one.
   The old plan stays for history.
3. **Three levels:** plan → plan songs → plan items.
4. **One accuracy target per item.** "M1–5 at 60 BPM, 90%, 4 passes." A pass counts only if
   it meets both the tempo and the accuracy target. Three counting passes shows 3/4.
   Passes that miss are still stored and visible to Claude.
5. **Tempo:** a pass counts if its heard tempo is at or above the target. Faster always counts.
6. **Optional Free Play items** have a tempo target but no accuracy target. They are counted
   separately so skipping them never makes the day look unfinished.
7. **Tempo is stored as BPM plus speed %.** Every comparison uses the heard tempo:
   `round(bpm * speed / 100)`. See §4 for the tempo rules, which are strict.
8. **Approval happens in conversation.** Claude calls the create tool only after Alex says yes.
   The new plan is active immediately. There is no in-app approval screen.
9. **Mid-day plan change:** the checklist counts any of today's passes that fit the new plan's
   items, even ones played under the old plan. The link stored on each pass is not rewritten.
10. **Zero-note passes never count** and are ignored when reading history. Alex tests on a
    desktop with no piano.
11. **Snippets made on the fly are fine.** Passes on a snippet the plan doesn't include still
    record the active plan, so the daily job can see the improvisation.
12. **Skipping an item produces nothing.** No alerts for skips.
13. **Review rules are soft.** Claude writes plain-language review instructions on each plan.
    The daily job writes a review note once they are met. If a note already exists, the job
    does nothing.
14. **Goals list:** songs to learn, techniques, and chord progressions, each with a status.
    Claude maintains it through tools. No app screen yet.
15. **No assessment table.** Progress is read from passes. A full run-through is just a plan item.
16. **Measure numbers are played numbers** (repeats written out), the same numbers snippets use
    and the large numbers on the score. Printed numbers appear in parentheses on screen.
    Plan text uses played numbers, adding the printed number in parentheses when it helps
    Alex find the bar: "m.37 (22)".
17. **Claude sets goal tempos**, always with Alex's confirmation. A goal is "confirmed" once
    `goal_set_at` is filled. Placeholder goals are never treated as targets.

## 3. Existing system this builds on (verified 2026-09-16)

- **Scoring definitions: `docs/sam-scoring-definitions.md`** — what hit / miss / partial /
  extra mean, that accuracy is hits / (hits + misses) with partials outside the ratio, that a
  corrected wrong key still scores as a hit, the timing sign (positive = early), and why the
  same passage at different `windowMs` settings is not comparable. Read it before computing
  anything from practice data.
- `sam_passes`: one row per completed playthrough. Records `song_id`, `snippet_id` (null means
  whole song), `session_id`, `bpm`, `playback_speed`, generated `effective_bpm`, `hits`,
  `misses`, `notes_played`, `hand_mode`, generated `accuracy_percent` (null when nothing was
  measured). Written only by `recordPass` in `useSamPasses.js`.
- `sam_sessions`: one row per sitting. `summary` jsonb holds session accuracy.
- `sam_snippets`: measure range plus hand mode. The same bars in a different hand mode are a
  different snippet.
- `sam_songs`: `goal_bpm`, `goal_playback_speed`, generated `goal_effective_bpm`.
- "Today" is Pacific time (`America/Los_Angeles`), computed in the app through `ptDateKey`.
- `get_sam_song_scores`: per-measure difficulty at a chosen tempo, defaulting to
  `goal_effective_bpm`.
- Platform contract v1 governs every table and tool (`mcp-platform` skill).

## 4. Tempo rules (strict)

- **Always compare heard tempos.** Passes: `effective_bpm`. Songs: `goal_effective_bpm`.
  Plan items: `target_effective_bpm`.
- **Never read `goal_bpm` or `default_bpm` as a target.** On songs with audio, `default_bpm`
  is the scroll-sync calibration, `goal_bpm` is forced equal to it, and the real goal lives in
  the speed %. Reading `goal_bpm` there gives a believable wrong number with no error.
- **BPM means quarter notes per minute everywhere,** including 6/8.
- **Writing a tempo for a song with audio:** BPM must equal the song's `default_bpm`; the target
  is expressed through speed %. **Without audio:** speed is 100 and BPM is the target.
  "Has audio" means `sam_songs.audio_file_path is not null`.
- A pass with null `effective_bpm` (recorded before 2026-09-16) never counts.

## 5. Data model (Milestone 1 — SQL, run by hand)

All new tables carry `user_id uuid not null default auth.uid()` and register with
`p_policy_mode => 'owner'`, `p_audited => true`. Every column gets a comment.

### 5.1 `sam_practice_plans`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid | |
| status | text not null | `active` or `superseded`. Partial unique index: one `active` per user. |
| starts_on | date not null | Pacific date the plan began |
| ended_at | timestamptz null | set when superseded |
| supersedes_plan_id | uuid null | fk → sam_practice_plans |
| day_note | text null | **visible** daily goal, e.g. "Improve speed on Autumn Leaves." |
| internal_notes | text null | Claude only: reasoning behind the plan |
| review_instructions | text not null | Claude only: when the daily job should post a review note |
| review_note | text null | written by the daily job |
| review_noted_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

After insert, only `status`, `ended_at`, `review_note`, `review_noted_at` and `updated_at` may
change. A trigger rejects changes to any other column.

### 5.2 `sam_practice_plan_songs`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid | |
| plan_id | uuid not null | fk → plans, on delete cascade |
| song_id | uuid not null | fk → sam_songs, on delete cascade |
| position | smallint not null | |
| song_note | text null | **visible** song goal, e.g. "Master m.16–17, then start m.18." |
| internal_notes | text null | Claude only |
| created_at | timestamptz | |

Unique `(plan_id, song_id)`. Unique `(id, plan_id, song_id)` so items can reference all three.
Rows are immutable: a trigger rejects every update.

### 5.3 `sam_practice_plan_items`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid | |
| plan_id | uuid not null | |
| plan_song_id | uuid not null | composite fk `(plan_song_id, plan_id, song_id)` → plan_songs, on delete cascade |
| song_id | uuid not null | |
| snippet_id | uuid null | null = whole song. Composite fk `(snippet_id, song_id)` → sam_snippets, so a snippet must belong to the item's song |
| position | smallint not null | order in the checklist, across the whole plan |
| is_free_play | boolean not null default false | |
| target_bpm | integer not null | > 0 |
| target_playback_speed | integer not null default 100 | > 0 |
| target_effective_bpm | integer generated | `round(target_bpm * target_playback_speed / 100)` |
| target_passes | smallint not null | > 0 |
| accuracy_target | smallint null | 1–100. Required when not free play; must be null for free play |
| instruction | text null | **visible**, one short line: "Count out loud." |
| created_at | timestamptz | |

Unique `(plan_id, song_id, snippet_id) nulls not distinct` — one item per exact range per plan,
so a pass never counts toward two items. Rows are immutable.

Supporting change: add unique `(id, song_id)` on `sam_snippets` for the composite fk.

### 5.4 `sam_goals`

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| user_id | uuid | |
| title | text not null | "Play Someone Like You start to finish" |
| kind | text not null | `song`, `technique`, `progression` |
| status | text not null default `someday` | `someday`, `active`, `done`, `dropped` |
| song_id | uuid null | fk → sam_songs, on delete set null |
| notes | text null | |
| completed_at | timestamptz null | |
| created_at, updated_at | timestamptz | |

### 5.5 Links on existing tables

On both `sam_passes` and `sam_sessions`:

- `plan_id uuid null` fk → sam_practice_plans, on delete set null
- `plan_item_id uuid null` fk → sam_practice_plan_items, on delete set null

Indexed. Historic rows stay null.

### 5.6 `sam_songs.goal_set_at`

`goal_set_at timestamptz null`. Null means the goal is a placeholder.

- **On update**, a trigger sets it to `now()` when the goal changes deliberately: when
  `goal_playback_speed` changes, or when `goal_bpm` changes on a song without audio. A goal_bpm
  change on a song with audio is only a calibration change and doesn't count. An explicit write
  to `goal_set_at` is kept as written.
- **On insert**, a simplified song whose goal pair matches its parent's copies the parent's
  `goal_set_at`. Everything else starts null, including a goal carried in an imported file,
  since it hasn't been reviewed in this library.
- **Backfill:** fill `goal_set_at` for songs whose goals were hand-set (from the platform audit
  log, confirmed against a list before applying).

No app change is needed for this. The Edit Song dialog already writes the goal columns.

### 5.7 Database functions (SQL, `security invoker`, owner rows only)

One function computes plan progress, so the app and Claude count passes the same way.

**`sam_plan_item_progress(p_plan_id uuid, p_from date, p_to date)`** returns one row per item
per Pacific day that has at least one attempt:
`plan_item_id, day, attempts, qualifying, best_accuracy, best_effective_bpm, last_completed_at`.

- A pass **matches** an item when `song_id` is equal and `snippet_id` is equal (both null = whole song).
- **Attempt:** matches, and `notes_played > 0`.
- **Qualifying:** an attempt with `effective_bpm >= target_effective_bpm`, and for non-free-play
  items `accuracy_percent >= accuracy_target`.
- Day = `(completed_at at time zone 'America/Los_Angeles')::date`.
- Matching ignores `sam_passes.plan_item_id` (decision 9).
- Range capped at 31 days.

**`sam_plan_unplanned_practice(p_plan_id uuid, p_from date, p_to date)`** returns attempts per
song, snippet and day that match no item in the plan:
`song_id, snippet_id, day, attempts, best_accuracy, best_effective_bpm`. Same attempt rule, same cap.

**`sam_create_practice_plan(p_plan jsonb)`** writes a whole plan in one transaction: supersedes
the current active plan (status, ended_at), inserts the plan, its songs and items, and returns
the new plan id. It validates everything in §6.2 and rejects the whole plan on any failure.

## 6. Claude tools (Milestone 3)

All built with `defineTool`, `ctx.db` only, bare data payloads, clamped limits, schema and
handler parity.

### 6.1 Reads (tier 1)

- **`get_sam_practice_plan`** — `plan_id` (optional, default the active plan). Returns the plan
  with all fields, its songs (title, notes, goal tempo and `goal_set_at`), and items (song title,
  snippet title and range and hand mode, targets, instruction). Includes the internal fields;
  this is Claude's view.
- **`get_sam_practice_plans`** — `status`, `song_id`, `limit`. Plan history, newest first. With
  `song_id`, returns only plans containing that song, with that song's notes and items from each.
- **`get_sam_plan_progress`** — `plan_id` (default active), `date_from`, `date_to` (Pacific dates,
  default the plan's start through today, capped at 31 days). Returns both progress functions'
  results, joined to item and song names.
- **`get_sam_goals`** — `status`, `kind`, `song_id`, `limit`.
- **Existing `get_sam_passes` and `get_sam_sessions`** gain `plan_id` and `plan_item_id` as
  filters and returned columns.

### 6.2 Writes

- **`create_sam_practice_plan`** — tier 3. One call with the whole plan:
  `day_note, internal_notes, review_instructions, songs[{song_id, song_note, internal_notes,
  items[{snippet_id?, is_free_play, target_bpm?, target_playback_speed?, target_passes,
  accuracy_target?, instruction?}]}]`. Calls `sam_create_practice_plan`.
  Validation (all or nothing):
  - Every song exists and isn't archived. Every snippet exists, belongs to its song, and isn't archived.
  - Non-free-play items require a tempo and an accuracy target. Free play forbids an accuracy
    target, and its tempo defaults to the song's goal pair when omitted.
  - Tempo follows §4: songs with audio require `target_bpm = default_bpm`; songs without audio
    require speed 100.
  - `review_instructions` required. At most 20 items. Item position follows array order.
- **`update_sam_plan_review_note`** — tier 2. `plan_id`, `review_note`. Refuses if the plan
  isn't active, or if a review note already exists (returns the existing note; never overwrites).
- **`update_sam_song_goal`** — tier 3. `song_id` plus `goal_bpm` (songs without audio) or
  `goal_playback_speed` (songs with audio), or `confirm_only: true` to mark the current goal as
  real. Applies §4. Always writes `goal_set_at = now()`.
- **`create_sam_goal`** — tier 1. `title, kind, status?, song_id?, notes?`.
- **`update_sam_goal`** — tier 2. `goal_id` plus any of `title, status, song_id, notes`.
  Status `done` sets `completed_at`. No delete; use `dropped`.
- **`create_sam_snippet`** — tier 1. Added 2026-09-17 so a plan can use snippets the app has not
  made yet.
  - **Intended flow:** Alex approves a plan in conversation, Claude creates any snippets it needs
    with this tool, then passes their ids to `create_sam_practice_plan` as `snippet_id`.
  - **Input:** `song_id`, `start_measure`, `end_measure` (played measure numbers), plus
    `hand_mode` (`both | lh | rh`, default `both`) and `rest_measures` (≥ 0, default 0). There is
    no title, tags or notes input.
  - **Validation.** Any failure writes nothing:
    - the song exists and isn't archived;
    - `start_measure` ≥ 1;
    - `end_measure` ≥ `start_measure`;
    - `end_measure` ≤ the song's highest `sam_song_measures.number` (a song with no measures is
      refused).
  - **Behaviour** is the app's `ensureSnippetSaved`. It matches first on the app's identity rule
    (song, `start_measure`, `end_measure`, `rest_measures` with null = 0, and `settings.handMode`
    with missing = `both`), archived rows included.
    - A live match is returned unchanged.
    - If only an archived snippet matches, it is restored (`archived = false`), keeping its id and
      `created_at`.
    - Otherwise a new row is inserted with exactly what the app writes: `song_id`, `title` (the
      app's `formatSnippetTitle`, e.g. "Measures 17-17 RH No Rest"), `start_measure`,
      `end_measure`, `rest_measures` and `settings = {handMode}`. Everything else takes the
      column defaults.
    - Tempo, timing window and chord grouping are never stored on a snippet; the song's defaults
      apply.
  - **Returns** bare data, id first: `{ id, song_id, title, start_measure, end_measure,
    rest_measures, hand_mode, archived, created_at, created, restored }`. Repeated calls are safe
    and never duplicate. The database has no uniqueness constraint, so matching first is the only
    guard.

## 7. App changes

### 7.1 Data cleanup (Milestone 2)

- **On-screen Hits excludes partial chords,** matching `sam_passes.hits` and stored accuracy.
- **Session accuracy shows "—" when nothing was measured,** not 0%. New session summaries store
  `accuracyPercent: null` in that case. Historic rows are not rewritten.

### 7.2 Recording links (Milestone 4)

- `recordPass` writes `plan_id` (the active plan, if any) and `plan_item_id` (the item matching
  this song and snippet, if any) on every pass.
- Session creation writes the same two fields.
- The active plan is loaded once when SAM opens and refreshed after returning to the home page.

### 7.3 Checklist strip (Milestone 4)

On the SAM home page, directly above the 7-day practice snapshot. Hidden when there is no active plan.

**Collapsed (default):** one line. "Today's plan · 3 of 6 · Free play 1 of 2", then the day
note, truncated to one line.

**Expanded:** the full day note, then items in order. Each shows:
- song title, plus snippet title when there is one
- target, e.g. "60 BPM · 90% · 4 passes", or "78 BPM · 2 passes" for free play
- instruction, when there is one
- progress "2/4"

Behaviour:
- An item with qualifying passes ≥ target is crossed off with a check mark.
- An item with attempts today but none qualifying is shown in amber.
- Free play items sit last, under an "Optional Free Play" label.
- Tapping an item opens its song, loads its snippet if any, and applies the target BPM and speed
  to the tempo box for this session. It never saves tempo to the song.
- Progress comes from `sam_plan_item_progress` for today only. Never count passes separately
  in the client.
- Expanded or collapsed state is remembered in browser storage.

### 7.4 Player display (Milestone 5)

When the loaded song or snippet matches a plan item:
- **Plan line**, placed with the pass figures in the stats row: "Plan: 60 BPM · 90% · 2/4 today ·
  Count out loud", plus a **Set tempo** button that applies the item's BPM and speed to the tempo
  box without saving. Amber and crossed-off states follow §7.3. It updates after each recorded pass.
- **Song note:** when the loaded song is in the plan, its visible song note shows as one muted line
  under the plan line (or alone, if the loaded range has no item).
- **While playing:** the focused playback bar shows a compact "Plan 2/4" next to Completed Passes.
- **Snippet rows:** a planned snippet's row in the Snippet panel gets a small tag, "Plan · 60 BPM ·
  2/4", with a check when done.
- **Goal label** by the tempo box: "Goal 75". Shown only when the song's `goal_set_at` is filled.
  Amber when the current heard tempo is below the goal. Tapping it applies the goal to the tempo box
  for this session.

## 8. Practice skill (Milestone 6 — written in chat, not by Claude Code)

A skill file, `sam-practice`, drafted in the SAM chat project and uploaded by Alex. It covers:
- Reading history: ignore zero-note passes and sessions; Pacific days; heard tempos only; treat a
  goal with null `goal_set_at` as unconfirmed; no whole-song difficulty aggregates on songs with
  repeats (repeated bars are counted twice).
- Writing plans: principles already recorded (warm-up then main work then optional cooldown,
  5–8 reps per sitting, short sittings, stop hands-together below 70%, hand span no wider than a
  major 7th, repertoire breadth); using `get_sam_song_scores` to target hard measures; played
  measure numbers with printed numbers in parentheses when helpful.
- The plan conversation: propose in chat, revise, create only after an explicit yes.
- Writing review instructions the daily job can apply.
- Maintaining the goals list and confirming goal tempos through tools.

The first real plan is written with it.

## 9. Daily review job (Milestone 7 — set up in chat)

A scheduled Claude task, once each morning Pacific, using a small `sam-plan-review` skill.
It uses the same scheduling mechanism as the DJ weekly review, and logs through
`platform_schedules` and `platform_runs`.

Each run:
1. Log the run start.
2. Load the active plan. If none, end the run as "no plan".
3. If `review_note` is already set, end the run as "skipped".
4. Load progress and unplanned practice from the plan's start (up to 31 days), and snippets
   created on plan songs since the plan started.
5. Judge against `review_instructions`. Also consider new snippets and heavy unplanned practice
   as signals. Skips alone are never a reason.
6. If a review is due: write the review note with `update_sam_plan_review_note`, then create an
   Alfred inbox item with `create_inbox_item`. The inbox item's text is a ready-to-paste prompt
   that starts a plan conversation and summarises what triggered it.
7. Close the run with its outcome.

## 10. Success criteria

- A plan created in chat appears on the Sam tab within one home-page refresh.
- Playing a planned snippet at or above target tempo and accuracy advances its count. Playing
  below either target does not, and turns it amber.
- Zero-note passes never change any count.
- The app checklist and `get_sam_plan_progress` always agree for the same day.
- A superseded plan and all its passes remain readable through the history tools.
- Claude can answer "how has Pastorale gone across the last three plans?" from tools alone.
- The daily job never writes a second note on a plan and never creates or changes a plan.
- `check_platform_conformance` returns CONFORMANT after Milestone 1.
