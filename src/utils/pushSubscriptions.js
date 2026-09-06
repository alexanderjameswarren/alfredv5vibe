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

/* ── Subscribing this device ────────────────────────────────────────────────
 *
 * Extracted so Settings and the Games diagnostic share ONE implementation.
 * They are two surfaces onto the same operation, and a second copy of "convert
 * the key, subscribe, upsert the row" is exactly the kind of duplication that
 * has already cost this project twice.
 */

/**
 * `applicationServerKey` will not take the base64url string the VAPID key is
 * stored and transported as — it wants the raw bytes. Passing the string gets
 * an InvalidCharacterError or an InvalidAccessError depending on the browser,
 * neither of which mentions encoding.
 *
 * Two differences from plain base64: `-` and `_` stand in for `+` and `/`, and
 * the `=` padding is stripped, so it goes back on before atob sees it.
 */
export function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

/** What this browser holds, and whether the table agrees. */
export async function getDeviceSubscriptionState() {
  const state = {
    supported: false,
    permission: "unavailable",
    endpoint: null,
    rows: [],
    reachable: false,
  };
  try {
    state.supported =
      typeof navigator !== "undefined" &&
      "serviceWorker" in navigator &&
      typeof window !== "undefined" &&
      "PushManager" in window &&
      "Notification" in window;
    if (typeof window !== "undefined" && "Notification" in window) {
      state.permission = Notification.permission;
    }
    if (!state.supported) return state;

    const reg = await navigator.serviceWorker.getRegistration();
    if (reg && reg.pushManager) {
      const sub = await reg.pushManager.getSubscription();
      state.endpoint = sub ? sub.endpoint : null;
    }

    const { data } = await supabase.from(TABLE).select("endpoint, user_agent, created_at");
    state.rows = data || [];
    // The single fact that decides whether a notification can arrive: is the
    // endpoint this browser actually holds present in the table?
    state.reachable =
      Boolean(state.endpoint) && state.rows.some((r) => r.endpoint === state.endpoint);
  } catch {
    /* leave the defaults; the caller renders "unknown" rather than crashing */
  }
  return state;
}

/**
 * Subscribe this device and store the row.
 *
 * Registers the worker if it is not already there — unlike the reconciler,
 * which must never create one. This is an explicit user action, so creating
 * what it needs is the point.
 *
 * @returns {Promise<{ok: boolean, endpoint?: string, error?: string}>}
 */
export async function subscribeThisDevice(vapidPublicKey, swUrl) {
  try {
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
      return { ok: false, error: "This browser has no service worker support." };
    }
    if (!("PushManager" in window)) {
      return { ok: false, error: "This browser cannot do Web Push." };
    }
    if (!vapidPublicKey) {
      return {
        ok: false,
        error:
          "No REACT_APP_VAPID_PUBLIC_KEY in this build — set it in Vercel and redeploy.",
      };
    }

    const permission = await Notification.requestPermission();
    if (permission !== "granted") {
      return { ok: false, error: `Notification permission is "${permission}".` };
    }

    await navigator.serviceWorker.register(swUrl);
    const reg = await navigator.serviceWorker.ready;

    const existing = await reg.pushManager.getSubscription();
    const sub =
      existing ||
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey),
      }));

    const json = sub.toJSON();
    const keys = json.keys || {};
    if (!keys.p256dh || !keys.auth) {
      return { ok: false, error: "The subscription came back without its keys." };
    }

    const { error } = await supabase.from(TABLE).upsert(
      {
        endpoint: json.endpoint,
        p256dh: keys.p256dh,
        auth_key: keys.auth,
        user_agent: navigator.userAgent,
      },
      { onConflict: "endpoint" }
    );
    if (error) return { ok: false, error: `Could not store the subscription: ${error.message}` };

    // Ownership proof for the next rotation. Without it, a future rotation
    // cannot be reaped and leaves a dead row answering 201.
    rememberEndpoint(json.endpoint);
    return { ok: true, endpoint: json.endpoint };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/**
 * Unsubscribe this device and remove its row.
 *
 * Both halves are attempted even if one fails: a subscription cleaned up at
 * only one end is worse than either failure alone.
 */
export async function unsubscribeThisDevice() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && reg.pushManager ? await reg.pushManager.getSubscription() : null;
    if (!sub) return { ok: false, error: "Nothing to unsubscribe on this device." };

    const endpoint = sub.endpoint;
    let browserError = null;
    try {
      await sub.unsubscribe();
    } catch (e) {
      browserError = e && e.message ? e.message : String(e);
    }

    const { error } = await supabase.from(TABLE).delete().eq("endpoint", endpoint);
    forgetEndpoint(endpoint);

    if (error) return { ok: false, error: `Row not removed: ${error.message}` };
    if (browserError) return { ok: false, error: `Row removed, but: ${browserError}` };
    return { ok: true, endpoint };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}
