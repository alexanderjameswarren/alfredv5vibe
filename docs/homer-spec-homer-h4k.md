# Homer — technical spec (slice 1: Kindle books)

Project code: `homer-h4k`. Progress: `docs/progress-homer-h4k.md`.
Written at step s3 (2026-11-09) from the s1 analysis and the s2 plan, both confirmed by Alex.

## What Homer is

Homer keeps track of what Alex reads and suggests what to read next. Slice 1 covers Kindle books only.
Alex and Elise share one Amazon account but never share a device, so the device is how their reading
is told apart. Elise's friend Vasti also uses the shared library.

The skill holds the method. The rules Alex tunes live in a versioned plan row, as in Arnold and Overwatch.

Data source: the Amazon data export (`Kindle.zip`), analysed at s1 into
`C:\Users\Alex\Downloads\homer-analysis\` (devices.csv, finished_books.csv, series_summary.csv,
started_not_finished.csv, summary.json, plus `export\` holding the extracted files). None of it goes into git.

## Decisions

### Readers and devices
- Readers: **Alex, Elise, Vasti**.
- Device labels so far:
  - Android `77750d31…` → `93aac836…`: **Alex** (phone line; handover 2026-02-10)
  - Android `33de64f8…` → `3e016c89…`: **Elise** (phone line; handover 2025-10-25)
  - iOS `ADCA140A…`: **Vasti**
  - Kindle e-reader `G6G3KM01…` "Alexander's Kindle": **Alex**
- The other ~33 devices have no owner yet. Claude proposes owners by **series continuity**: a device that read
  part of a series that a labelled reader later went on with probably belongs to that reader. Claude shows Alex
  a short list, newest device first, and he confirms each one. A proposal is stored in `proposed_reader_id`; a
  confirmation sets `reader_id`. `owner_status` is a generated column (confirmed / proposed / unknown), so it can
  never disagree with the two ids. Until a device has a confirmed owner, its reads have no reader.
- **Carrying the owner onto reads happens in the database**, not in a tool: `homer_reads_fill_reader` gives a new
  read on a device that device's owner, and `homer_devices_carry_reader` moves the device's reads to the new owner
  when it is confirmed or changed. A read whose reader was set by hand to someone else is left alone.
- **Slice 1 suggestions are for Alex only.** Elise's and Vasti's reads are stored, but they get no view or
  suggestions yet. Elise's view is a later slice.

### Verdicts (separate from queue status)
- A verdict is about a **series, a book or an author**: `loved`, `liked`, `tired`, `didnt_click`, `never`, plus a note.
- **Default rule**, set in the plan: 2 or more books finished in a series = `liked`; 1 book, or part of one = `didnt_click`.
  The default is worked out when it's read (`homer_series_verdicts`) and never stored, so a plan change takes effect at once.
  A stored verdict always beats the default.
- **`never` only when Alex says it.** The row records who set it (`set_by = 'alex'`, enforced by the check
  `homer_verdicts_never_by_alex`), and the only tool that writes it is tier 3. **Only Alex lifts a `never`** either:
  the trigger `homer_verdicts_guard` refuses to change a `never` to anything else unless `set_by = 'alex'`.
- **`tired`** means he liked it and burned out (for example The Ten Realms and The Primal Hunter). It counts as liked
  when looking for similar books. The series itself comes back as "pick it up again?" once the plan's `tired_gap_days`
  has passed since he last read it, and only when the mood matches.
- Everything except `never` can still be suggested.

### Queue status (separate from verdicts)
- `queued`, `maybe_later`, `reading`, `read`, `never`.
- One loose queue per genre. Adding, moving and dropping must be cheap: one call each, no confirmation.
  Order is a fractional `position`, so a move updates one row. Dropping sets `archived_at`; nothing is hard-deleted.

### Taste profiles
- One per series per reader: Alex's free-text description, plus `scores` on the scales the plan lists.
- `scores` is jsonb keyed by scale key. It is **checked against the active plan's scales by the trigger
  `homer_taste_scores_check`, never by a check constraint**, so scales can be added or dropped with a new plan version
  and no migration. A trigger (rather than only an RPC) means every write path is checked. The trigger and the tools
  share one validator, `homer_scores_problem(scores, settings)`, so the tools' early refusals and the database agree.
  Unknown keys are refused, and so are values outside a scale's range or choices. The check runs only when `scores`
  itself is written: a score on a scale that a later plan dropped survives edits to the description, but rewriting
  the scores without dropping it is refused.
- Starting scales (plan v1 `settings.scales`):

  | key | label | kind | values |
  |---|---|---|---|
  | `tone` | Tone | range 1–5 | 1 light … 5 dark |
  | `humor` | Humor | range 1–5 | 1 none … 4 constant, 5 "degenerates into silly" |
  | `harem` | Harem level | choice | none, mild, big, absurd |
  | `explicitness` | Explicitness | range 1–5 | 1 none … 5 very explicit |
  | `danger` | Danger to main characters | range 1–5 | 1 nobody important gets hurt … 5 anyone can die |
  | `power` | Underdog vs overpowered | range 1–5 | 1 underdog … 5 overpowered from the start |
  | `growth` | Crafting vs training | choice | training, crafting, both, neither |
  | `setting` | Setting | multi-choice | urban, nobility, isekai, dungeon, apocalypse, space, cultivation, academy, other |

### Genres
- A genre is a named cluster of series, with example series and a description.
- Claude proposes them (`status = 'proposed'`). Alex names them, edits them and accepts them.

### The Homer plan
- Same pattern as Arnold (`arnold_plans`) and Overwatch (`overwatch_plans`): versioned and never edited in place.
  Exactly one plan is active per user, and a superseded plan can never become active again (guard trigger).
- Settings are validated by `homer_plan_settings_problem(settings)`, both in `create_homer_plan` and in the check
  constraint `homer_plans_settings_valid`, so even a direct insert can't store bad settings.
- `create_homer_plan` is **tier 3**. Alex says what to change, Claude drafts the whole new version, the tool returns a
  readable proposal, and Alex approves it. Only then is it saved.
- `instructions` (text) holds the taste rules and what Alex wants in suggestions, in his words.
- `settings` (jsonb object) holds:
  - `scales`: array of `{ key, label, kind: 'range'|'choice'|'multi', min?, max?, labels?, choices? }`
  - `default_verdict`: `{ liked_min_finished: 2, otherwise: 'didnt_click' }`
  - `tired_gap_days`: number, starting at 180
  - `quiet_after_days`: number, starting at 120. A series counts as gone quiet after this long with no read.
  - `suggestions`: `{ for_readers: ['alex'], per_round: 5, require_verified: true, prefer_kindle_unlimited: true }`
- Plan v1 is written in phase H, through the tool, from the seed examples below. Nothing is seeded by migration.

### Suggestions
- Before anything is written to a queue, Claude checks **in chat with web search** that the book exists and whether
  it is on Kindle Unlimited. It records `verified_on`, `on_kindle_unlimited` and `ku_checked_on`. The CLI never does
  this check. This is a skill rule, and the queue tool also refuses a row with no `verified_on`.
- Kindle links are built from the ASIN and never stored: `https://read.amazon.com/?asin=<ASIN>` and
  `https://www.amazon.com/dp/<ASIN>`.

