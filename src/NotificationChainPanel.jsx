import React, { useState, useEffect, useCallback } from "react";
import { Bell, BellOff, X, Check, Clock } from "lucide-react";
import AppLink from "./AppLink";
import { VIEW_TO_PATH } from "./viewPaths";
import {
  getNotificationSteps,
  cancelNotificationSteps,
  updateStepText,
  updateStepDueAt,
} from "./utils/notificationStepsApi";
import { getDeviceSubscriptionState } from "./utils/pushSubscriptions";

/**
 * The timed-step queue for one execution.
 *
 * Self-fetching, so ExecutionDetailView gains one line rather than a set of
 * props threaded down from Alfred. Renders nothing at all when the execution
 * has no chain, which is the overwhelmingly common case.
 *
 * 🛑 Every edit here writes to the notification_steps row for THIS RUN and
 * never back to the item's elements. The rows are copies taken at execution
 * start. If the same edit is needed on every run, the template is wrong and the
 * item should be changed — silently rewriting a recipe because someone was late
 * once is the failure this rule prevents.
 */

const STATE_LABEL = {
  waiting: "waiting for the step before it",
  scheduled: "scheduled",
  sent: "notification sent",
  done: "done",
  skipped: "skipped",
  cancelled: "cancelled",
  no_subscription: "not sent — no device was subscribed",
};

const TERMINAL = new Set(["done", "skipped", "cancelled"]);

/** "14:05 today", "14:05 on 6 Sep" — short enough for a phone. */
function formatDue(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? `${time} today`
    : `${time} on ${d.toLocaleDateString([], { day: "numeric", month: "short" })}`;
}

/** An ISO string as the value a datetime-local input wants, in LOCAL time. */
function toLocalInputValue(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  // toISOString would convert to UTC and show the wrong wall-clock time in any
  // zone but Greenwich — the same trap parseLocalDate exists for elsewhere.
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

export default function NotificationChainPanel({ executionId, executionStatus }) {
  const [steps, setSteps] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(null); // { id, text, dueAt }
  const [reachable, setReachable] = useState(null);

  const load = useCallback(async () => {
    try {
      setSteps(await getNotificationSteps(executionId));
      setError(null);
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
      setSteps([]);
    }
  }, [executionId]);

  useEffect(() => {
    load();
  }, [load]);

  // Only asked once there is a chain to warn about — a user who never uses
  // timed steps should not have their subscription state queried at all.
  useEffect(() => {
    if (!steps || steps.length === 0) return;
    let cancelled = false;
    getDeviceSubscriptionState().then((s) => {
      if (!cancelled) setReachable(s.reachable);
    });
    return () => {
      cancelled = true;
    };
  }, [steps]);

  if (steps === null) return null;
  if (steps.length === 0 && !error) return null;

  const live = steps.filter((s) => !TERMINAL.has(s.state));

  const withBusy = async (fn) => {
    setBusy(true);
    try {
      await fn();
      await load();
    } catch (e) {
      setError(e && e.message ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const cancelChain = () => {
    // eslint-disable-next-line no-restricted-globals
    const ok = window.confirm(
      `Cancel the remaining ${live.length} timed step(s)?\n\n` +
        `No more notifications will be sent for this run. The steps themselves ` +
        `stay on the list and can still be ticked.`
    );
    if (!ok) return;
    withBusy(() => cancelNotificationSteps(executionId));
  };

  const saveEdit = () =>
    withBusy(async () => {
      const step = steps.find((s) => s.id === editing.id);
      if (editing.text !== step.text) await updateStepText(editing.id, editing.text);
      if (editing.dueAt) {
        const iso = new Date(editing.dueAt).toISOString();
        if (iso !== step.due_at) await updateStepDueAt(editing.id, iso, step.state);
      }
      setEditing(null);
    });

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between gap-3 mb-2">
        <h3 className="font-medium text-foreground flex items-center gap-2">
          <Clock className="w-4 h-4 text-muted-foreground" />
          Timed steps
        </h3>
        {live.length > 0 && executionStatus !== "closed" && (
          <button
            type="button"
            onClick={cancelChain}
            disabled={busy}
            className="px-3 py-2 min-h-[44px] rounded border border-border text-sm text-destructive disabled:opacity-50"
          >
            Cancel remaining
          </button>
        )}
      </div>

      {error && <p className="text-sm text-destructive mb-2">{error}</p>}

      {/* The warning that stops a shared Alfred from silently doing nothing.
          Shown only when there IS a chain and this device cannot receive it. */}
      {reachable === false && live.length > 0 && (
        <div className="mb-3 p-3 rounded border border-destructive bg-destructive-light/40">
          <p className="text-sm text-destructive flex items-start gap-2">
            <BellOff className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Notifications for this execution won't be delivered on this
              device.{" "}
              <AppLink
                to={VIEW_TO_PATH.settings}
                className="underline font-medium"
              >
                Enable them in Settings
              </AppLink>
              .
            </span>
          </p>
        </div>
      )}

      {reachable === true && live.length > 0 && (
        <p className="text-sm text-success flex items-center gap-2 mb-2">
          <Bell className="w-4 h-4" />
          {live.length} notification{live.length === 1 ? "" : "s"} still to come
          on this device.
        </p>
      )}

      <ul className="space-y-2">
        {steps.map((step) => {
          const due = formatDue(step.due_at);
          const isEditing = editing && editing.id === step.id;
          const terminal = TERMINAL.has(step.state);

          if (isEditing) {
            return (
              <li key={step.id} className="p-3 bg-card border border-primary rounded-lg space-y-2">
                <input
                  type="text"
                  value={editing.text}
                  onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                  className="w-full px-3 py-2 border border-border rounded text-base"
                  placeholder="What the notification says"
                />
                <label className="block text-sm text-muted-foreground">
                  Send at
                  <input
                    type="datetime-local"
                    value={editing.dueAt}
                    onChange={(e) => setEditing({ ...editing, dueAt: e.target.value })}
                    className="mt-1 w-full px-3 py-2 border border-border rounded text-base"
                  />
                </label>
                <p className="text-xs text-muted-foreground">
                  Changes apply to this run only. The item is not modified.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={saveEdit}
                    disabled={busy}
                    className="flex-1 px-4 py-2 min-h-[44px] rounded bg-primary text-white disabled:opacity-50"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    className="px-4 py-2 min-h-[44px] rounded bg-card border border-border"
                  >
                    Cancel
                  </button>
                </div>
              </li>
            );
          }

          return (
            <li
              key={step.id}
              className="p-3 bg-card border border-border rounded-lg flex items-start justify-between gap-3"
            >
              <div className="min-w-0">
                <span
                  className={`block ${
                    terminal ? "text-muted-foreground line-through" : "text-foreground"
                  }`}
                >
                  {step.text}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {STATE_LABEL[step.state] || step.state}
                  {due ? ` · ${due}` : ""}
                  {step.state === "waiting"
                    ? ` · then +${step.offset_minutes} min`
                    : ""}
                </span>
              </div>
              {step.state === "done" ? (
                <Check className="w-4 h-4 text-success shrink-0 mt-1" />
              ) : step.state === "cancelled" ? (
                <X className="w-4 h-4 text-muted-foreground shrink-0 mt-1" />
              ) : (
                <button
                  type="button"
                  onClick={() =>
                    setEditing({
                      id: step.id,
                      text: step.text,
                      dueAt: toLocalInputValue(step.due_at),
                    })
                  }
                  disabled={busy}
                  className="px-3 py-2 min-h-[44px] rounded border border-border text-sm text-muted-foreground disabled:opacity-50 shrink-0"
                >
                  Edit
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
