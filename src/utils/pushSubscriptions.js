import { supabase } from "../supabaseClient";
import { readPendingRotation, clearPendingRotation } from "./pushRotation";

/**
 * Keeping `push_subscriptions` honest about what this browser actually holds.
 *
 * ── The failure this repairs ───────────────────────────────────────────────
 *
 * A push subscription can die while the stored row goes on looking healthy.
 * Observed in the field: an endpoint kept returning **201 from FCM and
 * delivered nothing**. There is no delivery receipt in Web Push, so 201 means
 * "the push service accepted this", never "the phone showed it" — and a dead
 * FCM registration can answer 201 indefinitely rather than the 404/410 that
 * would prune the row automatically.
 *
 * So the row cannot be trusted to fall out of the table on its own. The
 * browser's own `pushManager.getSubscription()` is the only authority on what
 * this device really has, and reconciling against it on app load is the
 * backstop for any rotation that happened while Alfred was closed.
 */

const TABLE = "push_subscriptions";

/**
 * Decide what to change, given what the browser holds and what is stored.
 *
 * Pure, so the decision can be tested without a database or a browser.
 *
 * @param {string|null} currentEndpoint  From pushManager.getSubscription().
 * @param {string[]}    storedEndpoints  This user's rows, all devices.
 * @param {object|null} pendingRotation  `{ oldEndpoint, newEndpoint }` recorded
 *                                       by the service worker, if any.
 * @returns {{ insert: boolean, deleteEndpoints: string[], reason: string }}
 */
export function planSubscriptionReconcile(
  currentEndpoint,
  storedEndpoints,
  pendingRotation
) {
  const stored = Array.isArray(storedEndpoints) ? storedEndpoints : [];
  const deleteEndpoints = [];

  // The worker told us exactly which row this device replaced. Only that one —
  // every other row belongs to a DIFFERENT DEVICE and must be left alone.
  // Deleting "everything that is not the current endpoint" would silently
  // unsubscribe the user's other phone.
  const rotatedFrom = pendingRotation && pendingRotation.oldEndpoint;
  if (rotatedFrom && rotatedFrom !== currentEndpoint && stored.includes(rotatedFrom)) {
    deleteEndpoints.push(rotatedFrom);
  }

  if (!currentEndpoint) {
    // This browser holds no subscription. That is the normal state for a
    // device that never subscribed, so nothing is inserted — but a recorded
    // rotation is still cleaned up.
    return {
      insert: false,
      deleteEndpoints,
      reason: deleteEndpoints.length
        ? "no local subscription; removing the endpoint it rotated away from"
        : "no local subscription, nothing to reconcile",
    };
  }

  const known = stored.includes(currentEndpoint);
  if (known && deleteEndpoints.length === 0) {
    return { insert: false, deleteEndpoints, reason: "already in sync" };
  }

  return {
    insert: !known,
    deleteEndpoints,
    reason: known
      ? "endpoint already stored; clearing the rotated-away row"
      : rotatedFrom
      ? "rotated: storing the new endpoint and removing the old"
      : "local subscription was missing from the table; storing it",
  };
}

/**
 * Reconcile this browser's subscription with the table.
 *
 * Deliberately does NOT register a service worker or create a subscription. It
 * only repairs what is already there, so a user who never enabled push is
 * untouched and app startup gains no side effects.
 *
 * @returns {Promise<object>} What was done, for the log. Never throws — a
 *          failed reconcile must not break app load.
 */
export async function reconcilePushSubscription() {
  const outcome = { ran: false, inserted: false, deleted: 0, reason: "" };

  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      outcome.reason = "no service worker support";
      return outcome;
    }

    // getRegistration, not register: this must never create a worker that was
    // not already there.
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.pushManager) {
      outcome.reason = "no service worker registration";
      return outcome;
    }

    const sub = await reg.pushManager.getSubscription();
    const pending = await readPendingRotation();

    if (!sub && !pending) {
      outcome.reason = "no local subscription, nothing to reconcile";
      return outcome;
    }

    const { data, error } = await supabase.from(TABLE).select("endpoint");
    if (error) {
      outcome.reason = `could not read subscriptions: ${error.message}`;
      return outcome;
    }

    const stored = (data || []).map((r) => r.endpoint);
    const plan = planSubscriptionReconcile(
      sub ? sub.endpoint : null,
      stored,
      pending
    );
    outcome.ran = true;
    outcome.reason = plan.reason;

    if (plan.insert && sub) {
      const json = sub.toJSON();
      const keys = json.keys || {};
      if (!keys.p256dh || !keys.auth) {
        outcome.reason = "local subscription has no keys; cannot store it";
        return outcome;
      }
      // Same upsert the subscribe button uses: on conflict of endpoint, so a
      // repeat is harmless. user_id is never sent — the column defaults to
      // auth.uid() and the owner policy decides the row.
      const { error: upsertError } = await supabase.from(TABLE).upsert(
        {
          endpoint: json.endpoint,
          p256dh: keys.p256dh,
          auth_key: keys.auth,
          user_agent: navigator.userAgent,
        },
        { onConflict: "endpoint" }
      );
      if (upsertError) {
        outcome.reason = `could not store the new endpoint: ${upsertError.message}`;
        return outcome;
      }
      outcome.inserted = true;
    }

    for (const endpoint of plan.deleteEndpoints) {
      const { error: delError } = await supabase
        .from(TABLE)
        .delete()
        .eq("endpoint", endpoint);
      if (!delError) outcome.deleted += 1;
    }

    // Only cleared once the swap has actually landed, so an interrupted
    // reconcile is retried on the next load rather than lost.
    if (pending && (outcome.inserted || outcome.deleted > 0)) {
      await clearPendingRotation();
    }

    return outcome;
  } catch (e) {
    outcome.reason = `reconcile threw: ${e && e.message ? e.message : String(e)}`;
    return outcome;
  }
}
