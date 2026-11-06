# Notification routing — technical spec

Project code `notification_routing-d7v`. Overview item: https://alfredv5vibe.vercel.app/mw15al9fhphsn40gqcv.
Progress: `docs/progress-notification_routing-d7v.md`.

## 1. Goal

Every phone or watch pop comes from Alfred and is logged. No scheduled task sends a Claude app
push. Apps and tasks say what happened; one dispatcher decides what reaches Alex, under rules in
one place (Overwatch's plan). When Alex's workflow changes he changes that plan, not every task.

## 2. Decisions (step 1, approved 2026-11-03)

1. **Two stages in one hourly task.** The "Claude hourly notifications" task becomes the
   dispatcher. Stage A watches the enabled apps (Arnold for now) against their own plans and writes
   signals. Stage B dispatches.
2. **One home for pacing.** Window, caps and the watched-app list move into the `delivery`
   section of Overwatch's plan. The dispatcher stops reading `claude_notification_settings` at
   cutover. Its rows stay.
3. **Overwatch writes signals, not reminders.** `create_reminder` gains a required `started_by`
   (`alex`, `chat`, `task:<job>`) and refuses `task:*`.
4. **Arnold morning review** raises a signal only when it raised an inbox item. Silent otherwise.
   No daily reminder.
5. **The Dispatcher is a screen** at `/overwatch/dispatcher`, opened from a new Dispatcher row on
   the Overwatch tab, like Plan and Briefing.
6. **Deliver now.** An inbox outcome is done in the database at once. A pop goes through
   `push-send` (user JWT) in a new `signal_id` mode that sends and logs.
7. **started_by** on `claude_notifications` and `reminders`. `notify-dispatch` logs every pop it
   sends.
8. **Signals raised after 19:00 wait until 05:00.** Reminders and step timers are unaffected.
   Narrowed in step 10e: only notifications wait for the window. Inbox, hold, merge and drop are
   decided at any hour.

**Decisions of 2026-11-05 (step 10e):**

9. **Overrides.** `delivery.overrides` is an ordered list of exceptions Claude edits for Alex in plain
   words (section 5.1). The tools to add and end them come in step 10f.
10. **Only Overwatch writes to the inbox directly.** Every other app only raises signals, and the
    dispatcher decides inbox, notification, hold or drop. An app that used to write its own item
    describes it in `details.item`, and delivery writes it (section 4.3). The task prompts switch in
    step 10g.
11. **A failure is just a kind of signal.** `details.kind: "failure"` is merged and muted like any
    other kind. All repeat handling is central, in the dispatcher; none is in the tasks.

## 3. What exists today (the starting point)

| Sender | Writes | Channel | Logged |
|---|---|---|---|
| `notify-dispatch` (pg_cron, every minute, service role) | reminders and notification_steps due | Alfred push | no |
| `send_alfred_push` (MCP, tier 1) | one push | Alfred push | yes, `claude_notifications` |
| Claude hourly notifications task (Arnold only) | Arnold nudges via `send_alfred_push` | Alfred push | yes |
| Overwatch nightly | nudges via `create_reminder` at `push_time`, plus inbox items | reminder push, inbox | no |
| Overwatch weekly, SAM daily review, Money cleanup, DJ daily (failure) and weekly, Ken seed check, Drive Mix (failure) | `create_inbox_item` | inbox | no |
| Arnold morning review | `create_inbox_item` + `log_claude_notification` | inbox | yes |
| `wb-sync` (edge fn, service role) | inbox rows, one per open `error_key`, after checking open items | inbox | no |
| Every scheduled task | completion push | Claude app push | no |

## 4. Signals

### 4.1 Table `public.signals`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `user_id` | uuid not null | default `auth.uid()`; server senders pass it explicitly |
| `app` | text not null | an `apps.id` |
| `job` | text not null | 1-100 chars |
| `severity` | text not null | `low`, `normal`, `high`, `urgent` |
| `subject_key` | text not null | ties repeats together, e.g. `wb-sync:failure`; lower case, no spaces, 1-200 |
| `title` | text not null | 1-200 |
| `body` | text | |
| `link` | text | Alfred path `/<id>` or null |
| `started_by` | text not null | `alex`, `chat`, `task:<job>` |
| `source_ref` | text | optional idempotency key; unique per user when set, so a retried run cannot raise twice |
| `state` | text not null | `queued` → `held`, `delivered`, `merged`, `dropped`; `resolved` (see 4.3) |
| `outcome` | text | `inbox` or `pop` when delivered |
| `reason` | text | the rule that decided, in plain words |
| `decided_at` | timestamptz | |
| `decided_run_id` | uuid | the dispatcher's `platform_runs` row |
| `decided_by` | text | step 11: who decided it by hand, `alex` (the screen) or `chat` (update_signal); null is the dispatcher. Checked by `started_by_valid` |
| `inbox_id` | text | fk `inbox(id)` on delete set null: the item it became or merged into |
| `notification_id` | uuid | the `claude_notifications` row for a pop |
| `merged_into` | uuid | fk `signals(id)` |
| `bundle_id` | uuid | shared by the signals in one digest |
| `details` | jsonb object | anything the sender wants kept |
| `created_at`, `updated_at` | timestamptz | |

Indexes: `(user_id, state, created_at)`, `(user_id, subject_key, created_at desc)`, unique
`(user_id, source_ref) where source_ref is not null`. A guard trigger lets only the state columns
(`state`, `outcome`, `reason`, `decided_at`, `decided_run_id`, `inbox_id`, `notification_id`,
`merged_into`, `bundle_id`, `updated_at`) change after insert; what the sender wrote is fixed.

### 4.2 Database functions

- `raise_signal(p_app, p_job, p_severity, p_subject_key, p_title, p_body, p_link, p_started_by,
  p_source_ref, p_details, p_user_id default null)`: inserts, returns `{created, id, duplicate_of?}`.
  `p_user_id` is honoured only for service_role (wb-sync); otherwise `auth.uid()`. Granted to
  authenticated and service_role.
- `resolve_signal(p_app, p_subject_key, p_started_by, p_user_id default null)`: records that the
  subject is healthy again (a `resolved` row), which resets its escalation count. wb-sync calls it
  on an ok run. Written in step 7, where wb-sync first needs it (moved from step 3).
- `dispatch_signals(p_now timestamptz default now())`: compute only. Returns `{at, local_time,
  local_date, plan_id, in_window, overrides, pops, decisions}` with one decision per queued signal:
  `{signal_id, app, severity, raised_severity, kind, subject_key, decision, reason, repeats,
  merge_target_signal_id, inbox_id, bundle, overrides}`, decision `wait`, `hold`, `inbox`, `pop`,
  `merge`, `drop` or `digest`; or `{stopped}` when the active plan has no delivery section. Writes
  nothing. `severity` is after any override, and `overrides` lists the labels that matched.
- `overwatch_delivery_problem(p jsonb)`: validator for the delivery section; null when valid
  (or absent), else a plain message. Used by a check constraint on `overwatch_plans`, with the
  helpers `overwatch_delivery_whole` and `overwatch_override_problem(o, n)` (one override, with the
  guardrails).
- `overwatch_override_applies(o, p_at, app, job, subject_key, severity, kind, started_by)`: whether
  an override matches a signal and, when `p_at` is given, is in force then. With `p_at` null it
  checks the match only, which is how past notifications are counted against an override's caps.

### 4.3 Tools (`_shared/tools/signals.ts`)

| Tool | Tier | Does |
|---|---|---|
| `raise_signal` | 1 | write one signal (append-only, like `create_inbox_item`) |
| `resolve_signal` | 1 | mark a subject healthy again |
| `get_signals` | 1 | read signals, filters for app, state, subject_key, date range |
| `get_delivery_rules` | 1 | the active Overwatch plan's `delivery` section (in `overwatch-plan.ts`) |
| `get_dispatch_plan` | 1 | `dispatch_signals()`: each queued signal's decision and reason, and pops sent and left this hour and today; optional `at` to preview another time |
| `deliver_signals` | 1 | recompute the plan and apply it: hold, create inbox items, send pops (shared `web-push-send.ts`), merge, one digest; logs every inbox item and pop in `claude_notifications` with `signal_id` and `started_by`; takes only `wording` and `digest` text and an optional `run_id` |
| `update_signal` | 2 | Alex's hold, drop or deliver now on one signal: `signal_id`, `action` (hold, drop, deliver), `as` (inbox or notification, deliver only). One tool with an action field, since all three share the lookup, the state check and the stamp. Step 11 (below) |
| `add_delivery_override` | 3 | add one override (§5.1) as a new plan version, changing only `delivery.overrides`. Takes `override` (label, match, when, effect, confirm_broad) and a one-line `reason`; sets `created_at` now and `created_by: "chat"`; refuses a label already in use unless that override has ended (it is then replaced). In `overwatch-plan.ts` (step 10i) |
| `end_delivery_override` | 3 | end one by `label`, with a `reason`: sets `when.ends_at` to now and keeps the entry, so the screen shows it as ended and old reasons still name a real override. One that has not started yet is removed instead |

Both dry-run unless called with `dry_run: false` (and, being tier 3, `confirmed: true`).
- A dry run checks the new delivery section with `overwatch_delivery_problem`, so the guardrails
  refuse in plain words before anything is saved.
- It then lists the last 7 days' signals (up to 500) whose decision would change, before and after
  in plain words.
- The list is estimated from each signal's recorded decision, not a full re-run of
  `dispatch_signals`: it covers a decision, a severity change, `merge: false`, and the window or
  pace no longer holding back a notification. An override's own caps are not replayed.

**Alex's actions (step 11).** No function is needed: owner RLS lets Alex update his own signals, and
`signals_guard_update` lets the state columns change and keeps delivered, merged, dropped and resolved
final. So `updateSignal()` in `signals.ts` makes plain updates, each conditioned on the state it starts
from, and stamps `decided_at`, `decided_by` and a null `decided_run_id`. The one SQL change is the
`decided_by` column.
- **hold:** queued → held, reason "held by Alex".
- **drop:** queued or held → dropped, reason "dropped by Alex".
- **deliver:** queued or held, delivered at once; `dispatch_signals` is not consulted, so the window and
  the caps do not apply. Merging does: the subject's open item (the newest delivered signal whose item is
  unarchived, as `dispatch_signals` finds it) gets the repeat. For an inbox item the signal becomes
  `merged` into that signal; a notification links to that item. With no open item an inbox delivery
  writes the item (from `details.item` when given) and logs it; a notification writes or points at the
  item, sends, and logs with `started_by` = who did it. The default `as` is a notification for High and
  Urgent, an inbox item otherwise.
