# Technical Spec: Chained Notifications

## Overview

Deliver push notifications to a phone and watch for the steps of an active
execution, where each step is scheduled relative to the completion of the
previous one.

The driving use cases:

- **Antibiotic course.** Twenty doses, six hours apart. Dose two is due six
  hours after dose one is actually taken, not six hours after it was due.
- **Daily movement plan.** Thirteen micro-activities spaced roughly an hour
  apart, authored as four-step blocks repeated three times with the leg movement
  swapped per pass, plus a closing carry.

Both are the same mechanism: a list of steps, each with a delay measured from
the previous step's completion, delivered as push notifications that link back
to the execution they belong to.

## What is already proven

A two-stage proof of concept was built as a "Push Notification Test" entry in
the Games tab and verified on a Pixel 7 with a Pixel Watch.

- **Stage 1** — a service worker at `public/notify-sw.js` raising local
  notifications. Confirmed working on the lock screen and when switching apps.
  Not delivered when Alfred was fully closed, which is expected of a
  `setTimeout`.
- **Stage 2** — real Web Push. VAPID keys generated; public key in Vercel as
  `REACT_APP_VAPID_PUBLIC_KEY`, public and private key plus `VAPID_SUBJECT` in
  Supabase edge function secrets. Table `public.push_subscriptions` created and
  registered, CONFORMANT. Edge function `push-send` sends to the caller's own
  subscriptions using `npm:web-push@3.6.7` under a request-scoped client, with
  404/410 responses deleting the dead row. Verified: notification delivered to
  phone and watch with Alfred fully swiped out of recents, triggered by curl
  from a separate machine, including custom title and body.

The delivery chain is therefore not a risk. Everything below builds on it.

## Data model

### Elements — `offsetMinutes`

A new optional key on item elements, meaningful only on `displayType: "step"`,
deleted when the type changes away. This mirrors the existing treatment of
`collectable` on bullets.

```json
{
  "displayType": "step",
  "name": "Take dose 7 of 20",
  "offsetMinutes": 360
}
```

The value is the delay **before** this step, measured from the completion of the
**preceding completable element** — not from the previous notification. See
*Starting an execution* for what that means when notifying and non-notifying
work are mixed.

> ⚠️ **Elements have no `id` field.** An earlier version of this example showed
> `"id": "e2"`. Nothing in Alfred puts an id on an element: `addElement` creates
> `{ name, displayType, quantity, description }`, and all six normalisers build
> an explicit key set that would *strip* an id if one appeared. Nothing needs
> one: the snapshot is frozen at execution start, so an element's index is its
> identity for the life of the run, and `notification_steps.seq` records it.

> **Storage key: `offset_minutes`, not `offsetMinutes`.** `elements` is jsonb and
> `storage.toSnakeCase` recurses into arrays, which is why `item_collections.items`
> holds `item_id` on disk. React state holds `offsetMinutes`; Postgres holds
> `offset_minutes`. The round trip through the app is symmetric so the frontend
> never sees the difference — but anything reading `elements` directly from
> Postgres, notably the expansion in Phase 4 and the dispatcher in Phase 5, must
> read `offset_minutes`. The `readOffsetMinutes` helper in
> `src/utils/elementOffsets.js` accepts both spellings.

Because the offset lives on the element object, reordering the elements array
moves each step's gap with it. No renumbering or repair pass is required.

**Every step carries an offset, including the first and last.** The value is
ignored when nothing completable precedes the step, because it is then scheduled
at execution start. On the last step it is ignored because there is no
successor. This is deliberate dead data: storing `0` on the first step would
silently mean "fire immediately after the previous element" if that step were
later dragged into the middle.

**The minutes input renders and is editable at every position, including the
first.** Position one additionally carries a muted "at start" note *alongside*
the input — never in place of it. It says "this value is not used while this
step is first", not "this step has no value".

> ⚠️ **The obvious reading of that is wrong, and an earlier draft of this spec
> said it.** "Label position one as 'at start' rather than showing a gap" was
> implemented as *replacing* the input with the label, which makes the value
> unauthorable at position one. A step created at the top then never gets an
> offset, and dragging it down leaves a blank — defeating the entire reason the
> offset lives on the element rather than on the item. Position must never
> gate authorship, and it must never clear a stored value: moving a step in and
> out of first place is lossless.

