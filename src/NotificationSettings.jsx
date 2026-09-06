import React, { useState, useEffect, useCallback } from "react";
import { Bell, BellOff, RefreshCw } from "lucide-react";
import {
  getDeviceSubscriptionState,
  subscribeThisDevice,
  unsubscribeThisDevice,
  reconcilePushSubscription,
} from "./utils/pushSubscriptions";

/**
 * Notifications, in Settings.
 *
 * The only subscribe control used to live inside the Games tab diagnostic,
 * which is fine for the person who built it and invisible to everyone else.
 * Alfred is shared: a second user would have got a notification chain that
 * silently did nothing, with no control anywhere to explain or fix it.
 *
 * The diagnostic stays where it is. This is the same operations — both call the
 * shared helpers in utils/pushSubscriptions.js rather than owning a second copy
 * — with only what someone who is not debugging needs to see.
 *
 * "Device reachable" is the headline because it is the one line that answers
 * "will a notification actually arrive here?". Permission granted and a
 * subscription existing are both necessary and neither is sufficient: the
 * endpoint has to be in the table too.
 */

const VAPID_PUBLIC_KEY = process.env.REACT_APP_VAPID_PUBLIC_KEY || "";
const SW_URL = `${process.env.PUBLIC_URL || ""}/notify-sw.js`;

export default function NotificationSettings() {
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState(null);

  const refresh = useCallback(async () => {
    setState(await getDeviceSubscriptionState());
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (fn, successText) => {
    setBusy(true);
    setMessage(null);
    try {
      const result = await fn();
      setMessage(
        result.ok
          ? { tone: "good", text: successText }
          : { tone: "bad", text: result.error || "That did not work." }
      );
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  if (!state) {
    return (
      <div className="p-4 sm:p-6 bg-card border border-border rounded-lg">
        <p className="text-muted-foreground">Checking notifications…</p>
      </div>
    );
  }

  const denied = state.permission === "denied";
  const reachable = state.reachable;

  return (
    <div className="p-4 sm:p-6 bg-card border border-border rounded-lg space-y-4">
      <div className="flex items-start gap-3">
        {reachable ? (
          <Bell className="w-5 h-5 text-success shrink-0 mt-0.5" />
        ) : (
          <BellOff className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
        )}
        <div className="min-w-0">
          <h3 className="font-medium text-foreground">Notifications on this device</h3>
          <p
            className={`text-sm ${reachable ? "text-success" : "text-muted-foreground"}`}
          >
            {reachable
              ? "On — timed steps will reach this device and any paired watch."
              : "Off — timed steps will not be delivered here."}
          </p>
        </div>
      </div>

      {!state.supported && (
        <p className="text-sm text-destructive">
          This browser cannot receive push notifications. On iPhone, Alfred has
          to be added to the Home Screen first.
        </p>
      )}

      {denied && (
        <p className="text-sm text-destructive">
          Notifications are blocked for Alfred in this browser's settings.
          Turning them on here cannot override that — allow them for this site
          first, then come back.
        </p>
      )}

      {state.supported && !denied && (
        <div className="flex flex-wrap gap-2">
          {!reachable && (
            <button
              type="button"
              onClick={() =>
                run(
                  () => subscribeThisDevice(VAPID_PUBLIC_KEY, SW_URL),
                  "Notifications are on for this device."
                )
              }
              disabled={busy}
              className="px-4 py-2 min-h-[44px] rounded bg-primary text-white shadow-sm disabled:opacity-50"
            >
              Turn on notifications
            </button>
          )}

          {state.endpoint && (
            <button
              type="button"
              onClick={() =>
                run(
                  () => unsubscribeThisDevice(),
                  "Notifications are off for this device."
                )
              }
              disabled={busy}
              className="px-4 py-2 min-h-[44px] rounded bg-card border border-border text-foreground disabled:opacity-50"
            >
              Turn off
            </button>
          )}

          {/* Visible because the failure it repairs is invisible: the browser
              can hold a working subscription the table has never heard of, and
              nothing else on this screen would explain why nothing arrives. */}
          <button
            type="button"
            onClick={() =>
              run(async () => {
                const outcome = await reconcilePushSubscription();
                return { ok: true, outcome };
              }, "Checked and repaired if needed.")
            }
            disabled={busy}
            className="px-4 py-2 min-h-[44px] rounded bg-card border border-border text-muted-foreground disabled:opacity-50 flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            Repair
          </button>
        </div>
      )}

      {message && (
        <p
          className={`text-sm ${
            message.tone === "good" ? "text-success" : "text-destructive"
          }`}
        >
          {message.text}
        </p>
      )}

      {state.rows.length > 1 && (
        <p className="text-xs text-muted-foreground">
          {state.rows.length} devices are set up for notifications on this
          account.
        </p>
      )}
    </div>
  );
}