- The MCP tool records `decided_by: "chat"`. `push-send` with `{ signal_id, action, as? }` runs the same
  function with the caller's token and records `"alex"`; that is the screen's route (step 11b).

**Item titles (step 11b).** The card shows `source_metadata.task_name` as the title, so an item the
dispatcher writes is never titled with its job name. For a notification (pop or digest, and deliver
now as a notification): "Notification: " plus the notification's worded title, else the signal's
title. For an inbox item: `details.item.source_metadata.task_name` when the task gave one, else the
worded title, else the signal's title. Other keys, `run_date` among them, are kept.
`215_retitle_dispatcher_inbox_items.sql` (run as 213) retitled the 8 earlier items titled "dispatcher".
The `decided_by` column is `214_signals_decided_by.sql` (run as 212).

**A pop always comes with an inbox item.** `deliver_signals` and deliver now point a notification at
the task's own item, or the subject's open item, or a new one made for it (`itemFor`), and the push
links to `/<that id>`. A missed notification is still there as an inbox item, with the
`claude_notifications` row in the Dispatcher's History.

Apps never check for an existing inbox item and never pick a channel. They raise a signal every
time something is worth knowing; the dispatcher merges.

**Items built from signals (step 10e).**
- `raise_signal` accepts `details.item = {captured_text, source_app, source_metadata,
  ai_reasoning}`. `captured_text` is required, and unknown keys are refused.
