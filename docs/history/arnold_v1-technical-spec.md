# Technical spec: Arnold V1 (project code `arnold_v1`)

This file: `docs/arnold_v1-technical-spec.md`. Progress: `docs/arnold_v1-progress.md`. Worktree and claims owner: `arnold_v1-k7m`.

## 1. What Arnold V1 is

Arnold is Alex's workout and wellbeing coach. V1 does four things:

1. **Holds a plan.** Alex's goals, the nudge instructions and the review instructions live in one database record. Arnold proposes changes in chat and Alex approves them. Approving creates a new plan version and keeps the old one as history (the SAM practice plan pattern). Travel or a rehab week is simply a new plan version; there are no pauses.
2. **Nudges during the day.** A generic hourly Claude scheduled task, "Claude hourly notifications", serves every app that takes part (Arnold is the first). For Arnold it reads the active plan, checks today's activity and today's notifications, decides whether anything is worth sending, and sends an Alfred push through the `send_alfred_push` tool. Shared settings in `claude_notification_settings` (3.6) set the overall window and per-hour cap.
3. **Reviews every morning.** A Claude scheduled task reviews the previous day and the current period against the plan, and raises a conversation only when the plan says one is due: a Claude push notification and an actionable inbox item holding a paste-ready prompt, every time. A goal met on its own posts nothing to the inbox.
4. **Logs every notification** in a shared `claude_notifications` log that any app or task can use.

**Design rule that governs everything below:** every number, time, limit and instruction is a value in the plan record. The tasks read the plan and apply it; code and skills hold no goal values, limits or messages. Changing a value never needs code.

## 2. What Arnold reads (no new activity table)

| Activity | Alfred records | How it is counted |
|---|---|---|
| Microworkouts | Executions on "Micro Workout Rotation — 10 Slots (v3)" (intent `mur79qma8apmj8yc4i`, item `mufl7lrhyko9sc62mm`) | Elements in the execution's `elements` jsonb with `display_type = 'step'` and `is_completed = true`, each dated by its own `completed_at` in Pacific time. Never the execution's `closed_at` or `event_date`, and never `progress` (always `[]`) |
| Yoga classes | A recurring "Yoga class" intention (created in the data step). Gym confirmation emails arrive in the inbox as `source_app = 'arnold'`; Alex processes each one and logs a done execution himself | Closed executions with outcome `done` on that intention, dated by `closed_at` in Pacific time |
| Sleep check-in | A daily "Morning sleep check-in" intention (created in the data step). Alex logs a done execution with a note in a fixed format: bedtime, wake time, sleep quality 1–5, how I feel 1–5 | Done execution that day. The morning review reads the note |
| Future workouts Arnold designs | Items with one element per exercise, scheduled by intentions. Arnold proposes them; Alex approves before anything is created | `elements` or `executions`, per goal |

Days are Pacific (America/Los_Angeles) dates. Weeks run Monday to Sunday.

Why not `closed_at` for elements: a closed execution's `closed_at` is set by hand and can be earlier than its own ticks. Real case: `mvshk8e8v1782hfxcb` has `closed_at` 19:00Z, before its `started_at` and before two of its ticks at 20:16Z and 21:32Z.

**Gym emails.** No Gmail filter is needed: hourly enrichment already routes Life Time emails (noreply@t.lifetime.life) to `source_app = 'arnold'` (confirmed at s8). The alfred-enrich skill's gym rule sets the "Alex (body, mind, spirit)" context, the right tags, the card title "Log Yoga class for Arnold" and names the Yoga class intention. A class counts only once Alex logs a done execution on the Yoga class intention; the email itself is a reminder to log it.

Fitbit (V2) will get its own daily-totals table. It is out of scope here.

## 3. New tables

Every table follows the platform contract: `platform.register_table()` with owner row-level security, explicit grants to `authenticated` and `service_role`, nothing for `anon`, a comment on every column, and `check_platform_conformance` after the migration. `goal_key` and `dedupe_key` are registered as cleared columns (their names look like credentials but are not).

### 3.1 `arnold_plans` — the versioned plan

