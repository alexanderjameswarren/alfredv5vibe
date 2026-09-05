# Progress: Chained Notifications

## Status: Phase 5c — subscription rotation repair (Phase 6 not started)

Reference: `docs/technical-spec-notification-chains.md`

Work one phase at a time. Stop at the end of each phase, provide explicit
verification steps, and wait for confirmation before continuing.

---

## Phase 0 — Proof of concept

- [x] Stage 1: service worker, local notification, verified on Pixel 7 + Pixel Watch
- [x] Stage 2: VAPID keys, `push_subscriptions` table (CONFORMANT), `push-send`
      edge function, verified delivered with Alfred fully closed

---

## Phase 1 — Execution deep link (prerequisite)

- [x] Add an id-bearing execution route to `viewPaths.js`, following the
      `samSongPath` / `samSongIdFromPath` precedent
      — `executionPath()` / `executionIdFromPath()`; `pathToView`,
      `isKnownPath` and `parentPath` all updated
- [x] Handle cold load: fetch the execution by id rather than relying on
      `activeExecution` being populated in memory
      — effect in `Alfred.jsx` calling `storage.get('execution:<id>')`
- [x] Confirm the `DETAIL_VIEW_STATE` guard no longer redirects a cold load to
      `/schedule` — suppressed by `awaitingExecutionLoad` while auth resolves
      and the fetch is in flight

**Verify:** paste an execution URL into a fresh browser tab with no prior app
state and confirm it opens that execution.

### Correction: the first attempt failed the headline test

The cold-load guard was written as "a fetch is in progress", set by the effect
that starts the fetch. That flag is false for the whole render that schedules
the effect, and Alfred computes the redirect decision during render — so on the
render where auth resolved (user present, fetch not yet started) the guard
redirected to `/schedule`. Reordering the effects would not have helped:
`setState` in one effect does not retroactively change a value the next effect
closed over in the same render.

Fixed by asking the question the other way round — "is this execution loaded
yet", which is knowable during a render — defaulting to waiting and releasing
only once a lookup has completed and found nothing, keyed by id. This also
removed the `authLoading` / `!user` special case: until a lookup has run and
failed the answer is "still waiting", which is correct while a session is being
restored and keeps a deep link alive across a login.

Two structural consequences, both requested:

- **Extracted to `src/useExecutionRoute.js`.** The test now imports the
  shipping hook instead of reproducing its shape. A test that copies the guard
  can go green while the real code drifts — the twin-site failure that once
  stripped `collectable`.
- **Stale `activeExecution` fixed here, not deferred.** Rendering reads
  `executionForRoute` (state only when it matches the URL) so the wrong
  execution is never drawn under a URL naming another, and an effect clears
  state the URL no longer names so completion, close and pause cannot act on
  it.

### Notes on the implementation

- The URL is now the source of truth for which execution is open. Six
  `setView("execution-detail")` call sites became `goToExecution(exec)`, which
  navigates to `/schedule/execution/<id>`. `setView` could not do this — it is
  handed a view name and has no way to know which execution is meant, which is
  the exact reason the original routing slice left ids out.
- The bare `/schedule/execution` still resolves to the same view, so
  `viewToPath("execution-detail")` is unchanged and the view map stays a
  bijection. The id-bearing form is purely additive.
- `parentPath('/schedule/execution/<id>')` returns `/schedule` directly rather
  than stripping one segment, which would land on the id-less form and redirect
  a second time.
- A malformed path (`/schedule/execution/a/b`) yields no id and is treated as
  unknown, so it redirects to home like any other nonsense path.
- The redirect guard is also suppressed while `authLoading` or `!user`, so a
  deep link opened before the session resolves is not thrown away.
- 9 new tests in `viewPaths.test.js`; the pre-existing invariants (20 views,
  bijection, round-trip, `isKnownPath` rejections) all still pass.
- 13 tests in `executionColdLoad.test.jsx` covering the cold load, the
  fetch-once guarantee, the failed-lookup fallback and its no-retry-loop, the
  stale-execution cases, and the id-less path behaving as it always did.
- Full suite 479 passing across 23 suites; `CI=true` build clean.

