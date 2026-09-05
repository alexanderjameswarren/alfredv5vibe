import React, { useState, useRef, useEffect, useCallback } from "react";
import { supabase } from "../../supabaseClient";
import { reconcilePushSubscription } from "../../utils/pushSubscriptions";
import {
  writePendingRotation,
  rememberEndpoint,
  forgetEndpoint,
} from "../../utils/pushRotation";

// Push Notification Test — not a game, a diagnostic.
//
// It answers one question: does a notification raised by this app reach the
// phone, and does it mirror to the watch? It lives in the Games tab because
// that tab is the variant harness — one file, one registry entry, no edits
// anywhere else — and this needs exactly that and nothing more.
//
// Everything is in memory. Nothing is saved, nothing is sent, and the only
// lasting effect is the service worker registration, which is what is being
// tested.
//
// THE LOG IS THE POINT. This is tested on a phone with no DevTools, so a
// failure that only reaches the console is a failure that cannot be seen.
// Every call below is wrapped and every outcome — including success — is
// written to the screen.

// The notification under test. Fixed content: the question is delivery, not
// what it says.
const NOTIFICATION = {
  title: "Alfred",
  body: "Time for: squats",
  // A tag replaces a same-tagged notification rather than stacking, so two
  // taps of "Notify now" leave one notification and not two — which is itself
  // worth seeing on the watch.
  tag: "alfred-push-test",
  // Ignored by Android Chrome, which keeps notifications until dismissed
  // anyway, but correct on desktop and harmless here.
  requireInteraction: true,
};

// Already in public/ for the manifest; reused rather than adding an asset.
const ICON = `${process.env.PUBLIC_URL || ""}/android-chrome-192x192.png`;
const SW_URL = `${process.env.PUBLIC_URL || ""}/notify-sw.js`;

const DELAY_SECONDS = 10;

// Baked in at build time by CRA, which substitutes the literal text
// `process.env.REACT_APP_VAPID_PUBLIC_KEY` — so this cannot be read from a
// variable name and cannot change without a rebuild. A deploy that forgot the
// Vercel variable produces `undefined` here and a `subscribe` call that fails
// deep inside the browser with an unhelpful message, so it is checked up front
// and stated in the panel rather than discovered at the failure.
const VAPID_PUBLIC_KEY = process.env.REACT_APP_VAPID_PUBLIC_KEY || "";

const PUSH_TABLE = "push_subscriptions";

// Permission has no universal change event and the Permissions API is not
// everywhere, so the panel polls. A string comparison once a second costs
// nothing and is the only way the panel stays honest when permission is
// changed in Android's settings while the page is open.
const POLL_MS = 1000;

const hasNotification = () =>
  typeof window !== "undefined" && "Notification" in window;
const hasServiceWorker = () =>
  typeof navigator !== "undefined" && "serviceWorker" in navigator;
const currentPermission = () =>
  hasNotification() ? Notification.permission : "unavailable";

const messageOf = (err) => (err && err.message ? err.message : String(err));

// `applicationServerKey` will not take the base64url string the key is stored
// and transported as — it wants the raw 65 bytes. Passing the string through
// gets an InvalidCharacterError or an InvalidAccessError depending on the
// browser, neither of which mentions encoding.
//
// Two differences from plain base64: `-` and `_` stand in for `+` and `/`, and
// the `=` padding is stripped, so it goes back on before atob is given it.
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
  return output;
}

// PushManager is separate from both APIs above: a browser can have service
// workers and notifications and still not do push.
const hasPush = () => typeof window !== "undefined" && "PushManager" in window;

// The tail is enough to match a row in the dashboard by eye without putting a
// 200-character URL on a phone screen.
const endpointTail = (endpoint) =>
  endpoint ? `…${endpoint.slice(-20)}` : "none";

const stamp = () =>
  new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

// One row of the status panel. The value carries the colour, so a red line is
// findable at arm's length on a phone.
function StatusRow({ label, value, tone }) {
  const toneClass =
    tone === "good"
      ? "text-success"
      : tone === "bad"
      ? "text-destructive"
      : "text-muted-foreground";
  return (
    <div className="flex justify-between gap-3 text-sm py-1">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={`font-medium text-right ${toneClass}`}>{String(value)}</dd>
    </div>
  );
}