Modelled on `sam_practice_plans`. Plans are never edited: a guard trigger allows only `status` active→superseded and `ended_at`. A partial unique index allows at most one active plan per user. Create plans only through `arnold_create_plan()`.

| Column | Purpose |
|---|---|
| `id`, `user_id`, `status` (`active` / `superseded`), `starts_on`, `ended_at`, `supersedes_plan_id`, `created_at`, `updated_at` | Same meaning as in `sam_practice_plans` |
| `focus` | Visible summary, e.g. "Three yoga classes a week and daily microworkouts" |
| `change_summary` | What changed from the previous plan and why. Required whenever the plan supersedes another |
| `internal_notes` | Claude only. Reasoning behind the plan |
| `review_instructions` | Claude only. Plain-language rules the morning review follows: what to check, when to raise a conversation, which prompt template to use. Must not be empty |
| `nudge_instructions` | Claude only. Plain-language rules the hourly task follows, e.g. "nudge if 3 hours pass with no microworkout tick", "encourage at halfway and when the daily target is met", "nudge once if an Arnold inbox item has waited longer than the inbox delay". Must not be empty |
| `voice_notes` | Optional. Notes on Arnold's tone for this plan |
| `review_cadence_days` | How often the morning review checks whether goals were met over the whole period. Default 7, range 1–90 |
| `notification_settings` | jsonb, see 3.3 |
| `prompt_templates` | jsonb, see 3.4 |

### 3.2 `arnold_goals` — the goals of one plan

One row per goal, created with the plan and never edited (a reject-update trigger).

| Column | Purpose |
|---|---|
| `id`, `plan_id`, `user_id`, `position`, `created_at` | |
| `goal_key` | Short stable name, e.g. `yoga`, `microworkout`, `sleep_checkin`. Unique within a plan; kept across versions |
| `label` | Visible name, e.g. "Yoga classes" |
| `intent_id` | The Alfred intention whose executions count. No foreign key, so a later deletion cannot break plan history; `arnold_create_plan` checks it exists, is Alex's and is not archived |
| `measure` | `executions` (done executions) or `elements` (completed step elements), counted as in section 2 |
| `target` | Whole number, e.g. 3 or 5 |
| `period` | `day` or `week` |
| `usual_days` | Optional weekdays, e.g. `{tue,thu,sun}` for yoga. Used to word nudges and reviews; never a hard requirement |
| `pace_checkpoints` | Optional `[{time, count}]`, e.g. `[{"time":"10:00","count":1},{"time":"14:00","count":3},{"time":"19:00","count":5}]`. Times increasing, counts never decreasing and never above the target. Behind pace = below `count` after `time` |
| `notes` | Optional. Claude-only notes on this goal for the nudge and review tasks |

### 3.3 `notification_settings`

Values the tasks apply. Exactly these keys; unknown keys are refused so a typo is caught.

```json
{
  "window_start": "05:00",
  "window_end": "20:00",
  "max_nudges_per_day": 3,
  "max_encouragements_per_day": 2,
  "inbox_waiting_delay_minutes": 120
}
```

Window times are HH:MM Pacific, start before end. Limits are 0–24 a day; the inbox delay is 0–1440 minutes. The hourly task sends nothing for Arnold outside this window or outside the shared window in 3.6, counts today's `claude_notifications` rows by kind against these daily limits, and uses a dedupe key so the same nudge is never sent twice. These are Arnold's own limits; the shared per-hour and per-day caps in 3.6 apply on top.

### 3.4 `prompt_templates`

Paste-ready prompts the morning review fills in and puts in inbox items, keyed by snake_case name. Suggested keys in V1: `missed` (a goal fell short for a stretch the plan names), `review_plan` (a goal was met for a stretch the plan names, so the plan may be ready to change), `check_in` (the cadence is due). There is no `goal_met` template: a goal met on its own is not actionable and posts nothing to the inbox (s8b). The validator requires no particular key. Every prompt starts with "Arnold:" so it opens an Arnold conversation (enforced).

### 3.5 `claude_notifications` — shared by all apps