**Not done, and deliberately not:** nothing constructs a deep link yet. The
dispatcher payload that uses `executionPath()` is Phase 5.

---

## Phase 2 — `offsetMinutes` on elements

- [x] Add `offsetMinutes` to the element shape, meaningful only on `step`
- [x] Delete it when `displayType` changes away from `step`, mirroring
      `collectable` — in **both** `updateElement` copies
- [x] **Twin-site rule:** all **six** normalisers updated, including both
      dirty-check shadow copies
- [x] Add a minutes input to the element editor (both duplicated call sites)
- [x] Mark position one "at start" — as a muted note **alongside** the input,
      which stays editable at every position (see correction below)

**Verify:** author an item with offsets, save, reopen, save again without
changing anything, and confirm every offset survives. Then reorder the steps and
confirm each offset travels with its step.

### The six normaliser sites

Found by tracing `collectable`, since it has exactly the same shape and the same
failure. Two families, each with its own dirty-check shadow:

**Inbox triage card** — maps AI suggestions (`el.text` / `el.type`) into the
editor shape:

| Site | What it is |
|---|---|
| initial `useState` for `itemElements` | seeds the form |
| AI-enrichment effect | re-seeds when enrichment arrives |
| **dirty-check effect** | **shadow copy** |
| reset-to-suggestions handler | discards edits |

**ItemCard** — the item editor, where offsets are actually authored:

| Site | What it is |
|---|---|
| initial `useState` for `elements` | seeds the form |
| **dirty-check effect** | **shadow copy** |

Only the ItemCard family strictly needs offsets today; the triage family was
updated too, because Phase 8 teaches `alfred-enrich` to emit `offsetMinutes` and
a normaliser that drops it would be exactly the latent bug this rule exists to
prevent.

### ⚠ Spec correction: the on-disk key is `offset_minutes`

The spec's data-model example shows `"offsetMinutes": 360` as the stored shape.
That is not what is stored. `elements` is a jsonb column and
`storage.toSnakeCase` **recurses into arrays** — documented as load-bearing in
`src/utils/caseConvert.js`, and the reason `item_collections.items` holds
`item_id` on disk. So React state holds `offsetMinutes` and Postgres holds
`offset_minutes`.

The round trip is symmetric, so behaviour is unaffected and Phase 2 is correct
either way. It matters for **Phase 4 and 5**: anything reading `elements`
straight from Postgres — an edge function, a SQL query, the dispatcher — sees
`offset_minutes`. Client-side expansion reading `execution.elements` from React
state sees `offsetMinutes`. `readOffsetMinutes` accepts both.

### Notes on the implementation

- Helpers live in `src/utils/elementOffsets.js`, not inline in `Alfred.jsx`, so
  the tests exercise the shipping code rather than a copy — the same reasoning
  applied to `useExecutionRoute` in Phase 1.
- **`offsetPatch` is not a truthiness test.** The `collectable` idiom
  (`el.collectable ? {...} : {}`) would silently drop `offsetMinutes: 0`, which
  is a legitimate value. It tests for a finite number instead.
- **The patch is applied last at every site**, and a test asserts it. The dirty
  check compares `JSON.stringify` of both sides, so a different key position
  between a normaliser and its shadow would report an untouched form as dirty.
- "At start" is decided by `isFirstStep`, which skips headers and bullets — a
  step below a header is still step one. The stored value is left untouched
  there rather than cleared, so dragging the step back down restores its gap.

### Correction: "at start" replaced the input, and should not have

The first build read the spec's "label position one as 'at start' rather than
showing a gap" as *replacing* the minutes input at position one. That makes the
value unauthorable there: a step created at the top never gets an offset, and
dragging it down leaves a blank — defeating the reason the offset lives on the
element rather than on the item.

The input now renders and is editable at **every** position; "at start" is a
muted italic note beside it, saying "this value is not used while this step is
first" rather than "this step has no value". Position gates neither authorship
nor storage, so moving a step in and out of first place is lossless.