Elements with no offset — headers, bullets, and plain steps — own no row. An
item can therefore mix scheduled and unscheduled content with no per-item flag.
They are not ignored, though: a plain step with no offset still starts the clock
for the notification after it.

> 🔒 **Phase 2's steps-only restriction is load-bearing, not cosmetic.** The
> element editor only offers the minutes input on `step` rows and deletes
> `offsetMinutes` when a row changes type, in both `updateElement` copies. That
> is what guarantees a bullet can never own a notification row — and since
> bullets have no checkbox in an execution, a bullet that owned one could never
> be ticked and would stall the chain permanently. The invariant holds with no
> extra work in expansion, but it must not be relaxed without replacing it.

> ✅ **Closed (was: a `missing` or `circular` step can stall a chain).** Those
> elements render without a checkbox — a deleted child item, or a circular
> reference — while still being steps. Originally they could carry an offset,
> own a row, fire a notification, and never be tickable, stopping the chain with
> no way to advance it from the UI.
>
> Closed by making row ownership and tickability the same predicate:
> `ownsNotificationRow` is defined as `isTickableElement(el) && has an offset`,
> so the two cannot drift. Both flags are set by `flattenElements` when the
> snapshot is taken, so this is knowable at expansion.
>
> A broken step now owns no row, and `precedingTickableIndex` already looks back
> past it to the last real step — so the element after it is still scheduled,
> from the last completion that actually happened. **The chain loses one
> notification instead of stalling permanently**, which is the right trade: a
> missed reminder is recoverable, a dead chain is not.
>
> The general rule this expresses: **a row may only be owned by an element the
> UI can actually tick.** Any future element type that renders without a
> checkbox inherits this for free.

> **Twin-site rule.** Every normaliser in `Alfred.jsx` has a shadow copy inside
> a dirty-check effect. `collectable` was previously stripped on open-and-save
> cycles because only one site was updated. Adding `offsetMinutes` must touch
> both sites, and the verification step is: open an item with offsets, save
> without changing anything, confirm the offsets survive.

### New table — `notification_steps`

One row per scheduled step, generated when an execution starts. Rows are copies:
editing a step's text or time affects this run only and never the item's
elements.

```sql
create table public.notification_steps (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid(),
  execution_id  text not null,
  seq           integer not null,
  text          text not null,
  offset_minutes integer not null,
  due_at        timestamptz,
  state         text not null default 'waiting',
  sent_at       timestamptz,
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (execution_id, seq),
  constraint notification_steps_state_check check (
    state in ('waiting','scheduled','sent','done','skipped','cancelled')
  )
);
```

> **The `COMMENT ON` statements on the live table are authoritative, not this
> DDL.** Where the two disagree, the column comments win.
>
> An `element_id` column was added in Phase 3 and then **dropped**, along with
> its `(execution_id, element_id)` constraint. It carried exactly the same
> information as `seq`, including the same uniqueness guarantee. The snapshot is
> frozen at execution start, so the element's index *is* its identity for the
> life of the run and `seq` already expresses it. A column duplicating its
> neighbour would mislead the next reader.

`execution_id` is `text`, matching Alfred's legacy text primary keys. `user_id`
is `uuid`, as it is everywhere.

`user_id` is denormalised onto the row deliberately. It allows
`p_policy_mode => 'owner'`, and it lets the dispatcher find the target
subscriptions without walking back through `executions` under a service-role
client.

Registration, per the platform contract:

```sql
select platform.register_table(
  'public.notification_steps',
  p_policy_mode => 'owner',
  p_audited     => true,
  p_exempt      => false,
  p_notes       => 'Alfred: scheduled notification steps for an active execution.'
);
```

Every column needs a `COMMENT ON`, and the migration block ends with
conformance returning CONFORMANT.