- `deliver_signals` writes the item from `details.item` when it must make one: for an inbox
  decision, and for a notification. It writes exactly those fields, with `source_type: "task"` and
  `source_app` defaulting to the signal's app. Otherwise it builds the item from the title and body.
  A notification links to its item.
- A merge into an open item (and a notification pointing at one) updates the item's
  `source_metadata`: `repeats`, `first_seen` (the item's `created_at` the first time), `last_seen`
  and `merged_signal_ids`. An old `repeat_count` carries on as `repeats`.
- The item's `captured_text` keeps one last line, "Seen <n> times since <Nov 5, 8:10 AM>" (Pacific),
  replaced on each repeat, never stacked.
- `drop` decisions move the signal to `dropped` with the reason.

## 5. The delivery section of Overwatch's plan

`overwatch_plans.settings.delivery`, validated by `overwatch_delivery_problem`. Plans are
versioned, so every rule change has a reason and a `supersedes_id`.

```json
{
  "window": { "start": "05:00", "end": "19:00" },
  "pace": { "max_pops_per_hour": 3, "max_pops_per_day": 8, "min_gap_minutes": 20 },
  "priority": { "severity_order": ["urgent", "high", "normal", "low"], "app_order": ["alfred", "arnold", "warren_buffet", "overwatch"] },
  "defaults": { "low": "hold", "normal": "inbox", "high": "pop", "urgent": "pop" },
  "bundling": { "digest_severities": ["low", "normal"], "min_signals": 3 },
  "escalation": [
    { "subject_key": "wb-sync:failure", "hold_repeats": 1, "inbox_repeats": 3 },
    { "subject_key": "*", "hold_repeats": 2, "inbox_repeats": null }
  ],
  "merge": { "into_open_inbox": true, "pop_merge_hours": 12 },
  "watchers": [ { "app": "arnold", "enabled": true, "plan_tool": "get_arnold_plan", "progress_tool": "get_arnold_progress" } ]
}
```

- `window`: quiet hours are outside it, end exclusive. Decision 8.
- `pace`: limits on pops only; inbox items are not capped. Pops counted are `alfred_push` rows in
  `claude_notifications` (pending or sent) except jobs `reminder` and `step_timer`: Alex's own
  always fire and never use up the dispatcher's caps. The hour is the clock hour; the day is the
  Pacific date. `min_gap_minutes` is measured from the last pop before this run, so one run can
  send several pops up to the hourly cap.
- `escalation`: `hold_repeats` is how many earlier held or delivered signals of a subject (since
  its last `resolved`) before the next goes from hold to inbox; `inbox_repeats` the same for inbox
  → pop; null never. The first entry whose `subject_key` is `*`, equal to the subject, or a prefix
  of it before a `:` wins (so `wb-sync:failure` covers `wb-sync:failure:<error_key>`).
- `watchers`: replaces `claude_notification_settings.apps` (decision 2).
- Overwatch's `pushes_per_day` and `push_time` are retired when Overwatch moves to signals (step 8).
- Every number is a whole number; `overwatch_delivery_problem` names the first thing wrong, and an
  `overwatch_plans` check constraint makes `create_overwatch_plan` refuse an invalid section.

- `pace.max_per_day_all` (optional): the daily cap on notifications from every app; null means
  none. `max_pops_per_day` still works as an alias and is used when `max_per_day_all` is absent or
  null.

### 5.1 Overrides (`delivery.overrides`, step 10e)

An optional ordered list. Every override that matches a signal and is in force applies, in list
order, and a later one wins for each setting it gives.

```json
{
  "label": "DJ is too chatty",
  "reason": "Alex asked on Nov 5",
  "created_at": "2026-11-05T09:00:00-08:00",
  "created_by": "chat",
  "match": { "app": "dj", "job": "dj-daily", "subject_key": "dj:*", "severity": ["normal"],
             "kind": ["info", "failure"], "started_by": "task:dj-daily" },
  "when": { "starts_at": "…", "ends_at": "2026-11-12T09:00:00-08:00",
            "days_of_week": ["mon", "fri"], "time_from": "09:00", "time_to": "17:00" },
  "effect": { "severity": -1, "decision": "inbox",
              "pace": { "exempt": true, "max_per_hour": 1, "max_per_day": 4, "min_gap_minutes": 30 },
              "window": { "ignore": true }, "bundle": "never", "merge": false, "priority": "after" },
  "confirm_broad": false
}
```

- Only `label` is required, and labels are unique in the list.
- **match:** every field given must match, and a missing field matches everything.
  - `subject_key` is exact, or a prefix ending in `*`.
  - `kind` is `details.kind`, else `flag` for high and urgent signals and `info` otherwise. It is one
    of nudge, flag, info, encouragement or failure.
  - `severity` is matched against the severity the signal was raised with.
- **when:**
  - `starts_at` is inclusive and `ends_at` exclusive. Both are timestamps with a time zone.
  - `days_of_week` uses `mon` … `sun`, Pacific.
  - `time_from` and `time_to` are Pacific, given together. A range with time_from after time_to runs
    past midnight.
- **effect:**
  - `severity` sets a value, or moves one step with `1` or `-1`, and the default for the new
    severity applies.
  - `decision` is `notify`, `inbox`, `hold` or `drop`. It replaces the severity default and is final:
    escalation does not apply to it.
  - `pace.exempt` skips the plan's caps and gap. `max_per_hour`, `max_per_day` and `min_gap_minutes`
    are the override's own limits, counted over the notifications of the signals it matches,
    including past ones. They always apply, exempt or not.
  - `window` is `{ignore: true}` or its own `{start, end}`.
  - `bundle: never` keeps a signal out of the digest, and `always` lets it in whatever its severity.
    A signal with its own pace or priority is never bundled.
  - `merge: false` means the signal is not folded into an open item, a recent notification, or an
    earlier signal in the same run.
  - `priority: before | after` paces the signal ahead of, or after, everything else when the caps
    are reached.
- **Reason:** the decision's reason names each override that changed it, by label, for example
  `normal signals default to inbox; override 'DJ is too chatty': high to inbox` or
  `override 'Ken up': severity normal to high`.

**Guardrails**, enforced by `overwatch_override_problem` through the plan's check constraint:
- An override with decision `hold` or `drop` must have `when.ends_at` and `created_at`, with
  ends_at at most 14 days after created_at.
- An override with decision `hold` or `drop` and no match fields is refused unless `confirm_broad`
  is true.
- Unknown keys, bad values, `time_from` without `time_to`, a window with both `ignore` and times,
  and duplicate labels are refused, each with a plain-words message naming the override, e.g.
  `Override 1 ('Mute DJ') holds signals, so it must end: give when.ends_at, at most 14 days after
  created_at.`

**Seed (step 4 migration).** A new plan version per user with notification settings
(`written_by: "overwatch"`, the only non-Alex author the table allows), copying every existing
setting and adding `delivery` with the window, hourly and daily caps and watchers copied from
`claude_notification_settings` (today 05:00-20:00, 3 an hour, no daily cap, Arnold) and
`min_gap_minutes: 0`, so nothing changes for Arnold at cutover. The 19:00 end in the example above
is a later rule change for Alex to make, not the seed.

## 6. Dispatcher rules (`dispatch_signals`)

Queued signals in priority order (severity order, then app order, then oldest first). The rules
run in this order (from step 10e, 209_dispatch_overrides.sql):

0. **Overrides** (section 5.1): each setting comes from the last matching, in-force override that
   gives it. With no overrides nothing changes.
1. **Default** from `defaults[severity]`, after any severity override, then any decision
   override. (Before it: a signal whose subject already has an earlier signal in this run being
   delivered merges into that one, unless an override says `merge: false`.)
2. **The window, for notifications only.** After escalation and merge, a `pop` outside the
   signal's window (the plan's, its override's own, or none with `ignore`) → `wait`. Inbox, hold,
   merge and drop are decided at any hour, and `deliver_signals` delivers them then.
3. **Escalation.** Count the subject's earlier held, delivered and merged signals since its last
   `resolved`, this run's held ones included. Past `hold_repeats`, hold becomes inbox; past
   `inbox_repeats`, inbox becomes pop. Example: a sync failure is held; the second in a row
   becomes an inbox item.
4. **Merge.** An inbox outcome for a subject with an open (unarchived) inbox item → `merge` into
   it. A pop for such a subject still pops, pointing at that item. A pop for a subject popped
   within `pop_merge_hours` → `merge`. Merging updates the item's repeats and its "Seen n times"
   line (section 4.3). A failure (`details.kind: "failure"`) merges like any other signal.
5. **Bundling.** `min_signals` or more pops of a `digest_severities` severity (or with
   `bundle: always`) in one run, not pointing at an open item, become one `digest`: one inbox item
   listing them and one pop.
6. **Pace.** Each pop, and the digest as a whole, is one unit: `priority: before` first, then the
   rest, then `after`, each in priority order. A unit that would break the plan's hourly or daily
   cap or minimum gap (unless exempt), or its override's own caps: urgent → `wait`; a pop pointing
   at an open item → `merge`; otherwise → `inbox`. A held-back digest becomes one inbox item per
   signal.

Escalation comes before merge so repeats can still turn into a pop while an item is open; that
is the one change from the step 1 order.

The function decides and writes nothing; `deliver_signals` recomputes the plan itself and takes
only wording from Claude (titles and bodies of pops and the digest). Each signal moves only from
`queued`, so a repeated run cannot deliver it twice.

## 7. The dispatcher task (`docs/claude-hourly-notifications-task-prompt.md`)

Hourly 05:00-19:00 Pacific, Alfred connector only. Opens and closes a `platform_runs` row
(`alfred` / `claude_hourly_notifications`, renamed in notes to "dispatcher").

- **Stage A, watch.** For each enabled watcher: read its plan and progress and its sent log, apply
  the plan's nudge instructions, and `raise_signal` each one (no push).
- **Stage B, dispatch.** `get_dispatch_plan`, word pops and digests, `deliver_signals`. Close the
  run with counts by decision.

Only writes: `create_platform_run`, `update_platform_run`, `raise_signal`, `deliver_signals`.

## 8. Senders and how each moves across

| Sender | Step | Change |
|---|---|---|
| `send_alfred_push`, `log_claude_notification` | 3 | take `started_by`; `claude_notifications` gains `started_by`, `signal_id` |
| Claude hourly task | 5 | becomes the dispatcher (section 7) |
| `notify-dispatch` | 6 | logs every reminder and step pop in `claude_notifications` (app `alfred`, job `reminder` or `step_timer`, dedupe `reminder:<id>:<due_at>`, `started_by` from the reminder; steps are `alex`), inserting with explicit `user_id` under service role. Never goes through the dispatcher. |
| `create_reminder` | 6 | required `started_by`; `task:*` refused. `reminders.started_by` backfilled `alex` for `created_by = app`, `chat` for `claude` (approximate) |
| `wb-sync` | 7 | `raise_signal` (`wb-sync:failure:<error_key>`, service role, `started_by: task:wb-sync`) on blocking errors, `resolve_signal` on ok; its own open-item check goes |
| Overwatch nightly and weekly | 8 | signals instead of reminders and nudge inbox items; long reports stay inbox items it writes itself, each with a signal pointing at it |
| Arnold morning review | 8 | signal only when it raised an item (decision 4) |
| Money cleanup, DJ daily and weekly, Ken seed check, SAM daily review, Drive Mix | 9 | a signal for each thing worth knowing; failures are `high` with subject `<app>:<job>:failure`. SAM and Drive Mix prompts are pasted in by Alex and saved to the repo first |
| Every scheduled task's Claude app push | 13 | Alex turns it off in claude.ai |

Report-style items (Money cleanup, DJ weekly, Overwatch weekly) stay inbox items written by the
task, because the dispatcher would only copy them; the task raises a `normal` signal with the
item's link so the dispatcher can pop or bundle it. Later, not in this project: SAM practice
reminder, Monty Don freeze warning.

## 9. Guardrails

- Alex's reminders and item step timers never go through the dispatcher. They always fire, and
  are logged.
- Every pop is logged by its sender (`notify-dispatch`, `send_alfred_push`, `deliver_signals`,
  `push-send` signal mode) with `started_by`.
- The dispatcher's own runs are watched by the Overwatch nightly (section 11).

## 10. The Dispatcher screen

**Exceptions (step 10i).** The rules card lists each override in plain words, with 12-hour Pacific
times, for example "Arnold notifications: any hour, until Nov 12, 3:00 PM" or "DJ: inbox instead of
a notification". Under each: "In force", "Not started yet" or "Ended", and its label. An ended one
reads "… Ended Nov 12, 3:00 PM" in muted text. The daily limit reads `max_per_day_all` before
`max_pops_per_day`.

`/overwatch/dispatcher` (`OVERWATCH_DISPATCHER_PATH` in `src/viewPaths.js`), a route screen like
Plan and Briefing, opened from a Dispatcher row on the Overwatch tab. Files:
`src/overwatch/DispatcherPage.jsx`, `dispatcherModel.js`, reads in `overwatchApi.js`.

- **Sections:** Queued, Held, Delivered, Merged (signals); History (the `claude_notifications`
  log, newest first, with `started_by`); Reminders and Step timers (scheduled ones).
- **Actions (step 11):** signals: hold, drop, deliver now; reminders: edit text or time, cancel
  (`remindersApi.js`); step timers: reschedule, cancel (`notificationStepsApi.js`).
- **The buttons (step 11f).** Each Unprocessed and Held card has a "⋯" button at its right, above the
  card's stretched link, so tapping it never opens the card. It opens `SignalActionDialog`: the
  signal's title, then "Hold" (Unprocessed only), "Drop", "Send now as a notification", "Send now as
  an inbox item", and Cancel. It calls `actOnSignal()` in `overwatchApi.js` (push-send's signal
  route). On success the card moves without a reload (`applyAction` in `dispatcherModel.js`): held
  to Held; dropped and sent to the top of History. On an error the server's message stays in the
  dialog, in plain words ("delivered" reads "sent"), and the card stays put. History now also shows
  dropped signals, and a card decided by hand (`decided_by` alex or chat) adds "· by you" to its
  line, e.g. "Sent Fri, Nov 6, 8:20 AM · by you" or "Dropped …", and leaves out the dispatcher's
  reason. A send folded into an open item reads "Added to the open inbox item … · by you".