Any job or Claude task that notifies Alex logs it here, so Overwatch has one place to look if notifications become too many. Arnold V1 is the first user. It sits beside Alfred's existing tables and does not replace them: `notification_steps` (timed push steps for an active execution), `reminders` (one-off push reminders sent by notify-dispatch) and `push_subscriptions` (one row per browser install).

| Column | Purpose |
|---|---|
| `id`, `user_id`, `created_at`, `updated_at` | |
| `app` | Foreign key to `apps(id)`, e.g. `arnold` |
| `job` | What sent it, e.g. `claude_hourly_notifications`, `arnold_morning_review` |
| `kind` | `nudge`, `encouragement`, `flag`, `info` |
| `channel` | `alfred_push`, `claude_push`, `inbox_item` |
| `title`, `body`, `link` | What Alex saw, and where it leads (an Alfred path such as `/inbox/<id>`) |
| `local_date` | Pacific date. Daily limits count by this |
| `dedupe_key` | Unique per user (unique index on `(user_id, dedupe_key)`), e.g. `arnold:2026-10-29:microworkout:behind_pace:10:00`. A repeat insert is refused, which is how "at most once" is enforced |
| `delivery_status` | `pending`, `sent`, `failed`, `no_subscription`. Updated after the send. `sent` means accepted by the push service or Claude, not proof of arrival (Android can hold a push) |
| `delivery_detail` | jsonb object: per-endpoint push status codes, or the inbox item id |

A guard trigger allows only `delivery_status` and `delivery_detail` to change after insert.

### 3.6 `claude_notification_settings` — shared by all apps (added at s5b)

One row per user (unique `user_id`), read by the hourly task before anything else. Owner row-level security, `platform.register_table()`, explicit grants to `authenticated` and `service_role`, nothing for `anon`, a comment on every column, conformance checked. Built in progress step 8: migration written at s8b (`_pending_arnold_v1-k7m_claude_notification_settings.sql`), with a guard trigger that also keeps `user_id` fixed and stamps `updated_at`.

