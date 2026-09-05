import { supabase } from "../supabaseClient";
import {
  readPendingRotation,
  clearPendingRotation,
  readKnownEndpoints,
  rememberEndpoint,
  forgetEndpoint,
} from "./pushRotation";

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
  pendingRotation,
  knownEndpoints
) {
  const stored = Array.isArray(storedEndpoints) ? storedEndpoints : [];
  const known = Array.isArray(knownEndpoints) ? knownEndpoints : [];
  const deleteEndpoints = [];

  // ── What may be deleted, and why it is safe ──────────────────────────────
  //
  // Only rows this browser can PROVE it created. Every other row belongs to a
  // DIFFERENT DEVICE, and "delete everything that is not the current endpoint"
  // would silently unsubscribe the user's other phone.
  //
  // Two independent proofs of ownership, because neither covers every case:
  //
  //   1. The worker's rotation record — precise, but only exists if the worker
  //      ran and IndexedDB was available.
  //   2. The local endpoint ledger — every endpoint THIS browser put in the
  //      table. Durable, and the only thing that covers a rotation which
  //      happened before any of this shipped.
  //
  // Neither can name another device's endpoint, which is the safety property.
  const candidates = new Set();

  const rotatedFrom = pendingRotation && pendingRotation.oldEndpoint;
  if (rotatedFrom) candidates.add(rotatedFrom);
  for (const endpoint of known) candidates.add(endpoint);

  for (const endpoint of candidates) {
    // Never the live one, and only rows that are actually there.
    if (!endpoint || endpoint === currentEndpoint) continue;
    if (!stored.includes(endpoint)) continue;
    deleteEndpoints.push(endpoint);
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

  const alreadyStored = stored.includes(currentEndpoint);
  if (alreadyStored && deleteEndpoints.length === 0) {
    return {
      insert: false,
      deleteEndpoints,
      reason: "already in sync — this device's endpoint is stored and no stale rows of its own remain",
    };
  }

  return {
    insert: !alreadyStored,
    deleteEndpoints,
    reason: alreadyStored
      ? `this device's endpoint is stored; removing ${deleteEndpoints.length} stale row(s) it left behind`
      : deleteEndpoints.length
      ? `rotated: storing this device's new endpoint and removing ${deleteEndpoints.length} stale row(s)`
      : "this device's endpoint was missing from the table; storing it",
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
  const outcome = {
    ran: false,
    inserted: false,
    deleted: 0,
    rowsInTable: null,
    reason: "",
  };

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
      pending,
      readKnownEndpoints()
    );
    outcome.ran = true;
    outcome.reason = plan.reason;
    outcome.rowsInTable = stored.length;

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

    // Remember the live endpoint whether or not it was just inserted. Without
    // this, a browser that is already in sync never records what it holds — so
    // when that endpoint later rotates there is no proof of ownership and the
    // dead row cannot be reaped. Recording it now is what makes the NEXT
    // rotation self-healing.
    if (sub) rememberEndpoint(sub.endpoint);

    for (const endpoint of plan.deleteEndpoints) {
      const { error: delError } = await supabase
        .from(TABLE)
        .delete()
        .eq("endpoint", endpoint);
      if (delError) {
        outcome.reason += ` (failed to remove one stale row: ${delError.message})`;
        continue;
      }
      outcome.deleted += 1;
      forgetEndpoint(endpoint);
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