- **Step 11g fixes.**
  - A card Alex held reads "Held by you · <time>", one line, with no dispatcher reason; one the
    dispatcher held keeps "Dispatcher: <reason>".
  - "Started by" is the signal's own `started_by` on every card with a signal (sent, merged, dropped,
    held, unprocessed), not who sent it, in plain words: alex "you", chat "Claude", `task:<slug>` the
    slug in words ("Arnold morning review"). A send with no signal gives its sender.
  - A step-timer send (logged as "Alfred") is titled with its step text.
  - History is newest first by when the thing happened: a send's `created_at`, a signal's
    `decided_at` (every merged and dropped signal has one). Each source pages on its own column with
    the same `{ at, id }` cursor, ties by id.
  - An action that no longer applies reads "Already dropped | sent | held. Nothing changed." in the
    dialog; any other error as the server words it.
- **Step 11h fixes.**
  - A reminder send ("Alfred reminder") is titled with the reminder's text, like a step timer.
  - "Not sent <time>" is on the status line, like "Sent <time>", and the meta line has no date.
  - A task name's app part is the app's display name from `appNames`: task:dj-weekly-review reads
    "DJ weekly review", task:money-cleanup "Money cleanup".
  - Every card links `/<id>`: a stored `/inbox/detail/<id>` or `/schedule/execution/<id>` link is
    shortened (`cardLink`), and a Queued step timer links `/<execution id>`.
  - `/<signal id>` opens the generic record page ("Record from signals", its columns), since
    `resolve_record` searches every registered table and `recordRoutes.js` has no signals screen. So
    dropped, held and unprocessed cards with no inbox item keep linking there.