| Column | Purpose |
|---|---|
| `id`, `user_id`, `created_at`, `updated_at` | |
| `window_start`, `window_end` | HH:MM Pacific, start before end. Nothing is sent by the hourly task outside this window, for any app |
| `max_per_hour` | Overall cap across all apps, default 3, range 0–24 |
| `max_per_day` | Optional overall daily cap across all apps; null means no overall daily cap (each app's own limits still apply) |
| `apps` | jsonb array, one object per participating app: `{"app": "arnold", "enabled": true, "plan_tool": "get_arnold_plan", "progress_tool": "get_arnold_progress"}`. Exactly these keys; `app` must exist in `apps` (checked by trigger, since jsonb cannot carry a foreign key); app ids unique; tool names snake_case |

Values are checked by one validator, `claude_notification_settings_problem(...)`, returning null or a message, used by the check constraint so a bad value is refused with a plain reason.

Rules the hourly task applies:

- Each notification is sent on its own, never combined with another app's.
- Each app's own limits stay in that app's plan (Arnold: 3 nudges and 2 encouragements a day). The shared settings add only the overall window, the per-hour cap and the optional per-day cap.
- The caps count `claude_notifications` rows across all apps on the push channels with `delivery_status` pending or sent.

## 4. Database functions

- `arnold_create_plan(p_plan jsonb, p_goals jsonb) returns uuid` (migration 1): security invoker. It locks the active plan, supersedes it, and inserts the new plan and its goals in one transaction. It refuses unknown fields on the plan or a goal, missing instructions, a missing `change_summary` when replacing a plan, invalid settings, templates or checkpoints, duplicate goal keys, and missing or archived intentions. Every refusal has a plain message. At most 20 goals.
- `log_claude_notification(p_app, p_job, p_kind, p_channel, p_title, p_dedupe_key, p_body, p_link, p_local_date, p_delivery_status, p_delivery_detail) returns jsonb` (migration 1): security invoker. Inserts once per dedupe key and returns `{created: true, id}`. If the key already exists it writes nothing and returns `{created: false, id, duplicate_of}`.
- Validators shared by the check constraints and `arnold_create_plan`, so the two can never disagree: `arnold_notification_settings_problem(jsonb)`, `arnold_prompt_templates_problem(jsonb)` and `arnold_pace_checkpoints_problem(jsonb, integer)`, plus the helper `arnold_hhmm_valid(text)`. Each returns null when the value is valid, else a message.
- `arnold_get_progress(p_date_from date, p_date_to date, p_plan_id uuid default null)` (migration 2): one row per goal per day, and per week for weekly goals. Each row gives the count, the target, on track or behind, and pace checkpoint status. It counts exactly as section 2 says. Both tasks and Claude use it, so the numbers always agree.

Every caller is Claude through the MCP connector with Alex's token, so `auth.uid()` scopes everything and there are no user-id parameters.

## 5. MCP tools (Alfred server)

All follow the mcp-platform skill: `defineTool`, a `tables` declaration, `ctx.db` only, bare-data payloads and bounded reads.

| Tool | Tier | What it does |
|---|---|---|
| `get_arnold_plan` | 1 | Active plan with its goals; optionally a plan by id, or the history chain |
| `create_arnold_plan` | 3 | Calls `arnold_create_plan`. A `propose` shows the before and after (current plan vs new) and refuses early on validation errors. The arnold skill only confirms it after Alex approves in chat |
| `get_arnold_progress` | 1 | Wraps `arnold_get_progress` |
| `log_claude_notification` | 1 | Calls `log_claude_notification`. Used for `claude_push` and `inbox_item` rows |
| `get_claude_notifications` | 1 | Shared reader (filters: app, job, kind, channel, date range) through `readTable` |
| `send_alfred_push` | 1 | Shared. `(app, kind, title, body, link, dedupe_key, job)`. See below |
| `get_claude_notification_settings` | 1 | Shared (step 8). The caller's settings row, plus how many push notifications were sent this hour and today, so the hourly task can apply the caps without counting |
| `update_claude_notification_settings` | 2 | Shared (step 8). Creates or updates the caller's row; refuses invalid values with the validator's message |

**`send_alfred_push`**, step by step:

1. Logs the `claude_notifications` row first, as `pending` on channel `alfred_push`. If the dedupe key has been used, the tool refuses and nothing is sent. Logging before sending means a crash can never double-send.
2. Reads the caller's `push_subscriptions` through `ctx.db`, scoped by RLS. The endpoint and key columns are used only inside the tool and never returned.
3. Sends one Web Push to every device. The push carries the title, the body and the deep link; its tag is per dedupe key.
4. Updates the row to `sent`, `failed` or `no_subscription`, with per-endpoint status codes in `delivery_detail`.
5. Dead endpoints (404/410) are reported in `delivery_detail` but not deleted; notify-dispatch already removes those.

The sending code is a new `supabase/functions/_shared/web-push-send.ts`, copied from notify-dispatch's VAPID check and send loop. It uses `PUSH_SEND_OPTIONS` from `_shared/push-options.ts` and imports `npm:web-push@3.6.7` directly, so `mcp/deno.json` is unchanged. notify-dispatch stays untouched. The VAPID secrets are project-wide Supabase secrets, already set.

## 6. Scheduled tasks and the skill

Both tasks are Claude scheduled tasks. Each opens a `platform_runs` row as `running` and closes it `ok` or `failed`, and each is registered in `platform_schedules` with executor `claude`. The cadence vocabulary is only daily or weekly, so the hourly task is registered as daily, with a note, the same way `inbox_enrich_hourly` is. Their prompts live in `docs/claude-hourly-notifications-task-prompt.md` and `docs/arnold-morning-review-task-prompt.md`.

### 6.1 Claude hourly notifications (`claude_hourly_notifications`)

A generic task, not an Arnold one; its prompt names no app. Runs hourly. Each run:

1. Reads the shared settings with `get_claude_notification_settings`. Stops if the hour is outside the shared window, or the per-hour or per-day cap is already reached.
2. For each enabled app in `apps`, reads that app's plan and progress with the tools the settings name (for Arnold, `get_arnold_plan` and `get_arnold_progress`), and its notifications so far today with `get_claude_notifications`.
3. Applies that app's own instructions and limits (for Arnold, `nudge_instructions`, `notification_settings` and the inbox delay) and decides whether anything is worth sending.
4. Sends each notification separately through `send_alfred_push`, with a dedupe key built from the app, date, goal and reason, stopping once the per-hour cap is reached.

For Arnold, step 2 also reads the Arnold inbox items (open and processed today) and the yoga and sleep check-in intentions' executions. When nothing is worth sending, it sends nothing. "Done the class but not logged it" is judged from the processed inbox item and the intention's executions; no goal matching is coded.

### 6.2 Morning review (`arnold_morning_review`)

Runs at about 5:05 am Pacific, after Overwatch's 4:20 run. It reviews yesterday and the current period using `get_arnold_plan`, `get_arnold_progress` and the sleep check-in notes, and follows `review_instructions`.

**Inbox items must be actionable.** It raises a conversation only when `review_instructions` say a plan conversation is due: for example a goal met or missed for a stretch the plan names, or a scheduled check-in. A goal met on its own posts nothing to the inbox; the hourly task may still send an encouragement push. When a conversation is due, it does both of these every time:

- creates an inbox item (`source_app = 'arnold'`, `source_type = 'task'`) holding the filled-in prompt template, titled as a call to action, e.g. "Review your Arnold plan: yoga goal hit two weeks running". A task item's list title is `source_metadata.task_name` plus the run date (`taskTitleFor` in `src/utils/inboxSuggestions.js`), so the call to action goes in `task_name`;
- sends a Claude push notification.

It logs both with `log_claude_notification`, on channels `inbox_item` and `claude_push`. When nothing is worth raising, it stays silent.

### 6.3 `arnold` skill

Lives at `.claude/skills/arnold/SKILL.md` and is copied into claude.ai. It covers:

- Arnold's voice: warm, encouraging, never scolding.
- Reading the plan and progress.
- Proposing plan changes as a clear before and after, and waiting for Alex's OK before confirming `create_arnold_plan`. A travel or rehab week is a new plan version.
- Proposing new workouts as items and intentions, only after approval.
- Handling a pasted review prompt.

The skill holds no goal values, limits or messages; those are all in the plan.

The alfred-enrich skill gets one addition: route gym class emails to `source_app = 'arnold'`, with the body context, tags, the card title "Log Yoga class for Arnold" and the Yoga class intention named in `ai_reasoning`.

## 7. Alfred data setup (done in chat, not code)

- Create the recurring "Yoga class" intention (Tuesday, Thursday, Sunday) in the "Alex (body, mind, spirit)" context. Done: `mvwgd2o3ftyyyus5zks`.
- Create the daily "Morning sleep check-in" intention, with the note format in its description. Done: `mvwgdsgi851e98oy3go`.
- No Gmail filter: enrichment already routes Life Time emails to arnold.
- The `arnold` app description is set by the step 8 migration.
- After the tools are live, Arnold creates plan V1 in chat with Alex's approval:
  - Goals: yoga 3 a week (usual days Tue/Thu/Sun); microworkout 5 elements a day with checkpoints 1 by 10:00, 3 by 14:00 and 5 by 19:00; sleep check-in 1 a day, with checkpoint 1 by 09:00.
  - Settings: window 05:00–20:00; 3 nudges and 2 encouragements a day; inbox delay 120 minutes; review cadence 7 days.
  - Text: nudge and review instructions, and the three prompt templates.
- After step 8 deploys, write Alex's `claude_notification_settings` row in chat: window 05:00–20:00, `max_per_hour` 3, no `max_per_day`, Arnold enabled with `get_arnold_plan` and `get_arnold_progress`.

## 8. Out of scope for V1

- An Arnold screen in Alfred (add one once there is weekly progress worth showing).
- Fitbit (V2), food (V3) and medical records (V4).
- Pauses.
- Logging an execution while processing an inbox item (comes with the restructure project).
- Moving other apps' notifications onto the shared log (logged as an idea in Alfred).
- Pacing and spacing notifications through the hour, and sequencing them with Overwatch. These belong to a future Notifications project.