> **Platform facts confirmed against the live database, Phase 5.** Recorded here
> because both MCP connectors were down and these are not guessable:
>
> - The conformance function is **`platform.check_conformance()`**, no
>   arguments. (Earlier prose in this spec said `check_platform_conformance`;
>   that is the MCP tool name, not the SQL function.)
> - `register_table`'s real signature is
>   `(p_table regclass, p_policy_mode text, p_audited boolean, p_exempt boolean, p_notes text)`.
> - ⚠️ **There is NO `unregister_table` or any inverse.** The `platform` schema
>   contains only `audit_row`, `check_call_budget`, `check_conformance`,
>   `maybe_prune`, `prune_call_log`, `register_table` and
>   `rollback_audit_entry`. **Removing a table means deleting from
>   `platform.registry` by `table_name` MANUALLY, and it must be done BEFORE
>   dropping the table.** Drop first and you leave a registry row pointing at
>   nothing, which conformance will flag with no obvious cause.

### State machine

| State | Meaning |
|---|---|
| `waiting` | Created, no due time yet. The default for every step but the first. |
| `scheduled` | `due_at` is set. Eligible for the dispatcher. |
| `sent` | Notification delivered. Awaiting completion. |
| `done` | Marked complete. Stamps the next step's `due_at` and moves it to `scheduled`. |
| `skipped` | Explicitly passed over. Advances the chain like `done`. |
| `cancelled` | Chain was cancelled or the execution closed. Terminal. |

Transitions: `waiting → scheduled → sent → done`. Any non-terminal state can go
to `cancelled`. `scheduled` or `sent` can go to `skipped`.

**A chain advances only on `done` or `skipped`.** If a step is never completed,
nothing further is scheduled — the chain stalls with one outstanding
notification rather than accumulating a backlog. This is intended behaviour.

## Behaviour

### Starting an execution

> ⚠️ **SUPERSEDED READING — do not implement this.** An earlier version of this
> section said expansion *"filters to steps carrying an `offsetMinutes`, and
> writes one row per step in order. Step 1 gets `due_at = now()`"*, and that
> completion *"finds the next row by `seq`"*. That chains the **notifying steps
> to each other**, which is wrong. It breaks the moment an item mixes notifying
> and non-notifying work:
>
> ```
> 1. Chop onions          no offset — no notification
> 2. Saute onions         no offset — no notification
> 3. Marinate 30 minutes  offset 30 — notification
> ```
>
> Under the superseded reading, "Marinate" is chain position 1 and therefore
> fires at execution start — 30 minutes before the onions are even chopped.

**An offset is measured from the completion of the PRECEDING ELEMENT, whether
or not that element notifies.** It is not measured from the previous
notification. Ticking "Saute onions" is what schedules "Marinate" for 30 minutes
later.

Expansion reads the execution's snapshotted `elements` and writes one
`notification_steps` row per element that **has** an offset. Elements without one
get no row and are never scheduled — but they still participate, because they
can be the preceding element that starts another row's clock.

- `seq` is the element's **position in the full element list**, 1-based. Gaps
  are normal and expected: in the recipe above the only row has `seq = 3`.
- `text` is copied from the element name.
- A row is scheduled at execution start — `due_at = now()`, state `scheduled` —
  **only when it has no preceding completable element**. Every other row starts
  `waiting` with a null `due_at`.

> **Reading `offsetMinutes` off a snapshot.** The execution's `elements` came
> from jsonb, so the key on disk is `offset_minutes`. Use `readOffsetMinutes`
> from `src/utils/elementOffsets.js`, which accepts both spellings.

**"Preceding completable element" means the nearest earlier element that can
actually be ticked.** Only steps can be ticked in an execution — see the
Completable elements note below — so headers and bullets are skipped when
looking backwards. An element with no completable element before it is the head
of the chain.

Because `elements` is already a flattened snapshot copied onto the execution at
start, editing the item afterwards does not affect a running chain. This is
correct and consistent with the existing snapshot semantics, but must be stated
in the UI or it reads as a bug.

> **Completable elements.** In `ExecutionDetailView`, `header` renders as a
> heading and `bullet` renders as a static list row — **neither has a checkbox
> or an `onToggleElement` handler**. Only `step` (and any unrecognised
> `displayType`, which falls through to the same branch) renders a tickable
> checkbox. Elements flagged `missing` or `circular` return early and are not
> tickable either, whatever their type.
>
> So the completable set is **steps only**. Bullets are *not* completable,
> despite being a natural guess — a chain that treated them as clock-starters
> would stall forever waiting for a tick that no UI can produce.

### Completing an element

When an element is marked complete:

- **If a row's preceding completable element is the one just completed**, set
  that row's `due_at` to `now() + offset_minutes` and move it to `scheduled`.
- **If the completed element owns a row itself**, stamp that row's
  `completed_at` and state `done`.

Both can apply to the same tick: completing a step that has its own row and is
also the predecessor of the next row closes one and starts the other.

Drift is real and intended: a dose taken 35 minutes late pushes every subsequent
dose 35 minutes later.

### Pausing and resuming

Executions have statuses `active`, `paused`, `closed`.

The dispatcher only considers steps whose execution is `active`, so pausing
stops notifications with no extra state on the step rows.

On resume, any `scheduled` step whose `due_at` has passed during the pause is
rescheduled to `now()` rather than firing immediately for a time that has gone
by. A step still in the future keeps its `due_at`.

### Closing an execution

All non-terminal steps move to `cancelled`.

### Concurrency

Two executions of the same item are permitted. Each has an independent chain and
both will send notifications. This is accepted, not a bug.

## Dispatcher

A new edge function, separate from `push-send`. `push-send` remains as the
manual test tool authenticated as the calling user; the dispatcher runs with no
user.

- Deployed with `verify_jwt = false`, called by `pg_cron` via `pg_net` on a
  one-minute schedule. This is the second function in the project to disable JWT
  verification; note that the flag has previously reset silently on redeploy.
- Uses the service role, because cron has no user token.
- Query: steps where `state = 'scheduled'` and `due_at <= now()`, joined to
  executions with `status = 'active'`.
- For each due step, send to every `push_subscriptions` row matching the step's
  `user_id`.
- Payload carries the step text and a deep link URL to the execution.
- A 404 or 410 from the push service deletes that subscription row. Any other
  error leaves the row alone and is reported. Both behaviours are already
  implemented in `push-send` and should be reused.
- The step moves to `sent` with `sent_at` stamped, so it fires once rather than
  every sixty seconds until dealt with.

**Multiple devices.** A user subscribed on more than one device receives the
notification on each. A step counts as `sent` if at least one endpoint
succeeded; per-endpoint results are logged. Deduplication across devices is out
of scope.

**Observability.** Register the dispatcher in `platform_schedules` so a silent
failure is detectable. Note that `platform_schedules` is a staleness-detection
table only — it defines what *should* run and does not execute anything. Its
cadence vocabulary is daily/weekly, so it can describe the dispatcher job but
cannot express the per-step scheduling; that lives entirely in
`notification_steps.due_at`.

## Delivery is not guaranteed, and `sent` does not mean delivered

> 🛑 **`sent` means "the push service accepted this request". It does not mean
> the phone showed anything.** Web Push has **no delivery receipt**. There is no
> mechanism, anywhere in the protocol, by which Alfred can learn that a
> notification was displayed. Do not add one; do not make `sent` imply one.

Observed in the field, and the reason this section exists: an FCM endpoint
returned **201 for three consecutive sends and delivered nothing**. The
subscription had died mid-session while the stored row went on looking healthy.
Every send reported success, every step was stamped `sent_at` and left the
queue, and the user got nothing — with no error at any layer.

The consequence is structural: **the 404/410 pruning cannot be relied on.** A
dead FCM registration can answer 201 indefinitely rather than the 410 that would
delete the row. So `push_subscriptions` does not correct itself, and something
outside the send path has to keep it honest.

### Subscription rotation and repair

`pushsubscriptionchange` fires in the service worker when the browser
invalidates a subscription. Without a handler, a rotated subscription becomes a
dead letterbox: the old endpoint stays in the table, the dispatcher keeps
sending to it, FCM keeps answering 201, and the only recovery is a user noticing
and resubscribing by hand.

Two layers, because neither is sufficient alone:

1. **The worker handles `pushsubscriptionchange`.** It resubscribes with the
   **same** application server key — a subscription made with a different key
   cannot be sent to with the old one — and records `{ oldEndpoint,
   newEndpoint }` in IndexedDB, then postMessages any open client.

   The worker deliberately does **not** write to Supabase. supabase-js keeps the
   session in `localStorage`, which a service worker cannot read, so it has no
   credentials to write with.

