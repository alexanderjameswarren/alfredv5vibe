# Restructure Phase 3 — Inbox and capture: technical spec

Worktree / owner: `restructure_p3-x4n`
Progress: `docs/history/progress-restructure_p3.md`
Status: complete (2026-10-12). "As built" at the end records where the build differed from this plan.

## Rules carried from Phases 0-2
- One live event per intention and at most one open execution (unique indexes).
- Closed and archived are separate; nothing auto-archives.
- Colours: teal = execution running, brown = primary action, amber = paused, red outline = destructive.
- A bordered card is something you tap; content you read sits in a grouped list; cards have no caret.
- Record links use the shared `RecordLinks` header pattern.
- Cards and buttons use 8px corners (`rounded-lg`).
- UI words match record names: "execution", never "run".
- Table and tool work follows the mcp-platform skill: `platform.register_table` (p_-prefixed, schema-qualified), `defineTool` with a declared tier, `ctx.db` only, and `check_platform_conformance` must be CONFORMANT.

## What already existed (found in planning)
- Processing already archived with `archive_reason = 'processed'`: `handleInboxSave`, `src/inbox/useInboxActions.js`. No live code deleted inbox rows. Phase 3 corrected the stale wording that said it deleted:
  - the DB comment on `inbox.archive_reason` (066)
  - `archive_inbox_item`'s header and error text (`_shared/tools/clipboard.ts`)
  - two comments in `useInboxActions.js`
- `source_inbox_id` (text, FK to inbox, on delete set null) was on items, intents and events (068), and `handleInboxSave` already set it.
- Reminders already allowed an `intent_id`.
  - The `create_reminder` RPC created them.
  - `PendingReminder` listed them read-only on intention, item and inbox detail.
  - `reminders_one_link` allows only one of `inbox_id` and `intent_id`.

## Scope
1. **Apps table.**
   - `public.apps`: `id` text slug primary key, `name`, `description`, `icon` (lucide name), `path` (null when there is no screen), `button_name` (null when there is no screen), timestamps.
   - Seeded, registered with `register_table`, read-only to the app.
   - `contexts.app_id` text FK to `apps(id)`, on delete set null.
   - Nav buttons are not changed to read from it in this phase.
2. **`inbox.source_app`**, a text FK to `apps(id)`, on delete set null.
   - It is never guessed at capture. Typed captures, emails and clips arrive with it empty.
   - Set at creation only when the sender knows its app:
     - Claude, through `create_inbox_item`
     - scheduled tasks
     - wb-sync, through a BEFORE INSERT trigger that copies `source_metadata->>'app'` when it names a seeded app and `source_app` is null
   - Existing rows are backfilled the same way.
   - Otherwise enrichment fills it in through `update_inbox_item`.
   - The inbox detail page has an **App picker** beside the Context picker. It shows the current value, is editable, and is blank when nothing has set it.
   - Processing keeps whatever the picker holds. It is never derived from the context's `app_id`.
   - `source_type` (how a capture arrived) stays.
   - Inbox list:
     - open captures stay grouped by `source_type`
     - processed captures show under their app, with its icon and an outcome line
3. **`inbox.outcome`**: a jsonb array, not null, default `[]`, with a check that it is a list of `{table, id}`.
   - Each entry is `{ "table": "intents" | "items" | "events" | "job_applications" | …, "id": "<id>" }`.
   - Written by the app's Process and by `archive_inbox_item` (`outcome` parameter).
   - Reverse link: `source_inbox_id` on intents, items and events (existing), plus a new `job_applications.source_inbox_id` (text, FK to inbox, on delete set null, partial index), set by `create_job_application`'s new `inbox_id` parameter.
4. **Process archives.** Already true. Process now also writes `outcome` and `source_app`, in the same archive write.
5. **Reminders on intentions.**
   - Intention detail: set a reminder at an exact date and time through `create_reminder` with `p_intent_id`; list the pending ones; cancel one (state `cancelled`, cancel_reason `manual`).
   - Inbox detail gets the same cancel on the reminders it already lists.
   - No separate reminders screen.
6. **Copy button** on item and intention detail. It copies the title, then the description, then `https://alfredv5vibe.vercel.app/<id>` on its own last line.