## Tables (phase B, `supabase/migrations/224_homer_core.sql`)

Every table has `id uuid`, `user_id uuid default auth.uid()`, `created_at`, owner RLS, comments on the table and
every column, and `platform.register_table(..., p_audited => true)`, which also grants (Rule 2b).

| Table | Purpose and key columns |
|---|---|
| `homer_plans` | The plan. `status` active/superseded, `version`, `instructions`, `settings` jsonb, `change_summary` (required when it supersedes), `supersedes_plan_id`, `written_by` alex/claude, `ended_at`. Unique active per user. Guard trigger `homer_plans_guard`. |
| `homer_readers` | `key` (alex, elise, vasti), `name`, `notes`. Unique (user_id, key). |
| `homer_devices` | `device_id` (the export's id), `family`, `friendly_name`, `reader_id` (confirmed owner), `proposed_reader_id`, `owner_status` (generated: confirmed/proposed/unknown), `owner_reason`, `first_session`, `last_session`, `sessions`, `hours`. Unique (user_id, device_id). Trigger `homer_devices_carry_reader`. |
| `homer_series` | `name`, `series_asin` (from UnifiedLibraryIndex), `author`, `notes`. Unique (user_id, series_asin) where there is one; **a name is unique only for series with no series ASIN**, so two real series that share a name don't collide. |
| `homer_books` | `asin`, `title`, `author`, `series_id`, `series_position` numeric, `acquired` purchase/kindle_unlimited/prime_reading/sample/library/other, `content_type`. Unique (user_id, asin). |
| `homer_reads` | `book_id`, `device_id` (fk, nullable), `reader_id` (nullable until the device has an owner), `started_on`, `finished_on` (null = not finished), `hours`, `completion` automatic/manual/null, `source` export/clip/chat, `import_key` (unique per user, so imports are idempotent). One per book per device (partial unique index); clip and chat reads have no device. A read needs a reader or a device. Trigger `homer_reads_fill_reader`. |
| `homer_verdicts` | `reader_id`, `subject_kind` series/book/author, then exactly one of `series_id`, `book_id`, `author`; `verdict` loved/liked/tired/didnt_click/never, `note`, `set_by` alex/claude. Check: `verdict = 'never'` requires `set_by = 'alex'`. Unique per reader and subject. Trigger `homer_verdicts_guard`: only Alex lifts a never. |
| `homer_taste_profiles` | `reader_id`, `series_id`, `description`, `scores` jsonb, `plan_id` (the version the scores were checked against). Unique (reader_id, series_id). Scores trigger `homer_taste_scores_check`. |
| `homer_genres` | `name`, `description`, `status` proposed/accepted, `sort_order`, `archived_at`. |
| `homer_genre_series` | `id`, `user_id` (for owner RLS and fetching by id), `genre_id`, `series_id`, `is_example`. Unique (genre_id, series_id). |
| `homer_queue_items` | `genre_id` (**nullable: not sorted into a genre yet**), `reader_id`, `kind` book/series/pick_up_again, `title`, `author`, `asin`, `series_id`, `book_id`, `why`, `on_kindle_unlimited`, `ku_checked_on` (required with it), **`verified_on` (not null)**, `status` queued/maybe_later/reading/read/never, `position` numeric, `created_by`, `updated_at`, `archived_at`. One live item per reader per ASIN. |

## Functions

| Function | Phase | What it does |
|---|---|---|
| `create_homer_plan(p_instructions, p_settings, p_change_summary, p_written_by)` | B | Supersedes the active plan in one transaction and validates `settings` (scales well formed, keys unique, numbers in range). Returns the new row. Behind the tier-3 tool. |
| `homer_plan_settings_problem(settings)` | B | Validator: null when settings are valid, else the first problem. Used by the RPC and the check constraint. |
| `homer_scores_problem(scores, settings)` | B | Validator: null when scores fit the settings' scales, else the first problem. Used by the trigger and the tools. |
| `homer_plans_guard()` | B | Trigger. A plan row may change only from status active to superseded, plus `ended_at`. |
| `homer_taste_scores_check()` | B | Trigger. Checks `scores` against the active plan's scales when they're written, and stamps `plan_id`. |
| `homer_reads_fill_reader()` | B | Trigger. A read with a device and no reader takes the device's confirmed owner. |
| `homer_devices_carry_reader()` | B | Trigger. When a device's owner changes, its reads with no reader or the old owner move to the new one. |
| `homer_verdicts_guard()` | B | Trigger. A `never` can be changed only with `set_by = 'alex'`. |
| `homer_series_verdicts(p_reader_key default 'alex')` | B (225) | Each series the reader has read or has a stored verdict on: books finished and started, highest position finished, last finished and last read dates, the stored verdict, the effective verdict (stored, else the plan's default) and `is_default`. With no active plan, a default verdict is null. |
| `homer_quiet_series(p_reader_key default 'alex')` | B (225) | Every series the reader liked, loved or tired of (stored or default), not only the quiet ones. Each row has an `is_quiet` flag (days since the last read ≥ the plan's `quiet_after_days`) and, for tired series only, `tired_gap_passed` (≥ `tired_gap_days`). Leaves out `never` and `didnt_click`. Returns the last finished book and its position, the last read date, days since, and the next book the library holds (position, title, ASIN). Longest quiet first. With no active plan the list is empty, since default verdicts are null. Example: He Who Fights with Monsters, book 12 last read on 2025-09-09. |
| `homer_import_batch(p_batch, p_dry_run default true)` | C (226) | See phase C. |

Every function is `security invoker` (RLS applies) and `revoke all … from public, anon`. The two queries are granted to `authenticated, service_role`; `homer_import_batch` to `authenticated` only, because only Alex's token calls it.

## Phases

### A. Spec (s3)
This file and the progress file, plus the claims.

### B. Schema
`supabase/migrations/224_homer_core.sql`: all the tables, `create_homer_plan`, the two validators and the five triggers.
`supabase/migrations/225_homer_queries.sql`: `homer_series_verdicts` and `homer_quiet_series`.
Tests in `supabase/tests/homer-h4k/`: `1_verify.sql` (tables, RLS, grants, registered), `2_guards_test.sql` (plan
immutability, one active plan, never only from alex, a score outside a scale refused, a new scale accepted after a new
plan) and `3_queries_import_test.sql` (default verdicts, quiet series and the tired gap, and the import RPC: limits,
dry run, idempotence, owners; on fixture rows inside a self-undoing block). Queued with `--test`. Both migrations go through the db steps: gitsync, drift check,
`number-migration`, queue, verify, `check_platform_conformance`, Checkpoint.

### C. Import (Alex chose the script route)
- `supabase/migrations/226_homer_import.sql`: `homer_import_batch(p_batch jsonb, p_dry_run boolean default true)`.
  `p_batch` is one object of arrays `{readers, devices, series, books, reads}`, at most 500 rows in all, processed in
  that order. It upserts on natural keys (reader key, device_id, series_asin or name, asin, import_key), updating a row
  only when a field differs, so a second run changes nothing. A bad row is refused with its reason and the rest go on.
  It returns `{ dry_run, rows, counts: {kind: {inserted, updated, unchanged, refused}}, refused: [{kind, key, reason}] }`.
  A dry run does the same work inside a block that rolls itself back, so its counts are the real ones.
  A device owner in a batch is set (and may replace a different one); a batch without an owner never clears one.
  A read's reader comes from its device (`homer_reads_fill_reader`) and is never overwritten by the import.
  It is the single implementation: nothing else writes import rows.
- `scripts/homer-import.mjs` (CLI) and `scripts/lib/homer-import.mjs` (pure mapping, tested by `scripts/lib/homer-import.test.mjs`
  under `node --test`). The script reads `C:\Users\Alex\Downloads\homer-analysis\` and posts to
  `/rest/v1/rpc/homer_import_batch` with Alex's access token, as the DJ Takeout import does. Batches are
  **self-contained**: each carries the readers, devices, series and books its reads need, so every batch dry-runs on
  its own before anything is applied. Shared rows repeat, and come back "unchanged" once applied; a dry run counts
  them as new in each batch. The real export makes 7 batches. With no flag it only dry-runs and prints the counts.
  With `--apply`, each batch is dry-run first and applied only if nothing was refused (`--allow-refused` overrides).
  The token is read from `HOMER_TOKEN` and never printed.
- **No reading history goes into git, and the data never passes through a model.**
- Mapping:
  - readers: the three above.
  - devices: `devices.csv` (38 rows), plus the five labels above as `owner_status = 'confirmed'`.
  - series and positions: `export\…\Kindle.UnifiedLibraryIndex.CustomerRelationshipIndex.1.1.csv`, "Series Title"
    (with the trailing series ASIN split off into `series_asin`) and "Position In Collection".
  - books: every ASIN in the reading sessions or the finished list, with title and author from UnifiedLibraryIndex.
    `acquired` comes from `Digital.Content.Ownership` `rights[].origin.originType`, in the order
    Purchase > KindleUnlimited > Prime > Sample, then PublicLibraryLending → library, anything else → other.
  - reads: one per (book, device) from the sessions (sessions under 60 seconds left out, each session capped at 4 hours).
    `started_on` is the first session (never after the finish) and `hours` the total. The finished record (date and
    AUTOMATIC/MANUAL) goes on its `main_device_id`, or else the device with the most time on that ASIN. A book finished
    twice on one device keeps the later date (593 finish rows become 589 finished reads). A (book, device) pair is
    kept only with 30 minutes or more of reading, or when it holds the finish; shorter pairs are noise.
    Started-but-not-finished reads have `finished_on` null.
    `import_key = 'export:<asin>:<device_id>'`. `reader_id` comes from the device's owner, or null.
  - When a device owner is confirmed later, `homer_devices_carry_reader` sets `reader_id` on that device's reads.

### D. MCP tools (`supabase/functions/_shared/tools/homer.ts`, registered in `supabase/functions/mcp/index.ts`)
`supabase/functions/mcp/index.ts` and `supabase/functions/mcp/index.test.mjs` are held by switchboard2-h8r. Phase D
claims them when it starts, and stops if they are still held. Every tool goes through `defineTool` and declares `tables`.
Lists use `readTable`. The mcp function is deployed and then checked with `check_platform_conformance`.

| Tool | Tier | |
|---|---|---|
| `get_homer_plan` | 1 | Active plan; `history: true` for earlier versions |
| `create_homer_plan` | 3 | With `propose`: a readable diff against the active plan; refuses early if settings are invalid |
| `get_homer_readers`, `get_homer_devices` | 1 | Devices with reader, hours and dates |
| `update_homer_device` | 2 | Set or propose an owner; the database carries the reader onto that device's reads |
| `get_homer_books`, `search_homer_books` | 1 | By ASIN, series, title text |
| `get_homer_series` | 1 | With effective verdict, from `homer_series_verdicts` |
| `get_homer_reads` | 1 | By reader, book, series, date range, source |
| `create_homer_read` | 1 | "Finished X" in chat, or a weekly clip row; `source` chat/clip |
| `update_homer_read` | 2 | Fix dates, hours, reader |
| `update_homer_verdict` | 2 | loved/liked/tired/didnt_click and the note; refuses `never` |
| `create_homer_never` | 3 | The only path to `never`; `set_by = 'alex'` |
| `get_homer_taste_profiles`, `update_homer_taste_profile` | 1 / 2 | Scores checked against the plan |
| `get_homer_genres`, `update_homer_genre` | 1 / 2 | Create or edit a genre and its series (upsert) |
| `get_homer_queue` | 1 | By genre and status |
| `create_homer_queue_items` | 1 | Append; refused without `verified_on` |
| `update_homer_queue_item` | 2 | Status, genre, position (move), `archived_at` (drop) |
| `get_homer_quiet_series` | 1 | From `homer_quiet_series` |

### E. Skill (`.claude/skills/homer/SKILL.md`)
- Read `get_homer_plan` every time. The skill holds no thresholds, scales or rules.
- Practice conversations ask the plan's scales **in the same order and with the same wording every time**, one
  series at a time, so ratings stay consistent. Free text first, then the scales.
- Suggestions: web-search each one to confirm it exists and whether it's on Kindle Unlimited, then write it to a queue.
  Never write an unverified title. Honour verdicts: never suggest a `never`, and offer `tired` only as "pick it up again?"
  after the gap.
- The weekly clip: Alex clips his Kindle library page sorted by most recent. Claude matches titles to books, creates
  reads with `source = 'clip'`, and asks about anything it can't match. "Finished X" in chat becomes a read with
  `source = 'chat'`.
- Device owners: propose by series continuity, newest device first, in a short list; Alex confirms.
- Every correction Alex makes to the rules becomes a proposed plan version, never a silent change.

### F. Homer tab (`src/homer/`)
- `HomerPage.jsx`, `homerApi.js`, `homerModel.js` and their tests; `src/Alfred.jsx` and `src/viewPaths.js` (+ test)
  add the `homer` view at `/homer`.
- Read-next queues grouped by genre, in `position` order. Each item shows title, author, why, a KU badge and both
  Kindle links, with a quick status change and drop.
- "Series gone quiet" list from `homer_quiet_series('alex')`.
- `supabase/migrations/_pending_homer-h4k_homer_screen.sql` sets `path = '/homer'` and `button_name = 'Homer'` on the
  existing `apps` row `homer` (created by migration 181), so Overwatch counts it and the app button appears.

### G. Keeping reads current (data rows only, no code)
- Two **recurring Alfred intentions**, which Alex adds in the UI (no MCP tool creates intentions):
  - weekly: "Clip my Kindle library page, sorted by most recent"
  - every 6 months: "Re-request the Amazon data export"
- The **homer `app_profiles` row**, written through `update_app_profile` (tier 2): `rhythm_days = 7`, and an
  `activity_recipe` saying "count homer_reads with source = 'clip' created in the window, from get_homer_reads".
  Overwatch's quiet section then flags a week with no clip. A watch item doesn't fit, because `overwatch_watch` rows
  are dated adjustments with a required `ends_on`.
- Saying "finished X" in chat also adds a read.
- No scheduled task and no `platform_schedules` row: nothing runs on its own.

### H. Calibration (chat only, no CLI work), after C and D
1. Claude groups the series Alex has read into proposed genres; he corrects them.
2. Plan v1 is drafted from the seed examples below and approved through `create_homer_plan`.
3. Taste profiles for the seed series, through the scales.
4. A few rounds of suggestions, each verified, written to the queues, and reacted to.
5. Every correction becomes a proposed plan version.

#### Seed examples, in Alex's words
- **Mob Sorcery**: magic and magical progression, harem, urban. The hero starts poor and an underdog and grows in
  power. Great combat scenes. Good love interests with different personalities. Great premise where the criminal
  underworld uses magic; loves the werewolf mafia. Lots of funny scenes. By the last book read the harem is big but
  not quite absurd. Worth finishing or rereading when in the mood. No one important dies; the hero never gets
  seriously hurt; stays light. No crafting, only training and learning new spells. A little darker than Glaxius, but
  still fun and sometimes very funny.
- **Glaxius**: the hero is completely overpowered but still levels. Russian, Russian nobility. The hero is hilarious,
  loves tweaking authority and loves being underestimated by nobles (a favorite trope). Challenged to lots of duels.
  Extremely similar to the Marcus Dark series. Very mild harem, no sex. Some crafting and building his home fortress.
  Very light, very funny, fun.
- **Dungeon Crawler Carl**: read one book, couldn't finish the second. A comedy that is constantly trying to be funny
  and degenerates into silly, which is not his favorite. Verdict: didn't click.
- **Tired** examples: The Ten Realms, The Primal Hunter.