2. **The app reconciles on load.** `pushManager.getSubscription()` is the only
   authority on what this device actually holds. It is compared against the
   table and repaired. This is the backstop for a rotation that happened while
   Alfred was closed, and for one where the worker never got to run.

> ⚠️ **The reconciler must never delete "every row that is not the current
> endpoint".** Other rows belong to the user's OTHER DEVICES. Only the endpoint
> the worker explicitly recorded as rotated away from is removed. Pinned by
> test: `NEVER deletes another device's row`.

The reconciler never registers a worker and never creates a subscription — a
user who has not enabled push is untouched.

### 🛑 The rotation outage window

**A rotation while Alfred is closed leaves the device unreachable until the app
is next opened.** This is a property of the architecture, not a bug, and it must
be stated plainly:

1. The browser invalidates the subscription and fires `pushsubscriptionchange`.
2. The worker resubscribes — the **browser** now holds a working endpoint.
3. The worker **cannot write to Supabase**. supabase-js keeps the session in
   `localStorage`, which a service worker cannot read, so it has no credentials.
4. `push_subscriptions` therefore still holds only the **dead** endpoint. The
   dispatcher sends to it, FCM answers **201**, steps are stamped `sent` and
   leave the queue, and nothing arrives.
5. The table is repaired on the next app load, by the reconciler.

So the window runs from the rotation until the user next opens Alfred —
unbounded, and for a feature whose whole purpose is working while the app is
closed, a silent outage.

**Partial mitigation, shipped:** when the worker rotates and finds **no open
window**, it raises a notification — *"Alfred needs reconnecting"* — through the
subscription it just created. That is the one message this device can still
deliver, and tapping it opens Alfred, which reconciles on load. The outage
becomes visible and one tap from repair instead of silent and indefinite.

It is a mitigation, not a fix. It depends on the user seeing and tapping it.

**The complete fix, designed but NOT built** — an edge function the worker can
call with no user token:

- `push-rotate`, `verify_jwt = false`, service role.
- The worker POSTs `{ oldEndpoint, oldAuth, newSubscription }`.
- The function looks up the row by `old_endpoint`, **verifies the supplied
  `auth_key` matches the stored one**, and updates that row in place.
- Possession of both the endpoint URL and its auth secret is the proof of
  ownership — the same pair the push service itself requires to deliver. No user
  session is involved, so the worker can do it alone.
- This closes the window entirely: the table is correct within seconds of the
  rotation, whether or not Alfred is ever opened.

Not built because it is a new public endpoint that writes subscriptions, and it
needs its own security review, deploy and SQL. Worth doing if rotations turn out
to be anything other than rare.

### Why did it rotate?

Unresolved, and worth stating plainly rather than assuming.

The obvious suspect is the frontend redeploy between tests, which updated
`notify-sw.js` for the deep link. **But a service worker update does not
normally invalidate push subscriptions** — a subscription belongs to the
*registration*, not to the worker script version, and `skipWaiting()` /
`clients.claim()` change which script is active, not the registration. So the
redeploy is a suspect, not a demonstrated cause.

Other candidates, none excluded:

- FCM rotating its registration on its own schedule, which it does.
- A changed `applicationServerKey` between builds. Excluded here — the VAPID
  keys were stable — but it is the classic cause and worth checking first next
  time.
- Anything that unregistered the worker: clearing site data, a scope change, a
  different worker claiming the scope.

**If a redeploy does turn out to invalidate subscriptions in this setup, it is a
recurring problem on every deploy, not a one-off.** The repair above makes it
survivable either way, which is why it was built before the cause was known. To
settle it, note the endpoint tail before a deploy and check it after: the
diagnostic's status panel shows it, and the app-load reconcile logs any change.

### Stale subscriptions — considered, not built

A subscription that no longer works but keeps returning 201 will sit in the
table forever. Pruning "no successful app-load reconciliation in N days" would
need a `last_seen_at` column stamped by the reconciler — `last_used_at` means
"last sent to" and would be stamped by exactly the sends that are failing
silently, so it cannot serve this purpose.

Not built: it is a new column and a new migration, and the repair above
addresses the cause rather than the symptom. Worth revisiting if dead rows
accumulate in practice.

## Deep linking

**This is a prerequisite, not a nice-to-have.** `viewPaths.js` currently maps
`execution-detail` to `/schedule/execution` with no id segment, and a cold load
with `activeExecution === null` redirects to `/schedule`. A notification tap
would land on the schedule list with no indication of which step fired.