export default function NotifyTest() {
  const [permission, setPermission] = useState(currentPermission);
  const [registered, setRegistered] = useState(false);
  const [countdown, setCountdown] = useState(null);
  const [log, setLog] = useState([]);
  // The endpoint of the live subscription, or null. Held as a string rather
  // than the subscription object because that is what the panel shows and what
  // the table row is matched on; the object itself is fetched when needed.
  const [endpoint, setEndpoint] = useState(null);
  const [busy, setBusy] = useState(false);
  const [tableRows, setTableRows] = useState(null);
  const [staleRows, setStaleRows] = useState(null);
  // The actual rows, so each can be inspected and removed from the phone.
  const [subRows, setSubRows] = useState([]);
  const [liveEndpoint, setLiveEndpoint] = useState(null);

  // The registration is held in a ref, not state: it is the handle every
  // notification call needs, and re-rendering on it would say nothing that
  // `registered` does not already say.
  const regRef = useRef(null);
  const timeoutRef = useRef(null);
  const intervalRef = useRef(null);
  const logEndRef = useRef(null);
  // Cleared on unmount so a fired timer cannot log into a dead component.
  const liveRef = useRef(true);

  const append = useCallback((text, tone = "info") => {
    setLog((lines) => [
      ...lines,
      { id: `${Date.now()}-${lines.length}`, time: stamp(), text, tone },
    ]);
  }, []);

  // --- registration --------------------------------------------------------
  // Registering here rather than at app startup keeps this contained: no
  // worker exists until this screen is opened.
  useEffect(() => {
    liveRef.current = true;

    if (!hasNotification()) {
      append("This browser has no Notification API — nothing here can work.", "bad");
    }
    if (!hasServiceWorker()) {
      append("navigator.serviceWorker is missing — cannot register a worker.", "bad");
      return;
    }
    if (!hasPush()) {
      append("PushManager is missing — this browser cannot do Web Push.", "bad");
    }

    // Said on every mount, whether or not push is used, because "is the key in
    // this build?" is the first question of every failure and the answer is
    // otherwise invisible on a phone. The first 8 characters are enough to tell
    // one keypair from another without putting the whole key on screen.
    if (VAPID_PUBLIC_KEY) {
      append(
        `VAPID public key present: ${VAPID_PUBLIC_KEY.length} chars, starts "${VAPID_PUBLIC_KEY.slice(0, 8)}"`,
        "good"
      );
    } else {
      append(
        "REACT_APP_VAPID_PUBLIC_KEY is missing or empty in this build — push cannot be subscribed. Set it in Vercel and redeploy.",
        "bad"
      );
    }

    (async () => {
      try {
        append(`Registering service worker at ${SW_URL}…`);
        const reg = await navigator.serviceWorker.register(SW_URL);
        // `ready` resolves only once a worker is actually active, which is the
        // state showNotification needs. Registered is not the same as ready.
        const active = await navigator.serviceWorker.ready;
        if (!liveRef.current) return;
        regRef.current = active || reg;
        setRegistered(true);
        append(`Service worker active. Scope: ${(active || reg).scope}`, "good");

        // Report an existing subscription rather than assuming there is none:
        // a subscription outlives the page, so arriving here already
        // subscribed is the normal case on a second visit.
        const existing = await (active || reg).pushManager.getSubscription();
        if (!liveRef.current) return;
        if (existing) {
          setEndpoint(existing.endpoint);
          append(`Existing push subscription found: ${endpointTail(existing.endpoint)}`, "good");
        } else {
          append("No push subscription on this browser yet.");
        }
      } catch (err) {
        if (!liveRef.current) return;
        setRegistered(false);
        append(`Service worker registration failed: ${messageOf(err)}`, "bad");
      }
    })();
  }, [append]);

  // --- live status ---------------------------------------------------------
  useEffect(() => {
    const id = window.setInterval(() => {
      setPermission(currentPermission());
      setRegistered(Boolean(regRef.current && regRef.current.active));
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, []);

  // Leaving the screen disarms the delayed test — a notification from a screen
  // that is gone proves nothing about what was being watched.
  useEffect(
    () => () => {
      liveRef.current = false;
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      if (intervalRef.current) window.clearInterval(intervalRef.current);
    },
    []
  );

  // Keep the newest line in view without moving the page under a thumb.
  useEffect(() => {
    if (logEndRef.current && logEndRef.current.scrollIntoView) {
      logEndRef.current.scrollIntoView({ block: "nearest" });
    }
  }, [log]);

  // --- actions -------------------------------------------------------------
  const requestPermission = async () => {
    try {
      if (!hasNotification()) {
        append("Cannot request: no Notification API in this browser.", "bad");
        return;
      }
      append("Requesting permission…");
      const result = await Notification.requestPermission();
      setPermission(currentPermission());
      append(`Permission result: ${result}`, result === "granted" ? "good" : "bad");
      if (result === "default") {
        append("Dismissed without choosing — the prompt can be shown again.", "bad");
      }
    } catch (err) {
      append(`requestPermission threw: ${messageOf(err)}`, "bad");
    }
  };

  // The single path every notification takes. Deliberately never uses
  // `new Notification()`: that constructor throws on Android Chrome, which is
  // the entire reason there is a service worker here at all.
  const fire = async (label) => {
    try {
      if (!hasNotification()) throw new Error("No Notification API in this browser.");
      const permissionNow = currentPermission();
      if (permissionNow !== "granted") {
        throw new Error(`Permission is "${permissionNow}", not "granted".`);
      }
      const reg = regRef.current;
      if (!reg) throw new Error("No service worker registration — cannot show a notification.");
      if (!reg.showNotification) throw new Error("Registration has no showNotification method.");

      append(`${label}: calling registration.showNotification…`);
      await reg.showNotification(NOTIFICATION.title, {
        body: NOTIFICATION.body,
        tag: NOTIFICATION.tag,
        requireInteraction: NOTIFICATION.requireInteraction,
        icon: ICON,
        badge: ICON,
      });
      append(`${label}: showNotification resolved — the OS accepted it.`, "good");
    } catch (err) {
      append(`${label} failed: ${messageOf(err)}`, "bad");
    }
  };

  const notifyNow = () => {
    fire("Notify now");
  };

  const notifyLater = () => {
    try {
      if (countdown !== null) return;
      append(`Armed: notification in ${DELAY_SECONDS} seconds.`);
      setCountdown(DELAY_SECONDS);

      intervalRef.current = window.setInterval(() => {
        setCountdown((n) => (n === null || n <= 1 ? n : n - 1));
      }, 1000);

      timeoutRef.current = window.setTimeout(() => {
        if (intervalRef.current) window.clearInterval(intervalRef.current);
        intervalRef.current = null;
        timeoutRef.current = null;
        if (!liveRef.current) return;
        setCountdown(null);
        // Phones throttle background timers. If this line lands late, that is
        // a finding about the timer, not about notification delivery.
        fire(`Delayed (${DELAY_SECONDS}s)`);
      }, DELAY_SECONDS * 1000);
    } catch (err) {
      setCountdown(null);
      append(`Arming the delayed test threw: ${messageOf(err)}`, "bad");
    }
  };

  // --- push subscription ---------------------------------------------------
  // Subscribing is two writes that must both land: one to the browser's push
  // service, one to the table. The browser's happens first and outlives this
  // page, so if the row write fails the log says exactly that — a subscription
  // the server does not know about looks identical, from the phone, to no
  // subscription at all.
  const subscribeToPush = async () => {
    setBusy(true);
    try {
      if (!hasPush()) throw new Error("PushManager is missing — no Web Push in this browser.");
      if (!VAPID_PUBLIC_KEY) {
        throw new Error("No REACT_APP_VAPID_PUBLIC_KEY in this build — nothing to subscribe with.");
      }
      const reg = regRef.current;
      if (!reg) throw new Error("No service worker registration yet.");
      if (currentPermission() !== "granted") {
        throw new Error(`Permission is "${currentPermission()}" — grant it before subscribing.`);
      }

      append("Converting VAPID key and calling pushManager.subscribe…");
      const sub = await reg.pushManager.subscribe({
        // Required by Chrome. It is the promise that every push becomes a
        // visible notification, which the worker's push handler keeps.
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      setEndpoint(sub.endpoint);
      append(`Subscribed. Endpoint: ${endpointTail(sub.endpoint)}`, "good");

      // toJSON() is the documented way to read the keys out; the subscription
      // object itself exposes them only as ArrayBuffers via getKey().
      const json = sub.toJSON();
      const keys = json.keys || {};
      if (!keys.p256dh || !keys.auth) {
        throw new Error("Subscription came back without p256dh/auth keys — cannot store it.");
      }

      append("Upserting row into push_subscriptions…");
      // No user_id: the column defaults to auth.uid() and the owner policy
      // decides the row. Sending one from the client would either be ignored
      // or rejected, and would misrepresent where the truth lives.
      const { error } = await supabase.from(PUSH_TABLE).upsert(
        {
          endpoint: json.endpoint,
          p256dh: keys.p256dh,
          auth_key: keys.auth,
          user_agent: navigator.userAgent,
          // last_used_at is deliberately not sent. On conflict only the
          // columns named here are written, so re-subscribing on this device
          // leaves the send history intact — and step 2 owns that column.
        },
        { onConflict: "endpoint" }
      );
      if (error) throw new Error(`Row upsert failed: ${error.message}`);
      append("Row saved. Push subscription is registered server-side.", "good");
    } catch (err) {
      append(`Subscribe failed: ${messageOf(err)}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  // Unsubscribing is the same two writes in reverse. The row is deleted even
  // if the browser call fails, and vice versa — a half-removed subscription is
  // worse than either end being cleaned up alone, so neither failure is
  // allowed to skip the other.
  const unsubscribeFromPush = async () => {
    setBusy(true);
    try {
      const reg = regRef.current;
      if (!reg) throw new Error("No service worker registration yet.");
      const sub = await reg.pushManager.getSubscription();
      if (!sub) {
        append("Nothing to unsubscribe — no subscription on this browser.", "bad");
        setEndpoint(null);
        return;
      }

      const deadEndpoint = sub.endpoint;
      append(`Unsubscribing ${endpointTail(deadEndpoint)}…`);

      let browserError = null;
      try {
        const gone = await sub.unsubscribe();
        append(
          gone ? "Browser subscription cancelled." : "Browser reported nothing to cancel.",
          gone ? "good" : "bad"
        );
      } catch (err) {
        browserError = err;
        append(`unsubscribe() threw: ${messageOf(err)} — still removing the row.`, "bad");
      }

      const { error } = await supabase.from(PUSH_TABLE).delete().eq("endpoint", deadEndpoint);
      if (error) {
        append(`Row delete failed: ${error.message}`, "bad");
      } else {
        append("Row deleted from push_subscriptions.", "good");
      }

      setEndpoint(null);
      if (browserError) throw browserError;
    } catch (err) {
      append(`Unsubscribe finished with an error: ${messageOf(err)}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  // Ask the edge function to push to every device this account has subscribed.
  // Unlike the two buttons above, nothing here touches the local notification
  // API at all: the round trip is browser → function → push service → the
  // worker's `push` handler, which is why this is the one that still works
  // with Alfred closed.
  const sendPush = async () => {
    setBusy(true);
    try {
      append("Invoking push-send…");
      // invoke() attaches the session's access token, which is what the
      // function's JWT verification checks and what scopes its query by RLS.
      const { data, error } = await supabase.functions.invoke("push-send", { body: {} });

      if (error) {
        // A non-2xx arrives as an error whose real explanation is in the
        // response body, not in error.message — which is a generic
        // "non-2xx status code". Unwrapping it is the difference between a
        // diagnosable failure and a useless one.
        let detail = "";
        try {
          if (error.context && typeof error.context.json === "function") {
            detail = JSON.stringify(await error.context.json());
          }
        } catch {
          /* body was not JSON; the message below still says something */
        }
        append(`push-send failed: ${messageOf(error)}${detail ? ` — ${detail}` : ""}`, "bad");
        return;
      }

      // The whole envelope, not a summary: per-endpoint status codes are the
      // reason it returns them, and this is read on a phone.
      append(`push-send response: ${JSON.stringify(data)}`, data && data.sent > 0 ? "good" : "bad");

      if (data && data.removed > 0) {
        // A dead row usually means this device's own subscription expired.
        append("A dead subscription was removed — re-subscribe on this device.", "bad");
        setEndpoint(null);
      }
    } catch (err) {
      append(`Send push threw: ${messageOf(err)}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  // Read the table and say, on screen, exactly what is in it.
  //
  // This is the only way to see a stale row from a phone. Without it, "reconcile
  // says already in sync" and "there is a dead row still being sent to" look
  // identical — which is how the first version of this passed while leaving a
  // dead row behind.
  const reportTableState = useCallback(async () => {
    try {
      const { data, error } = await supabase
        .from(PUSH_TABLE)
        .select("endpoint, user_agent, created_at, last_used_at")
        .order("created_at", { ascending: true });
      if (error) throw new Error(error.message);

      const rows = data || [];
      setTableRows(rows.length);
      const reg = regRef.current;
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      const live = sub ? sub.endpoint : null;
      const others = rows.filter((r) => r.endpoint !== live);
      setSubRows(rows);
      setLiveEndpoint(live);

      append(`Table now holds ${rows.length} subscription row(s) for this account.`);
      for (const row of rows) {
        const isLive = row.endpoint === live;
        append(
          `  ${endpointTail(row.endpoint)} — ${isLive ? "THIS DEVICE (live)" : "not this device's current endpoint"}`,
          isLive ? "good" : "bad"
        );
      }
      if (others.length > 0) {
        append(
          `${others.length} row(s) are not this browser's live endpoint. If any belongs ` +
            `to another device that is correct; if it is this device's old one, reconcile removes it.`
        );
      }
      setStaleRows(others.length);
    } catch (err) {
      append(`Could not read the table: ${messageOf(err)}`, "bad");
    }
  }, [append]);

  // Remove one row the user has looked at and judged dead.
  //
  // The reconciler will never do this on its own: it deletes only rows it can
  // PROVE this browser created, because a wrong guess silently unsubscribes
  // another device. A row that predates the endpoint ledger cannot be proved
  // either way — so the decision is handed to a person who can see the list,
  // which is also the only way to do it from a phone.
  const removeRow = async (row) => {
    const tail = endpointTail(row.endpoint);
    if (row.endpoint === liveEndpoint) {
      append(`Refusing to remove ${tail} — it is this device's LIVE endpoint.`, "bad");
      return;
    }
    // eslint-disable-next-line no-restricted-globals
    const ok = window.confirm(
      `Remove the subscription ending ${tail}?

` +
        `If this belongs to another device, that device stops receiving ` +
        `notifications until it is re-subscribed.`
    );
    if (!ok) {
      append(`Cancelled — ${tail} left in place.`);
      return;
    }
    setBusy(true);
    try {
      const { error } = await supabase
        .from(PUSH_TABLE)
        .delete()
        .eq("endpoint", row.endpoint)
        .select("endpoint");
      if (error) throw new Error(error.message);
      forgetEndpoint(row.endpoint);
      append(`Removed ${tail} from the table.`, "good");
      await reportTableState();
    } catch (err) {
      append(`Could not remove ${tail}: ${messageOf(err)}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  // --- Rotation drill (Phase 5c) -------------------------------------------
  //
  // Chrome rotates a subscription on its own schedule, which is no use for
  // verifying that rotation is detected and repaired. This forces the exact
  // state a rotation leaves behind — the browser holding a NEW endpoint while
  // the table still holds the OLD one — without waiting for Chrome and without
  // touching the table, so the reconciler has something real to find.
  //
  // It deliberately does NOT clean up after itself. The whole point is to walk
  // away with the table stale and see whether "Reconcile now" repairs it.
  const simulateRotation = async () => {
    setBusy(true);
    try {
      const reg = regRef.current;
      if (!reg) throw new Error("No service worker registration yet.");
      const before = await reg.pushManager.getSubscription();
      if (!before) throw new Error("Nothing to rotate — subscribe first.");

      const staleEndpoint = before.endpoint;
      append(`Rotation drill. Old endpoint ${endpointTail(staleEndpoint)}`);

      // The ledger is what a real rotation would already have: proof that THIS
      // browser put the old endpoint in the table. Recorded before unsubscribing
      // so the drill cannot pass while the delete path is untested.
      rememberEndpoint(staleEndpoint);

      append("Unsubscribing in the browser, leaving the table untouched…");
      await before.unsubscribe();

      const after = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
      });
      setEndpoint(after.endpoint);
      append(`New endpoint ${endpointTail(after.endpoint)}`, "good");

      // Also write the IndexedDB record the service worker would have written,
      // so the drill exercises BOTH proofs of ownership rather than only the
      // ledger.
      const wrote = await writePendingRotation({
        oldEndpoint: staleEndpoint,
        newEndpoint: after.endpoint,
        at: new Date().toISOString(),
      });
      append(
        wrote
          ? "Wrote the same rotation record the service worker writes."
          : "Could not write the rotation record; the ledger still covers it.",
        wrote ? "info" : "bad"
      );

      append(
        `Table is now STALE. It still holds ${endpointTail(staleEndpoint)}, ` +
          `which is dead but will answer 201. Press "Reconcile now" — expect ` +
          `1 stored and 1 removed.`,
        "bad"
      );
    } catch (err) {
      append(`Rotation drill failed: ${messageOf(err)}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  // The same function the app runs on load. Exposed so a repair can be
  // observed on demand rather than inferred from a page refresh.
  const reconcileNow = async () => {
    setBusy(true);
    try {
      append("Reconciling this browser's subscription against the table…");
      const outcome = await reconcilePushSubscription();
      append(
        `Reconcile result: ${outcome.reason}.`,
        outcome.inserted || outcome.deleted > 0 ? "good" : "info"
      );
      append(
        `Stored this device's endpoint: ${outcome.inserted ? "yes" : "no"}. ` +
          `Stale rows removed: ${outcome.deleted}.`,
        outcome.deleted > 0 ? "good" : "info"
      );
      await reportTableState();
    } catch (err) {
      append(`Reconcile failed: ${messageOf(err)}`, "bad");
    } finally {
      setBusy(false);
    }
  };

  const permissionSettled = permission === "granted" || permission === "denied";
  const armed = countdown !== null;

  return (
    <div className="space-y-4">
      {/* 1 — what this browser can actually do, live */}
      <div className="bg-card border border-border rounded-lg p-4">
        <h3 className="font-medium text-foreground mb-2">Status</h3>
        <dl className="divide-y divide-border">
          <StatusRow
            label="Notification API"
            value={hasNotification() ? "present" : "missing"}
            tone={hasNotification() ? "good" : "bad"}
          />
          <StatusRow
            label="navigator.serviceWorker"
            value={hasServiceWorker() ? "present" : "missing"}
            tone={hasServiceWorker() ? "good" : "bad"}
          />
          <StatusRow
            label="Notification.permission"
            value={permission}
            tone={
              permission === "granted"
                ? "good"
                : permission === "denied"
                ? "bad"
                : "neutral"
            }
          />
          <StatusRow
            label="Worker registration"
            value={registered ? "active" : "none"}
            tone={registered ? "good" : "bad"}
          />
          <StatusRow
            label="PushManager"
            value={hasPush() ? "present" : "missing"}
            tone={hasPush() ? "good" : "bad"}
          />
          <StatusRow
            label="VAPID key in build"
            value={VAPID_PUBLIC_KEY ? `${VAPID_PUBLIC_KEY.length} chars` : "MISSING"}
            tone={VAPID_PUBLIC_KEY ? "good" : "bad"}
          />
          <StatusRow
            label="Push subscription"
            value={endpoint ? "active" : "none"}
            tone={endpoint ? "good" : "neutral"}
          />
          <StatusRow
            label="Endpoint tail"
            value={endpointTail(endpoint)}
            tone={endpoint ? "good" : "neutral"}
          />
          <StatusRow
            label="Rows in table"
            value={tableRows === null ? "not checked" : tableRows}
            tone="neutral"
          />
          <StatusRow
            label="Rows not this device"
            value={staleRows === null ? "not checked" : staleRows}
            tone={staleRows > 0 ? "bad" : staleRows === 0 ? "good" : "neutral"}
          />
        </dl>
      </div>

      {/* 2 — permission */}
      <button
        type="button"
        onClick={requestPermission}
        disabled={permissionSettled}
        className="w-full px-4 py-2 min-h-[44px] rounded bg-primary text-white shadow-sm disabled:opacity-50"
      >
        {permission === "granted"
          ? "Permission granted"
          : permission === "denied"
          ? "Permission denied — change it in browser settings"
          : "Request permission"}
      </button>

      {/* 3 and 4 — the two tests */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={notifyNow}
          className="flex-1 px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground"
        >
          Notify now
        </button>
        <button
          type="button"
          onClick={notifyLater}
          disabled={armed}
          className="flex-1 px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground disabled:opacity-50"
        >
          {armed ? `Firing in ${countdown}s…` : `Notify in ${DELAY_SECONDS} seconds`}
        </button>
      </div>

      {armed && (
        <p className="text-sm text-center text-muted-foreground">
          Armed — lock the phone now to test delivery from the background.
        </p>
      )}

      {/* Web Push — the part that survives Alfred being closed. Separated
          from the two local tests above because it is a different mechanism
          with a different failure surface, not a third button of the same. */}
      <div className="pt-2 border-t border-border">
        <h3 className="font-medium text-foreground mb-2">Web Push</h3>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={subscribeToPush}
            disabled={busy || Boolean(endpoint)}
            className="flex-1 px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground disabled:opacity-50"
          >
            {endpoint ? "Subscribed" : "Subscribe to push"}
          </button>
          <button
            type="button"
            onClick={unsubscribeFromPush}
            disabled={busy || !endpoint}
            className="flex-1 px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground disabled:opacity-50"
          >
            Unsubscribe
          </button>
        </div>

        <button
          type="button"
          onClick={sendPush}
          disabled={busy}
          className="w-full mt-2 px-4 py-2 min-h-[44px] rounded bg-primary text-white shadow-sm disabled:opacity-50"
        >
          Send push now
        </button>
        <p className="mt-2 text-sm text-muted-foreground">
          Sends to every subscribed device on this account — this is the one
          that works with Alfred closed.
        </p>

        <button
          type="button"
          onClick={() => reportTableState()}
          disabled={busy}
          className="w-full mt-2 px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground disabled:opacity-50"
        >
          Show table rows
        </button>

        {subRows.length > 0 && (
          <div className="mt-3 space-y-2">
            {subRows.map((row) => {
              const isLive = row.endpoint === liveEndpoint;
              return (
                <div
                  key={row.endpoint}
                  className="flex items-center justify-between gap-2 p-2 bg-card border border-border rounded"
                >
                  <div className="min-w-0">
                    <span
                      className={`block text-xs font-mono break-all ${
                        isLive ? "text-success" : "text-destructive"
                      }`}
                    >
                      {endpointTail(row.endpoint)}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {isLive ? "this device (live)" : "not this device's live endpoint"}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => removeRow(row)}
                    disabled={busy || isLive}
                    className="px-3 py-2 min-h-[44px] rounded border border-border text-sm text-destructive disabled:opacity-30 shrink-0"
                  >
                    Remove
                  </button>
                </div>
              );
            })}
          </div>
        )}

        <div className="flex gap-2 mt-3 pt-3 border-t border-border">
          <button
            type="button"
            onClick={simulateRotation}
            disabled={busy || !endpoint}
            className="flex-1 px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground disabled:opacity-50"
          >
            Simulate rotation
          </button>
          <button
            type="button"
            onClick={reconcileNow}
            disabled={busy}
            className="flex-1 px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground disabled:opacity-50"
          >
            Reconcile now
          </button>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          A rotation leaves the table pointing at a dead endpoint that still
          answers 201. The drill reproduces that exactly — including the
          ownership record a real rotation leaves — so reconcile is tested on
          both storing the new row and removing the old one.
        </p>
      </div>

      {/* 5 — the log, which is the only debugging surface on a phone */}
      <div>
        <h3 className="font-medium text-foreground mb-2">Log</h3>
        <div className="bg-card border border-border rounded-lg p-3 max-h-72 overflow-y-auto">
          {log.length === 0 ? (
            <p className="text-sm text-muted-foreground">Nothing yet.</p>
          ) : (
            <ul className="space-y-1">
              {log.map((line) => (
                <li
                  key={line.id}
                  className={`text-xs font-mono break-words ${
                    line.tone === "bad"
                      ? "text-destructive"
                      : line.tone === "good"
                      ? "text-success"
                      : "text-foreground"
                  }`}
                >
                  <span className="text-muted-foreground">{line.time}</span>{" "}
                  {line.text}
                </li>
              ))}
            </ul>
          )}
          <div ref={logEndRef} />
        </div>
      </div>
    </div>
  );
}