## Decisions (2026-10-11)
1. Reuse `source_inbox_id`. No new `inbox_id` columns. Add `source_inbox_id` to `job_applications` only.
2. The app is never guessed at capture (see scope 2).
3. There is one column, `inbox.source_app`. Enrichment fills it in, the detail page has an editable App picker, and processing keeps the picker's value.
4. `apps.description` is one plain line per app. Enrichment uses it to choose an app, the way context descriptions choose a context.
5. Seed Arnold (`arnold`, path and button empty). The migration sets the "Body, Mind and Spirit" context's `app_id` to `arnold` only if exactly one context has that name.
6. Enrichment: `update_inbox_item` accepts `source_app`; `.claude/skills/alfred-enrich/SKILL.md` tells enrichment to choose an app from the app descriptions.
7. All tool work and the mcp deploy come last (step 8), after `warren_buffet_p2-m4t` finishes. Deploying `mcp` earlier would overwrite its live, unmerged tool changes.
8. Enrichment reads apps through a new tier-1 `get_apps` tool; `get_contexts` also returns `app_id`.

## Apps seed (descriptions approved 2026-10-11)
| id | name | icon | path | button_name | description |
|---|---|---|---|---|---|
| alfred | Alfred | House | / | Home | Everyday life and household admin: tasks, errands, people, places, recipes, plus Alfred's own bugs and features, and anything no other app covers. |
| warren_buffet | Warren Buffet | Wallet | /money | Money | Money: bank and investment accounts, transactions, spending, bills, budgets, net worth and tax. |
| timer | Timer | Timer | /timer | Timer | Timed sessions run on the Timer screen. |
| sam | Sam | Music | /sam | Sam | Piano practice: songs, scores, lyrics, practice goals and practice plans. |
| games | Games | Gamepad2 | /games | Games | Games played on the Games screen. |
| jobs | Jobs | Briefcase | | | Job search and consulting: postings, job alerts, applications, recruiters, interviews and follow-ups. |
| dj | DJ | Disc3 | | | Music listening: artists, albums, concerts, setlists, playlists and jazz. |
| drive_mix | Drive Mix | Car | | | The car playlist: songs and artists to add or cut, thumbs, and today's mix. |
| ken | Ken | GraduationCap | | | Learning and quizzing: facts to learn, quiz areas, corrections and misconceptions. |
| workshop | Workshop | Wrench | | | The Workshop server on the Surface tablet: its tunnel, uptime and the jobs it runs. |
| arnold | Arnold | Dumbbell | | | Workouts and movement: gym classes, exercise sessions and fitness goals. |

## Not in this phase
- Push notification action buttons (Open and Done).
- The Claude action inbox and proposed_actions.
- Making triage fully atomic beyond switching delete to archive.
- Duplicate detection.
- Restyling inbox cards and lists beyond the app icon and an outcome line.
- Links.
- Snooze or recurring reminders.
- Pin or unpin at triage.
- Bulk-adding to collections.
- Clip pruning.
- Hourly enrichment itself, beyond the `update_inbox_item` parameter and the skill text.
- Nav buttons reading from apps.
- The in-app `ai-enrich` Edge Function choosing an app.

## As built
- Migrations: `116_restructure_p3_apps_and_inbox_outcome.sql`, `119_restructure_p3_reminders_follow_intent.sql`, and `122_restructure_p3_clips_registry_note.sql` (a notes-only update of the registry row, not a re-register).
- No context matched "Body, Mind and Spirit"; Alex linked "Alex (body, mind, spirit)" by hand.
- Reminders grew two follow-ups in step 6:
  - pending reminders follow the intention: the Background/Closed question covers them (`intent_status`), and a trigger cancels them on archive and restores them on un-archive (`intent_archived`)
  - the intention page uses compact lines and a `SchedulePopover` time mode, not a grouped section
- Copy needed a toast with no Undo: `UndoMessage` and `src/Alfred.jsx` changed (`notify`, and `offerUndoFor(msg, null)` fixed).
- Tool count went 116 → 117 (get_apps); mcp v149. archive_inbox_item also stamps `source_inbox_id` on events and lists `linked_back`.
- The job-search skill passes `inbox_id` and archives with an outcome and `source_app: "jobs"`.