Add an id-bearing route following the existing SAM precedent (`samSongPath` /
`samSongIdFromPath` at the bottom of `viewPaths.js`), plus a cold-load path that
fetches the execution by id rather than relying on in-memory state.

This is effectively slice 2 of the URL routing migration arriving early.

## Authoring UI

### Setting offsets

Phase 2 adds a plain minutes input to the existing element editor, enough to
hand-author a chain and prove the whole pipeline before any picker exists.

### The picker

A **parallel component**, not a reuse of `RecurrenceQuickSelect` or
`CustomRecurrenceDialog`. Those are cleanly decoupled and extractable, but their
vocabulary is calendar-anchored — the smallest unit anywhere in the recurrence
stack is a day, `calculateNextEventDate` normalises to local midnight, and
"ends" is date-based with no count representation. Generalising them would mean
adding a sub-day time dimension and a count-based end mode to a component two
live Intentions call sites depend on.

Reuse the pure date helpers in `src/utils/recurrence.js`, and copy the modal
chrome of `CustomRecurrenceDialog` so the picker looks native to Alfred.

Capabilities:

- **Repeat a block, N times.** Select a contiguous range of steps and repeat it.
  A block of one covers "take a dose, every 6 hours, 20 times". A block of four
  covers the pull/legs/push/core cycle repeated three times, after which the leg
  row in passes 2 and 3 is edited by hand.
- **Offset per step**, in minutes, with a sensible unit affordance (an hour is
  60, not something the user should have to compute).
- **Auto-numbering checkbox.** Generates text like "Take dose 7 of 20". Twenty
  identically named rows are unreadable in the item editor and useless in a
  notification.

## Control surface

On the active execution, the user can:

- See the full queue, including `waiting` steps that have no due time yet.
- Cancel the remainder of the chain.
- Edit an individual step's `due_at`.
- Edit an individual step's text.

Edits apply to the `notification_steps` row for this run only. They never write
back to the item's elements. If the same edit is being made every day, the
template is wrong and the item should be changed instead.

## Known friction

Marking a step complete requires tapping through to the execution and using the
existing completion control. Because the chain only advances on completion, this
is more load-bearing than completion is elsewhere in Alfred.

Android supports action buttons on notifications, which would allow completing
from the wrist. That needs an endpoint the service worker can call with no page
open and no user token, which shapes how completion authenticates. It is
deliberately out of scope for the first build, but the completion path should
not be designed in a way that forecloses it.

## Out of scope

- **Explicit clock times.** Everything is relative to completion. Storing
  `due_at` as a `timestamptz` rather than as an interval means fixed times can
  later be added as a second way to populate the same column, with no change to
  the dispatcher or the state machine.
- **Timezone handling.** Not needed while all scheduling is relative.
- **Notification action buttons.**
- **Cross-device deduplication.**

## Related issues found during investigation

Neither belongs to this feature; both should be filed to the Alfred inbox.

1. **Live data-loss bug in Intentions.** `CustomRecurrenceDialog` does not
   restore the end date when reopened — `initialConfig` carries the config but
   not the end date, and the dialog hardcodes `endMode` to `"never"`. An
   intention with an end date reopens showing Never, and pressing Done silently
   clears it.
2. **`onOpenInterval` is a dead prop** on `RecurrenceQuickSelect` — present in
   the signature, unused in the body.
3. **`triggerRecurrence` counts intervals from today**, not from the archived
   event's due date. Defensible but currently accidental; worth making an
   explicit decision.

## Success criteria

1. An item can be authored with a repeated block of steps carrying offsets, with
   auto-numbered text.
2. Opening and saving that item preserves every offset (twin-site check).
3. Starting an execution creates the full step list, with only step 1 scheduled.
4. The first notification arrives on phone and watch with Alfred fully closed.
5. Tapping the notification opens Alfred directly to that execution.
6. Marking the step complete schedules the next one at completion time plus its
   offset.
7. Pausing stops notifications; resuming reschedules an overdue step to now
   rather than firing for a passed time.
8. Closing the execution cancels all remaining steps.
9. `check_platform_conformance` returns CONFORMANT.