- **Hold, drop, deliver now** (decision 6, built in step 11): all three through `push-send` with
  `{ signal_id, action, as? }`, which runs `updateSignal()` with the caller's token, sends any
  notification to the caller's devices, and records `decided_by: alex` (and `started_by: alex` on the
  log). No separate RPC (section 4.3).
- **UI patterns:** existing Overwatch section and list styles; every confirmation is a modal like
  `src/groups/ArchiveGroupDialog.jsx`. Phone width first, nothing scrolls sideways.

## 11. Nightly checks (step 12)

**Built in step 10k, without SQL.** `get_overwatch_nightly_counts` adds `dispatcher_checks`,
worked out in `overwatch-nightly.ts` from `signals`, `platform_runs` and the active plan (a failed
read puts `{error}` there and never fails the counts):
- `importance`: signals held in the last day that were `kind: "failure"` or High/Urgent, by subject.
- `silence`: hours since the last `delivered` signal against `settings.nightly_checks.silence_hours`
  (outside `delivery`, so no validator change; **36 hours** when absent), the last day's signals by
  state, and overrides in force that hold or drop with no app, job, subject_key or started_by.
- `failures`: failed or partial runs in the last day with no signal for them: same app and job from
  5 minutes before the start to 6 hours after the finish (or `details.run_id` naming the run); a
  failed run needs a failure signal (`kind: "failure"` or a `failure` segment in the subject key), a
  partial one any signal. Partial `overwatch/nightly` runs are left out (their gaps are scan gaps).