The spec's element-authoring section has been rewritten to say this outright,
with the misleading sentence quoted and marked as wrong, so it does not get
implemented the same way again.
- 23 tests in `elementOffsets.test.js`, three of which read `Alfred.jsx` as text
  to assert the twin-site invariant: every site carrying `collectable` also
  carries `offsetPatch`, and both `updateElement` copies delete the offset on a
  type change. A behavioural test cannot catch a *seventh* normaliser being
  added later with one and not the other; that is the actual failure mode.
- Full suite 502 passing across 24 suites; `CI=true` build clean.

**Not done, deliberately:** no picker, no repeat-a-block, no auto-numbering —
Phase 7. Nothing expands offsets into rows yet — Phase 4.

---

## Phase 3 — `notification_steps` table

*SQL is a manual prerequisite — run in the Supabase SQL editor before any
TypeScript work.*

- [ ] Create the table per the spec (`execution_id` as `text`, `user_id` as
      `uuid`)
- [ ] `COMMENT ON` the table and every column
- [ ] `platform.register_table(..., p_policy_mode => 'owner', p_audited => true)`
- [ ] `check_platform_conformance` returns CONFORMANT

**Verify:** CONFORMANT, and the table is visible in the Table Editor.

---

## Phase 4 — Expansion and the state machine

**STATUS: complete — awaiting row-inspection verification.**

### Finding: only STEPS are completable — bullets are not

Checked in `ExecutionDetailView` rather than assumed. `header` renders an `<h4>`
and `bullet` renders a static list row; **neither has a checkbox or an
`onToggleElement` handler**. Only `step` — and any unrecognised `displayType`,
which falls through to the same branch — renders a tickable checkbox. Elements
flagged `missing` or `circular` return early and are not tickable whatever their
type.

So "preceding completable element" means **the nearest earlier `step`**. Bullets
must be skipped when looking backwards. Treating a bullet as a clock-starter
would stall the chain forever on a tick no UI can produce.

### Finding: elements have no `id`

`addElement` creates `{ name, displayType, quantity, description }` in both
editors, and all six normalisers build an explicit key set that would *strip* an
id if one appeared. The spec's `"id": "e2"` example was aspirational; it has been
corrected. Anything identifying an element within a run must derive it — which
is what makes the `element_id` question below load-bearing rather than cosmetic.

### Resolved: `element_id` dropped, `seq` is sufficient

The column carried the same information as `seq`, including the same uniqueness
guarantee. The snapshot is frozen at execution start, so the element's index is
its identity for the life of the run. Column and constraint dropped by Alex;
conformance re-confirmed. The spec's DDL now matches, with a note recording why
it came and went.

### Checklist

- [x] Expansion at execution start — one row per element with an offset, `seq`
      1-based over the FULL element list, gaps expected
- [x] Only a row with no preceding tickable element starts `scheduled` at
      `due_at = now()`; every other row starts `waiting` with a null `due_at`
- [x] Completion — closes the completed element's own row and schedules any row
      whose preceding tickable element is the one just ticked
- [x] Close — all non-terminal rows to `cancelled`, on both the archive path and
      the cancel-is-delete path
- [x] Pause writes nothing; resume moves an overdue `scheduled` row to now
- [x] 41 tests over the pure planners; full suite 546 across 25 suites;
      `CI=true` build clean

### Files

| File | What |
|---|---|
| `src/utils/notificationSteps.js` | Pure planning — no Supabase, no React |
| `src/utils/notificationStepsApi.js` | Persistence; every decision comes from the module above |
| `src/utils/notificationSteps.test.js` | 41 tests, including the recipe case |
| `src/Alfred.jsx` | Four wrapped helpers wired to five creation sites, the toggle, both close paths, and resume |

### Decisions worth knowing

- **`ownsNotificationRow` enforces steps-only** rather than assuming Phase 2's
  restriction holds. A bullet with an offset — reachable only by writing jsonb
  directly, e.g. from an MCP tool — would own a row that no checkbox can ever
  tick, stalling the chain forever. Cheap to enforce, unbounded to debug.
- **Two different predicates, deliberately.** `ownsNotificationRow` allows
  `missing` / `circular` steps (that asymmetry IS the known limitation);
  `isTickableElement` excludes them, because the view genuinely renders no
  checkbox and treating one as a clock-starter would add a second, avoidable
  stall.
