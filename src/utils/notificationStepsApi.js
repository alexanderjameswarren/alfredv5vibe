import { supabase } from "../supabaseClient";
import {
  expandNotificationSteps,
  planCompletion,
  planCancellation,
  planResume,
} from "./notificationSteps";

/**
 * notification_steps persistence. Phase 4.
 *
 * Thin: every decision lives in `notificationSteps.js`, which is pure. This
 * module only reads rows, applies the resulting patches, and swallows nothing
 * silently.
 *
 * ⚠ Rows are written in the DATABASE's spelling — `offset_minutes`, `due_at`,
 * `completed_at`. They go straight to PostgREST and never pass through
 * `storage.toSnakeCase`, so there is no camelCase layer here and none should be
 * added. This is the one part of Alfred where the snake_case names are the
 * working names.
 *
 * `user_id` is never sent: the column defaults to `auth.uid()` and the owner
 * policy decides the row, exactly as with `push_subscriptions`.
 *
 * Nothing here sends a notification. The dispatcher is Phase 5; these rows are
 * inert until it exists.
 */

const TABLE = "notification_steps";
const COLUMNS = "id, seq, text, offset_minutes, due_at, state, sent_at, completed_at";

/** Every row for one execution, oldest step first. */
export async function getNotificationSteps(executionId) {
  const { data, error } = await supabase
    .from(TABLE)
    .select(COLUMNS)
    .eq("execution_id", executionId)
    .order("seq", { ascending: true });

  if (error) throw new Error(`Failed to read notification steps: ${error.message}`);
  return data || [];
}

/**
 * Expand an execution's snapshot into rows, at start.
 *
 * Returns the rows created, which is [] for an item with no offsets anywhere —
 * the overwhelmingly common case, and not an error.
 */
export async function createNotificationSteps(executionId, elements, now = new Date()) {
  const rows = expandNotificationSteps(elements, now.toISOString());
  if (rows.length === 0) return [];

  const { data, error } = await supabase
    .from(TABLE)
    .insert(rows.map((r) => ({ ...r, execution_id: executionId })))
    .select(COLUMNS);

  if (error) throw new Error(`Failed to create notification steps: ${error.message}`);
  return data || [];
}

/**
 * Apply one patch. Patches carry an id and only the columns that change.
 *
 * ⚠ `.select("id")` is not decoration. A PostgREST UPDATE that RLS filters out
 * returns **zero rows and no error** — a denied write is otherwise
 * indistinguishable from a successful one, which is the silent failure this
 * whole feature keeps being bitten by. Asking for the affected row back is the
 * only way to tell them apart.
 */
async function applyPatch(patch) {
  const { id, ...fields } = patch;
  const { data, error } = await supabase
    .from(TABLE)
    .update(fields)
    .eq("id", id)
    .select("id");

  if (error) throw new Error(`notification step ${id}: ${error.message}`);
  if (!data || data.length === 0) {
    throw new Error(
      `notification step ${id}: update matched no rows. Either the row is gone, ` +
        `or RLS denied the write — check that its user_id still matches the ` +
        `signed-in user.`
    );
  }
}

/**
 * Apply a set of patches INDEPENDENTLY, not fail-fast.
 *
 * The patches in one call are unrelated writes — a tick closes the completed
 * element's row AND starts the next one's clock; a close cancels every
 * remaining row. In a plain `for … await` loop the first failure aborts the
 * rest, so one bad write silently takes out perfectly good ones and several
 * effects disappear together, which reads as "nothing happened" rather than as
 * one error.
 *
 * Everything that can land lands. Then, if anything failed, one error carrying
 * all of them is thrown.
 */
async function applyPatches(patches) {
  const failures = [];
  for (const patch of patches) {
    try {
      await applyPatch(patch);
    } catch (e) {
      failures.push({ id: patch.id, state: patch.state, message: e.message });
    }
  }

  if (failures.length > 0) {
    const err = new Error(
      `${failures.length} of ${patches.length} notification step update(s) failed: ` +
        failures.map((f) => f.message).join("; ")
    );
    err.failures = failures;
    err.applied = patches.length - failures.length;
    throw err;
  }
  return patches;
}

/**
 * Advance the chain for a completed element.
 *
 * Reads the rows first because the decision depends on their current states —
 * only a `waiting` row may be scheduled, which is what makes an un-tick and
 * re-tick idempotent rather than pushing a live due time further out each time.
 *
 * @returns {{complete: Array, schedule: Array}} What was applied.
 */
export async function completeNotificationStep(
  executionId,
  elements,
  completedIndex,
  now = new Date()
) {
  const rows = await getNotificationSteps(executionId);

  // `rowsSeen` is reported even on the empty path, so the caller can tell
  // "this execution has no chain" apart from "the rows exist but this client
  // cannot see them". From here those are identical, and in the field they
  // produced identical silence.
  if (rows.length === 0) {
    return { complete: [], schedule: [], rowsSeen: 0 };
  }

  const plan = planCompletion(elements, rows, completedIndex, now.toISOString());
  await applyPatches([...plan.complete, ...plan.schedule]);
  return { ...plan, rowsSeen: rows.length };
}

/** Cancel everything not already terminal. Called when an execution closes. */
export async function cancelNotificationSteps(executionId) {
  const rows = await getNotificationSteps(executionId);
  const patches = planCancellation(rows);
  await applyPatches(patches);
  return patches;
}

/**
 * Re-time rows whose due time passed during a pause.
 *
 * Pausing itself writes nothing: the dispatcher filters on the execution's
 * status, so a paused chain is already silent. This exists only so that
 * resuming does not fire a burst of notifications for moments that have gone by.
 */
export async function resumeNotificationSteps(executionId, now = new Date()) {
  const rows = await getNotificationSteps(executionId);
  const patches = planResume(rows, now.toISOString());
  await applyPatches(patches);
  return patches;
}

/* ── Per-run edits (Phase 6) ────────────────────────────────────────────────
 *
 * 🛑 These write to notification_steps ONLY. They never touch the item's
 * elements.
 *
 * The rows are copies taken at execution start, and that is the whole point: if
 * the same edit is being made on every run, the template is wrong and the ITEM
 * should be changed instead. An edit that wrote back would silently rewrite a
 * recipe because someone was running late once.
 */

/** Change one step's text, for this run only. */
export async function updateStepText(stepId, text) {
  await applyPatch({ id: stepId, text });
}

/**
 * Change one step's due time, for this run only.
 *
 * A step that had no due time — still `waiting` — becomes `scheduled`, because
 * giving it a time is what makes it eligible for the dispatcher. Setting a time
 * that has already passed is allowed: the dispatcher picks it up on the next
 * tick, which is what "send it now" means here.
 */
export async function updateStepDueAt(stepId, dueAtIso, currentState) {
  const patch = { id: stepId, due_at: dueAtIso };
  if (currentState === "waiting") patch.state = "scheduled";
  await applyPatch(patch);
}