The nightly writes these three straight to the inbox (decision 10's one exception), each with a
paste-ready prompt. Every other Overwatch item, and every other task's item, is a signal with
`details.item`. Report-style items (DJ weekly, Money cleanup) put the date in the subject key, so a
new week never folds into last week's open item; failures keep a dateless key.

The block below is still to come in step 12:

`overwatch_nightly_counts` gains a `dispatcher` block: runs yesterday (expected about 15),
failures, signals by decision, held subjects with repeats, pops against the caps, and pops logged
by each sender and `started_by`. The nightly prompt:

- proposes rule changes (a task inbox item with a paste-ready prompt, as for other plan changes),
  for example a subject held every day, or a cap hit three days running;
- **if the dispatcher has no ok run since yesterday 07:00**, raises an inbox item directly (not a
  signal, since the dispatcher is what is broken).

## 12. Platform rules (mcp-platform skill)

- Every new table: `platform.register_table()`, which grants authenticated and service_role and
  strips anon and PUBLIC.
- Every new function: `revoke all ... from public, anon` and explicit `grant execute` to
  authenticated and/or service_role as its callers need. Anon gets nothing.
- Tools reach the database only through `ctx.db`; every `defineTool` declares its tier and its
  `tables`.
- Every migration block ends with `check_platform_conformance`, which must return `CONFORMANT`.
- SQL written as `supabase/migrations/_pending_notification_routing-d7v_<purpose>.sql`, numbered
  after `gitsync` at the step that queues it; tests in `supabase/tests/notification_routing-d7v/`,
  returning their checks as a result row from a block that undoes itself.