- **`isTickableElement` tests "not header and not bullet"**, not "is step",
  because `ExecutionDetailView` falls through to the tickable branch for any
  unrecognised `displayType`. Matching the view exactly is the point.
- **The chain advances on tick-ON only.** Element completion is a toggle;
  un-ticking must not close a row or start a clock. Re-ticking is idempotent —
  only `waiting` rows are scheduled and terminal rows are left alone — so a due
  time cannot be pushed further out by fiddling with a checkbox.
- **Cancel-is-delete cancels the chain first.** That path deletes the execution
  row; cancelling afterwards would leave rows referencing something that no
  longer exists.
- **Chain failures are logged, not thrown.** A chain that fails to expand must
  not stop an execution starting. Every helper is wrapped and logs with a
  `[Chain]` prefix — loudly, because this phase is verified by inspecting rows
  and a silent no-op looks identical to an item with no offsets.
- **Rows are written in snake_case throughout.** They go straight to PostgREST
  and never pass through `storage.toSnakeCase`, so `offset_minutes` / `due_at` /
  `completed_at` are the working names in these two modules.

**Not done, deliberately:** nothing sends anything. No dispatcher, no cron, no
push. The rows are inert until Phase 5.



- [ ] On execution start, expand snapshotted elements into `notification_steps`
      rows; step 1 `scheduled` with `due_at = now()`, the rest `waiting`
- [ ] On step completion: stamp `done`, set the next step's `due_at` to
      `now() + offset_minutes`, move it to `scheduled`
- [ ] On execution close: cancel all non-terminal steps
- [ ] On resume from pause: reschedule an overdue `scheduled` step to `now()`

**Verify:** start an execution and inspect the rows. Complete step 1 and confirm
step 2 gets a due time equal to completion plus its offset. Close the execution
and confirm the remainder is cancelled.

---

## Phase 5 — Dispatcher and cron

**STATUS: dispatcher written; deploy, SQL and verification are Alex's to run.**

### Gates passed

- **pg_cron**: three consecutive runs, all `succeeded`, exactly 60s apart.
- **pg_net**: `status_code` 401 from push-send — the request left the database
  and an edge function answered.
- Probe torn down, `platform.check_conformance()` returns CONFORMANT across all
  31 non-exempt public tables. pg_cron and pg_net left enabled.

### Platform facts learned, now recorded in the spec

- The SQL function is **`platform.check_conformance()`**, no arguments —
  `check_platform_conformance` is the MCP tool name, not the function.
- `register_table(p_table regclass, p_policy_mode text, p_audited boolean, p_exempt boolean, p_notes text)`.
- ⚠️ **No `unregister_table` exists.** Removing a table means deleting from
  `platform.registry` by `table_name` by hand, **before** dropping the table.
  Drop first and a registry row is left pointing at nothing.

### Post-Phase-4 change: the stall limitation is closed

`ownsNotificationRow` is now defined as `isTickableElement(el) && has an offset`,
so row ownership and tickability are the same predicate and cannot drift. The
general rule: **a row may only be owned by an element the UI can actually tick.**

A `missing` or `circular` step therefore owns no row. `precedingTickableIndex`
already looked past such elements, so the step after one is still scheduled from
the last completion that really happened — the chain **loses one notification
instead of stalling permanently**. A missed reminder is recoverable; a dead
chain is not. Any future element type that renders without a checkbox inherits
this for free. 6 new tests; spec note flipped from "known limitation" to
"closed", recording how.

### The gate

`docs/sql/phase5-gate-cron-probe.sql` — a scheduled job that inserts a row into
`public.cron_probe` every minute and does nothing else. Separates "cron never
ran" from "the dispatcher logic is wrong".

`docs/sql/phase5-gate-pgnet-probe.sql` — optional, and recommended. The cron
probe proves the **scheduler** runs; it does not prove **pg_net** can make an
outbound HTTP call, and the dispatcher needs both. Finding out pg_net is blocked
after the function is written is the expensive order to discover it.

Two open questions for Alex, neither of which blocks running the gate:

1. **Does `platform.register_table` have an inverse?** The probe table is
   temporary. Dropping a registered table may leave a registry row that
   conformance then flags. The teardown block says to re-run
   `check_platform_conformance` either way and report what it says.
