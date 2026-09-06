import { readOffsetMinutes } from "./elementOffsets";

/**
 * The notification chain — pure planning. Phase 4.
 *
 * No side effects, no app imports, no React, no Supabase. Every function here
 * takes the execution's snapshotted elements plus the current rows and returns
 * what *should* change; `notificationStepsApi.js` is what writes it. Keeping
 * the decisions separable is what makes them testable without a database.
 *
 * ── The rule everything follows ────────────────────────────────────────────
 *
 * An offset is the delay BEFORE an element, measured from the completion of the
 * PRECEDING ELEMENT, whether or not that element notifies. It is NOT measured
 * from the previous notification.
 *
 *   1. Chop onions          no offset — no row
 *   2. Saute onions         no offset — no row
 *   3. Marinate 30 minutes  offset 30 — row, seq 3
 *
 * Ticking "Saute onions" is what schedules "Marinate" for 30 minutes later. The
 * earlier reading — chain the notifying steps to each other — would have made
 * "Marinate" chain position 1 and fired it at execution start, 30 minutes
 * before the onions were chopped.
 *
 * `seq` is therefore the element's 1-based position in the FULL element list,
 * not its position among rows. Gaps are normal: the recipe above produces one
 * row, with seq 3.
 */

/**
 * States the CHAIN will not move a row out of on its own.
 *
 * `cancelled` is here, but it is **not permanent**: "Schedule remaining" and
 * the per-step restore put a cancelled row back under chain control. Nothing
 * automatic resurrects one — only a deliberate user action — which is the
 * distinction this set encodes. See RESTORABLE_STATES.
 */
export const TERMINAL_STATES = new Set(["done", "skipped", "cancelled"]);

/**
 * States a user can explicitly bring back into the chain.
 *
 * Cancelling is a decision, not a death: the queue is a control surface, and a
 * control that cannot be undone is a trap. Restoring recomputes the due time
 * from NOW rather than reinstating the original `due_at`, which would fire
 * immediately for a moment that has already passed.
 */
export const RESTORABLE_STATES = new Set(["cancelled"]);

/**
 * Set by the dispatcher when a step comes due and its user has no
 * `push_subscriptions` row at all.
 *
 * It is out of the send queue but NOT terminal, and that distinction is the
 * whole point:
 *
 *   - The dispatcher only looks at `scheduled`, so the step is not retried
 *     every sixty seconds forever, and cannot crowd real steps out of the
 *     200-per-run cap. A household member who never subscribes would otherwise
 *     accumulate a permanent backlog of unsendable work.
 *   - Completion still ticks straight through it — it is not in
 *     TERMINAL_STATES — so a chain whose notification could not be delivered
 *     still advances normally when the step is ticked in the UI. Undeliverable
 *     is not the same as undoable.
 *   - Closing an execution still cancels it, like any other non-terminal row.
 *
 * In every code path it behaves exactly like `sent`; only the reason differs.
 *
 * ⚠ The trade: subscribing a device later does NOT resurrect a step already
 * marked this way. Recovering one is a deliberate act — set it back to
 * `scheduled`.
 */
export const NO_SUBSCRIPTION = "no_subscription";

const typeOf = (el) => el.displayType || el.display_type || "step";

/**
 * Can this element own a notification row?
 *
 * Defined AS "tickable, and carrying an offset" rather than as its own list of
 * conditions, so the two can never drift apart. That equivalence is the whole
 * safety property: **a row may only be owned by an element that can actually be
 * ticked.** A row whose element has no checkbox can fire and then never be
 * completed, and the chain stops there with no way to advance it from the UI.
 *
 * Two things this rules out, for two different reasons:
 *
 *   - **Bullets and headers.** Phase 2 already prevents authoring an offset on
 *     them, but that invariant is enforced here too rather than assumed — a
 *     bullet with an offset is still reachable by writing jsonb directly, from
 *     an MCP tool or the enrich function.
 *   - **`missing` and `circular` steps.** Both flags are set by
 *     `flattenElements` at snapshot time, so this is knowable at expansion.
 *     A broken step now owns no row, and `precedingTickableIndex` looks back
 *     past it to the last real step — so the chain loses one notification
 *     instead of stalling permanently.
 */
export function ownsNotificationRow(el) {
  return isTickableElement(el) && readOffsetMinutes(el) !== undefined;
}

/**
 * Can this element be ticked in an execution?
 *
 * Mirrors ExecutionDetailView exactly. `header` renders a heading and `bullet`
 * renders a static row — neither has a checkbox or an onToggleElement handler.
 * Everything else falls through to the tickable branch, which is why this tests
 * "not header and not bullet" rather than "is step": an unrecognised
 * displayType renders as a step and can be ticked.
 *
 * `missing` and `circular` return early in the view with no checkbox whatever
 * their type, so they cannot start a clock.
 */
export function isTickableElement(el) {
  if (!el || typeof el !== "object") return false;
  if (el.missing || el.circular) return false;
  const type = typeOf(el);
  return type !== "header" && type !== "bullet";
}

/**
 * Index of the nearest earlier element that can be ticked, or -1 when there is
 * none. -1 means "head of the chain": nothing can start this element's clock,
 * so it is scheduled at execution start.
 */
export function precedingTickableIndex(elements, index) {
  if (!Array.isArray(elements)) return -1;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (isTickableElement(elements[i])) return i;
  }
  return -1;
}

/**
 * Expand a snapshot into the rows to insert at execution start.
 *
 * Returns snake_case rows ready for the table — this output goes straight to
 * Postgres and never through storage.toSnakeCase, so it is written in the
 * database's spelling rather than React's.
 *
 * @param {Array}  elements  The execution's snapshotted elements.
 * @param {string} nowIso    Execution start, as an ISO string.
 */