2. **Does the probe table's argument shape match?** It is drafted from the
   `notification_steps` registration in the spec. With both MCP connectors down
   the platform schema cannot be introspected from here, so if
   `register_table` rejects the call, the error text is enough to fix it.

### The shared secret

With `verify_jwt = false` the dispatcher is a public URL that sends push
notifications, so it must reject anything without a shared secret **before doing
any work**.

- **Supabase secret name:** `NOTIFY_DISPATCH_SECRET`
- **Header the cron job sends and the function checks:** `x-dispatch-secret`
- Generate with `openssl rand -base64 32`.

Adding it now means it is in place when the dispatcher is written.

### Built

- [x] Edge function `notify-dispatch`, service role, `verify_jwt = false`
- [x] Shared-secret check returning 401 **before any work**
- [x] Query `state = 'scheduled'` and `due_at <= now()`, filtered to `active`
      executions — paused executions excluded
- [x] Send to every `push_subscriptions` row matching the step's own `user_id`
- [x] push-send's 404/410 row deletion reused; other errors reported, row left
- [x] Mark `sent` with `sent_at` when at least one endpoint succeeds
- [x] Payload carries step text and a deep link from `executionPath()`
- [x] Service worker updated so tapping actually opens that link
- [ ] Register the job in `platform_schedules` — SQL drafted, column names
      unverified; run the shape query first

### Files

| File | What |
|---|---|
| `supabase/functions/notify-dispatch/index.ts` | The dispatcher |
| `supabase/functions/notify-dispatch/deno.json` | `npm:web-push@3.6.7` |
| `supabase/config.toml` | `verify_jwt = false`, with the reset warning inline |
| `public/notify-sw.js` | `data.url` on the notification; `notificationclick` opens it |
| `docs/sql/phase5-dispatcher-cron.sql` | Scheduling + the async-aware verification queries |
| `docs/sql/phase5-platform-schedules.sql` | Staleness registration, shape-check first |

### Decisions worth knowing

- **No PostgREST embed for the executions join.** `notification_steps` has no
  foreign key to `executions` (`execution_id` is plain text, matching Alfred's
  legacy keys), and embedding requires one. Two queries plus a set filter
  instead. This is also exactly what makes **pause** work with no state on the
  step rows: a paused execution stops matching, and its steps sit untouched.
- **The deep link imports `executionPath()` from `src/viewPaths.js`** rather
  than rebuilding the path. Verified to load under Deno 2.1.4. It crosses out of
  `supabase/functions/` into `src/`, which the CLI bundler may or may not
  follow — if deploy fails on that import, the fallback is to inline
  `` `/schedule/execution/${encodeURIComponent(id)}` `` and add a source-parity
  test, but a hand-copied path is exactly the drift this project has been bitten
  by twice, so importing is the first choice.
- **The link is a PATH, not an absolute URL.** The service worker resolves it
  against its own origin, so there is no base-URL secret to set and no way to
  send anyone to the wrong host.
- **The service worker had to change.** `notificationclick` hardcoded `'/'`, so
  a deep link would have opened the home screen. It now reads
  `event.notification.data.url` — `data` is the only part of a notification that
  survives into the click handler, which runs in a separate worker invocation.
  An already-open window is focused **and navigated**; focusing alone would look
  like the tap was ignored.
- **`tag` is per execution, not per step**, so a later step replaces an earlier
  unread one for the same run rather than stacking on the watch.
- **A step with no subscriptions is left `scheduled`, not marked sent.**
  Subscribing a device later should deliver it, not find it silently consumed.
- **The `sent` update is conditional on `state = 'scheduled'`**, so a slow run
  and the next tick cannot both claim the same step.
- **Bounded read**: 200 steps per run. Anything beyond waits for the next tick.
- **Fail closed**: a missing `NOTIFY_DISPATCH_SECRET` returns 503, never 200.

### Verified locally before hand-off

Run against the real Deno 2.1.4 with a mock backend:

| Case | Result |
|---|---|
| No `x-dispatch-secret` header | **401**, nothing touched |
| Wrong secret | **401** |
| Wrong-length secret | **401**, no crash (the `timingSafeEqual` length guard) |
| Correct secret | Passes the gate, reaches the query |
| `NOTIFY_DISPATCH_SECRET` unset | **503**, with or without a header |

Type-checks clean under Deno 2.1.4, including the cross-tree `viewPaths.js`
import. `CI=true` frontend build clean.

### net._http_response growth

One row per minute is ~1,440/day. Recent pg_net prunes on its own; unproven
here. Step 3 of the cron SQL is a size check — run it after a day and add a
retention job only if it turns out to be unbounded.



- [ ] Minimal cron first: a scheduled job that only writes a row every minute.
      Confirm it actually fires before adding any real logic.
- [ ] New edge function, service role, `verify_jwt = false`
- [ ] Query due steps joined to `active` executions
- [ ] Send to every subscription for the step's `user_id`; reuse the 404/410
      row-deletion behaviour from `push-send`
- [ ] Mark the step `sent` so it fires once
- [ ] Include the execution deep link in the payload
- [ ] Register the job in `platform_schedules`

**Verify:** with Alfred fully closed, the first step of a live execution arrives
on phone and watch at its due time. Tapping it opens that execution. It does not
repeat a minute later.

---

## Phase 6 — Control surface

- [ ] Show the full step queue on the active execution, including `waiting` rows
- [ ] Cancel the remaining chain
- [ ] Edit a step's `due_at`
- [ ] Edit a step's text

**Verify:** each edit changes only the `notification_steps` row and leaves the
item's elements untouched.

---

## Phase 7 — Authoring picker

- [ ] Parallel component; reuse only the date helpers and the modal chrome from
      `CustomRecurrenceDialog`
- [ ] Repeat a contiguous block, N times
- [ ] Per-step offset in minutes
- [ ] Auto-numbering checkbox producing "Take dose 7 of 20"

**Verify:** generate the 20-dose antibiotic chain in one action, and the
13-step daily plan as a 4-step block repeated three times plus a closing step.

---

## Phase 8 — Skill amendment

*Last, once the field name is settled.*

- [ ] Update `alfred-enrich` to emit `offsetMinutes` on steps when a capture
      implies a timed sequence
- [ ] Include guidance on when NOT to — ordinary checklist steps and recipes
      must not acquire offsets

---

## Filed separately (not this feature)

- [ ] Alfred inbox: `CustomRecurrenceDialog` silently clears an intention's end
      date on reopen — live data-loss bug
- [ ] Alfred inbox: `onOpenInterval` is a dead prop on `RecurrenceQuickSelect`
- [ ] Decide whether `triggerRecurrence` should count from the archived event's
      due date rather than today

---

## Notes

---

## Phase 5b — the chain would not advance past a sent step

End-to-end mostly worked: cron fired, the dispatcher found the due step, FCM
returned 201, the notification arrived on phone and watch with the deep link.
But ticking a step whose row was already `sent` changed nothing — neither the
`done` transition nor the next row's scheduling.

### The hypothesis was wrong, and that matters

The proposed cause was that the completion path guards on `state = 'scheduled'`
and so falls through for a `sent` row. **It does not.** `'sent'` was never in
`TERMINAL_STATES`, and a test reproducing the exact reported rows — Marinate in
`sent`, Add stock in `waiting` — **passes against the unmodified code**,
producing both the `done` patch and the `scheduled` patch.

Audit of every state comparison in the chain, all four correct with respect to
`sent`:

| Site | Test | Correct? |
|---|---|---|
| `planCompletion` own row | `!TERMINAL_STATES.has(state)` | ✅ `sent` is not terminal → marks done |
| `planCompletion` next row | `state !== 'waiting'` | ✅ idempotency guard, unrelated to `sent` |
| `planCancellation` | `!TERMINAL_STATES.has(state)` | ✅ a `sent` row is cancelled on close |
| `planResume` | `state === 'scheduled'` | ✅ an already-fired row must not be re-timed |
| dispatcher mark-sent | `.eq('state','scheduled')` | ✅ |

So the state machine was sound and the failure is in the **write layer**.

### Two real defects, both found and fixed

1. **`applyPatch` never checked that the update matched a row.** A PostgREST
   UPDATE that RLS filters out returns **zero rows and no error** — a denied
   write was indistinguishable from a successful one. Now uses `.select("id")`
   and throws a message naming the likely cause when nothing comes back.

2. **The patch loop was fail-fast, coupling unrelated writes.** A tick produces
   two independent writes; in a plain `for … await` loop a failure on the first
   aborts the second. **That is why both effects vanished together** — not a
   shared guard, a shared loop. Now applied independently via `applyPatches`,
   which lands everything it can and then throws one error carrying all
   failures. `cancelNotificationSteps` and `resumeNotificationSteps` had the
   same coupling and now share the fix.

Together these convert the reported symptom from "nothing happened, silently"
into a specific error. **They do not by themselves explain WHY the r3 write
failed** — that error was swallowed. `docs/sql/phase5b-diagnose-stuck-completion.sql`
tests the leading hypothesis: the dispatcher updates with the service role, and
if anything in that path altered `user_id`, the row stops matching the owner
policy and the browser can no longer write it while neighbouring rows stay
writable.

### `no_subscription`

A due step whose user has no `push_subscriptions` row was staying `scheduled`
and being retried every minute forever, eating the 200-per-run cap.

Out of the send queue, deliberately **not** terminal — it behaves exactly like
`sent` in every path: the dispatcher ignores it, completion ticks through it,
close cancels it. Undeliverable is not undoable.

⚠️ Trade: subscribing a device later does **not** resurrect a step already
marked. Recovery is a deliberate `update … set state = 'scheduled'`.

Requires a schema change — `docs/sql/phase5b-no-subscription-state.sql` widens
the CHECK constraint and updates the column comment. **Run it BEFORE deploying
the new dispatcher**, or every such write fails the constraint.

### Status

- 561 tests across 25 suites; `CI=true` build clean; dispatcher type-checks
  under Deno 2.1.4.
- 9 new tests: the `sent` chain across all four planners, and `no_subscription`
  proven equivalent to `sent`.

---

## Phase 5b (cont.) — read layer audited, both hypotheses disproven

### The read path has NO state filter

`getNotificationSteps` is the only read on the completion path:

```js
supabase.from("notification_steps")
  .select("id, seq, text, offset_minutes, due_at, state, sent_at, completed_at")
  .eq("execution_id", executionId)
  .order("seq", { ascending: true });
```

No `.eq("state", …)`, no `.in("state", […])`. Every read of the table, audited:

| Read | Filter | Correct? |
|---|---|---|
| `getNotificationSteps` (completion, cancel, resume) | `execution_id` only | ✅ loads every state |
| dispatcher, due steps | `state = 'scheduled'`, `due_at <= now()` | ✅ that IS the send queue |
| dispatcher, mark sent / no_subscription | `.eq('state','scheduled')` guard | ✅ concurrency guard |

So the read layer is clean, and the hypothesis that a `sent` row is never
loaded does not hold.

### Closed by test at the API level

`src/utils/notificationStepsApi.test.js` — 17 tests driving fetch → plan → write
against a mocked PostgREST, with the production rows (Marinate `sent`, Add stock
`waiting`). Two of them assert **no state filter is applied on any read**, by
recording the filters the code actually calls. A filter reintroduced anywhere in
the read path now fails the suite rather than the kitchen.

### One hypothesis ruled OUT by test

If RLS hid only the sent row from the read, the planner would write no `done` —
but the next row's schedule depends on the **elements snapshot**, not on that
row, so **Add stock would still have advanced**. It did not. Per-row read
filtering therefore cannot explain the observation. Pinned as
`still schedules the next row when RLS hides the sent row from the READ`.

### What remains

Given the audit log shows no write, and the read/plan/write layers are all
clean, exactly two explanations survive:

1. **`advanceNotificationChain` was never called** — the tap was an *un-tick*.
   The guard is `if (!el.isCompleted)`, read from the element snapshot. If the
   element was already `isCompleted` (it was ticked at 19:58:49), tapping it
   un-ticks and the chain deliberately does not retreat: no write, no error,
   empty audit log. This matches the evidence exactly.