export function expandNotificationSteps(elements, nowIso) {
  const list = Array.isArray(elements) ? elements : [];
  const rows = [];

  list.forEach((el, index) => {
    if (!ownsNotificationRow(el)) return;
    // Head of the chain: nothing precedes it that could ever be ticked, so its
    // offset is ignored and it starts scheduled. This is the ONLY row that can
    // be scheduled at expansion time.
    const isHead = precedingTickableIndex(list, index) === -1;
    rows.push({
      seq: index + 1,
      text: el.name || "",
      offset_minutes: readOffsetMinutes(el),
      state: isHead ? "scheduled" : "waiting",
      due_at: isHead ? nowIso : null,
    });
  });

  return rows;
}

/**
 * What a tick changes.
 *
 * Two independent effects, and one tick can produce both — completing a step
 * that owns a row and is also the predecessor of the next one closes the first
 * and starts the second.
 *
 * @param {Array}  elements       The execution's snapshotted elements.
 * @param {Array}  rows           Current notification_steps rows for this run.
 * @param {number} completedIndex Index of the element just ticked.
 * @param {string} nowIso         Completion time, as an ISO string.
 * @returns {{complete: Array, schedule: Array}} Row patches, each with an id.
 */
export function planCompletion(elements, rows, completedIndex, nowIso) {
  const list = Array.isArray(elements) ? elements : [];
  const all = Array.isArray(rows) ? rows : [];
  const complete = [];
  const schedule = [];

  // 1. The row the completed element owns, if it has one.
  const own = all.find((r) => r.seq === completedIndex + 1);
  if (own && !TERMINAL_STATES.has(own.state)) {
    complete.push({ id: own.id, state: "done", completed_at: nowIso });
  }

  // 2. Rows whose clock this completion starts.
  for (const row of all) {
    if (row.seq === completedIndex + 1) continue; // its own row, handled above
    // Only `waiting` advances, and that single line carries two rules.
    //
    //   1. Idempotency — un-ticking and re-ticking must not push a live due
    //      time further out each time.
    //
    //   2. 🛑 A MANUAL TIME OUTRANKS THE CHAIN. A row the user scheduled by
    //      hand is already `scheduled`, so completing the element before it
    //      leaves that time alone. Scheduled for 2pm and the previous step
    //      finished at 1:30? It still fires at 2pm. A deliberate override is
    //      not something an unrelated completion should quietly overwrite.
    //
    // The override is temporary, not a mode change: reverting the row hands it
    // back to the chain, and if its predecessor has already completed the
    // revert re-arms it immediately. See planRevertToChain — that is what stops
    // a manual time from severing the link permanently.
    if (row.state !== "waiting") continue;
    if (precedingTickableIndex(list, row.seq - 1) !== completedIndex) continue;

    schedule.push({
      id: row.id,
      state: "scheduled",
      due_at: addMinutes(nowIso, row.offset_minutes),
    });
  }

  return { complete, schedule };
}

/** Rows to cancel: everything the chain still has live. */
export function planCancellation(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => !TERMINAL_STATES.has(r.state))
    .map((r) => ({ id: r.id, state: "cancelled" }));
}

/**
 * Hand one row back to the chain.
 *
 * Used by the per-step revert and by "Schedule remaining". The chain — not the
 * caller — decides where the row lands, which is what makes the link
 * unseverable:
 *
 *   - **Predecessor not yet completed** → `waiting`, no due time. The normal
 *     completion path arms it when the time comes.
 *   - **Predecessor already completed** → armed straight away at
 *     `now + offset`. Without this, reverting a row after its predecessor had
 *     finished would leave it waiting for a completion that has already
 *     happened and will never happen again — the exact severing this replaces.
 *   - **Nothing precedes it** → scheduled now; it is the head of the chain.
 *
 * The due time is always recomputed from NOW. Reinstating the original would
 * fire instantly for a moment that has passed.
 */
export function planRevertToChain(elements, row, nowIso) {
  const list = Array.isArray(elements) ? elements : [];
  const predecessor = precedingTickableIndex(list, row.seq - 1);

  if (predecessor === -1) {
    return { id: row.id, state: "scheduled", due_at: nowIso, sent_at: null };
  }

  const el = list[predecessor];
  if (!el || !el.isCompleted) {
    return { id: row.id, state: "waiting", due_at: null, sent_at: null };
  }

  return {
    id: row.id,
    state: "scheduled",
    due_at: addMinutes(nowIso, row.offset_minutes),
    sent_at: null,
  };
}

/** Every restorable row handed back to the chain. */
export function planRestore(elements, rows, nowIso) {
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => RESTORABLE_STATES.has(r.state))
    .map((r) => planRevertToChain(elements, r, nowIso));
}

/**
 * Rows to re-time on resume.
 *
 * A due time that passed while the execution was paused is moved to now, so the
 * step fires shortly after resuming rather than immediately for a moment that
 * has gone by. A row still in the future keeps its due_at untouched.
 */
export function planResume(rows, nowIso) {
  const now = Date.parse(nowIso);
  return (Array.isArray(rows) ? rows : [])
    .filter((r) => r.state === "scheduled" && r.due_at && Date.parse(r.due_at) < now)
    .map((r) => ({ id: r.id, due_at: nowIso }));
}

/** ISO timestamp `minutes` after `nowIso`. Zero is legitimate and preserved. */
export function addMinutes(nowIso, minutes) {
  const base = Date.parse(nowIso);
  const delta = Number.isFinite(minutes) ? minutes : 0;
  return new Date(base + delta * 60000).toISOString();
}