2. **The fetch returned zero rows for the whole execution** — early return, no
   writes. Requires RLS to hide *all* rows, not just the sent one.

Both are now instrumented rather than argued.

### Instrumentation — the next tick will say which

- `completeNotificationStep` returns **`rowsSeen`**, so "this item has no
  offsets" and "the rows exist but this client cannot see them" are no longer
  the same silence.
- `advanceNotificationChain` logs on **every** tick, not only when something
  changed: row count, patches completed, patches scheduled.
- The un-tick branch logs `chain not advanced (by design)`.

One line in the console now names the branch taken.

### Finding filed (not this phase): the audit log cannot see the service role

The dispatcher's service-role write at 21:16:03 is recorded in
`platform.audit_log` with `actor = 'ui'`. The `actor` column does not
distinguish a service-role write from a browser write, which is exactly what was
needed to diagnose this class of bug — the audit trail could not answer "who
last touched this row". Worth addressing in the platform layer: the dispatcher
sets no `x-actor` header and falls through to the default.

### Status

- 578 tests across 26 suites; `CI=true` build clean.
- Write layer hardened (`.select("id")` + independent `applyPatches`), read
  layer audited and closed by test, completion path instrumented.

---

## Phase 5c — a dead subscription that reported success

The chain logic was fine; the completion failures were a stale build. The real
defect was underneath it.

**An FCM endpoint returned 201 for three consecutive sends and delivered
nothing.** The subscription died mid-session while the stored row went on
looking healthy. Every send reported success, every step was stamped `sent_at`
and left the queue, and nothing arrived — with no error at any layer.

### The structural consequence

**404/410 pruning cannot be relied on.** A dead FCM registration can answer 201
indefinitely rather than the 410 that would delete the row. `push_subscriptions`
does not correct itself, so something outside the send path has to keep it
honest.

And `sent` can never mean "delivered" — Web Push has no delivery receipt. Now
stated outright in the spec so nobody later tries to make it mean more.

### Built

- [x] **`pushsubscriptionchange` handler** in `public/notify-sw.js`. Resubscribes
      with the **same** application server key (a different key produces a
      subscription the dispatcher's VAPID pair cannot send to), records
      `{ oldEndpoint, newEndpoint }` in IndexedDB, postMessages open clients.
- [x] **App-load reconcile** — `src/utils/pushSubscriptions.js`. Compares
      `pushManager.getSubscription()` against the table and repairs. Never
      registers a worker, never creates a subscription: a user who has not
      enabled push is untouched.
- [x] **Live repair** when the worker messages an open client.
- [x] **Rotation drill** in the Games diagnostic — forces the exact state a
      rotation leaves behind, without waiting for Chrome.
- [x] Spec: `sent` = accepted, not delivered; rotation causes; stale pruning
      considered and declined with reasons.

### Why the worker does not write to Supabase

supabase-js keeps the session in `localStorage`, which a service worker cannot
read. It has no credentials. So the worker does the half it can — resubscribe —
and hands the database swap to the app via IndexedDB, the only store both
contexts share.

⚠️ **That handoff is a twin site.** The DB, store and key names are duplicated
in `notify-sw.js` because a worker cannot import from `src/`. If they drift, the
worker writes a record the app never reads and the repair silently stops working
with nothing failing anywhere. Three tests read the worker's source and assert
the literals match.

### The dangerous mistake, avoided and pinned

"Delete every row that is not the current endpoint" would silently unsubscribe
the user's **other devices**. Only the endpoint the worker explicitly recorded
as rotated away from is removed. Test: `NEVER deletes another device's row`.

### Why it rotated — unresolved, deliberately

The redeploy is the obvious suspect, but **a service worker update does not
normally invalidate push subscriptions**: a subscription belongs to the
registration, not the script version, and `skipWaiting()` / `clients.claim()`
change which script is active, not the registration. Suspect, not cause.

The repair was built before the cause was known because it makes the failure
survivable either way. To settle it: note the endpoint tail before a deploy and
check it after.

### Status

- 595 tests across 27 suites; `CI=true` build clean.
- 17 new tests: the reconcile planner including the other-device case, and the
  worker/app twin-site guard.
