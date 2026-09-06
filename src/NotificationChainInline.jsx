import React, { useState, useEffect, useCallback } from "react";
import { Bell, BellOff, Clock } from "lucide-react";
import AppLink from "./AppLink";
import {
  getNotificationSteps,
  cancelNotificationSteps,
  restoreCancelledSteps,
  revertStepToChain,
  updateStepText,
  updateStepDueAt,
} from "./utils/notificationStepsApi";
import { getDeviceSubscriptionState } from "./utils/pushSubscriptions";

/**
 * Notification state, shown ON each element rather than in a section of its own.
 *
 * The separate "Timed steps" list said everything twice: the same steps in the
 * same order, once to tick and once to read about. What a step's notification is
 * doing belongs next to the step, where you are already looking.
 *
 * 🛑 Every edit here writes to the notification_steps row for THIS RUN and never
 * back to the item's elements. The rows are copies taken at execution start. If
 * the same edit is needed every run, the template is wrong and the item should
 * change — silently rewriting a recipe because someone was late once is the
 * failure this rule prevents.
 */

const TERMINAL = new Set(["done", "skipped", "cancelled"]);

const shortTime = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const time = d
    .toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    .toLowerCase()
    .replace(/\s/g, "");
  const today = new Date();
  const sameDay =
    d.getFullYear() === today.getFullYear() &&
    d.getMonth() === today.getMonth() &&
    d.getDate() === today.getDate();
  return sameDay
    ? time
    : `${time} ${d.toLocaleDateString([], { day: "numeric", month: "short" })}`;
};

/** ISO → the LOCAL wall-clock value a datetime-local input wants. */
function toLocalInputValue(iso) {
  const d = iso ? new Date(iso) : new Date();
  if (Number.isNaN(d.getTime())) return "";
  // toISOString would convert to UTC and show the wrong time in any zone but
  // Greenwich — the trap parseLocalDate exists for elsewhere in Alfred.
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/** Load the chain for an execution, with the actions that mutate it. */
export function useNotificationChain(executionId, elements) {
  const [steps, setSteps] = useState(null);
  const [reachable, setReachable] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

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

  // Only asked once there is a chain to warn about, so a user who never uses
  // timed steps never has their subscription state queried.
  useEffect(() => {
    if (!steps || steps.length === 0) return undefined;
    let cancelled = false;
    getDeviceSubscriptionState().then((s) => {
      if (!cancelled) setReachable(s.reachable);
    });
    return () => {
      cancelled = true;
    };
  }, [steps]);

  const act = useCallback(
    async (fn) => {
      setBusy(true);
      try {
        await fn();
        await load();
      } catch (e) {
        setError(e && e.message ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [load]
  );

  return {
    steps,
    reachable,
    busy,
    error,
    reload: load,
    cancelRemaining: () => act(() => cancelNotificationSteps(executionId)),
    scheduleRemaining: () => act(() => restoreCancelledSteps(executionId, elements)),
    revert: (stepId) => act(() => revertStepToChain(executionId, elements, stepId)),
    saveEdit: (stepId, text, dueAtLocal, original) =>
      act(async () => {
        if (text !== original.text) await updateStepText(stepId, text);
        if (dueAtLocal) {
          const iso = new Date(dueAtLocal).toISOString();
          if (iso !== original.due_at) await updateStepDueAt(stepId, iso);
        }
      }),
  };
}

/** The banner shown above the elements when a chain cannot be delivered here. */
export function ChainUnreachableNotice({ chain, onOpenSettings }) {
  const live = (chain.steps || []).filter((s) => !TERMINAL.has(s.state));
  if (chain.reachable !== false || live.length === 0) return null;

  return (
    <div className="mb-3 p-3 rounded border border-destructive bg-destructive-light/40">
      <p className="text-sm text-destructive flex items-start gap-2">
        <BellOff className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          Notifications for this execution won't be delivered on this device.{" "}
          {/* A real link: AppLink takes `view`, and onNavigate is what actually
              moves. Passing an href-shaped prop rendered plain text that looked
              tappable and did nothing. */}
          <AppLink
            view="settings"
            onNavigate={onOpenSettings}
            className="underline font-medium"
          >
            Enable them in Settings
          </AppLink>
          .
        </span>
      </p>
    </div>
  );
}

/**
 * The one-line notification status for a single element, plus its controls.
 *
 * Returns null for an element with no notification row, which is most of them.
 */
export function ElementNotification({ chain, element, index, editing, setEditing }) {
  const step = (chain.steps || []).find((s) => s.seq === index + 1);
  if (!step) return null;

  const isEditing = editing === step.id;
  const completed = Boolean(element.isCompleted);

  if (isEditing) {
    return (
      <div className="mt-2 p-3 bg-card border border-primary rounded-lg space-y-2">
        <input
          type="text"
          defaultValue={step.text}
          id={`step-text-${step.id}`}
          className="w-full px-3 py-2 border border-border rounded text-base"
          placeholder="What the notification says"
        />
        <label className="block text-sm text-muted-foreground">
          Notify at
          <input
            type="datetime-local"
            defaultValue={toLocalInputValue(step.due_at)}
            id={`step-due-${step.id}`}
            className="mt-1 w-full px-3 py-2 border border-border rounded text-base"
          />
        </label>
        <p className="text-xs text-muted-foreground">
          Applies to this run only. The item is not changed.
        </p>
        <div className="flex gap-2">
          <button
            type="button"
            disabled={chain.busy}
            onClick={() => {
              const text = document.getElementById(`step-text-${step.id}`).value;
              const due = document.getElementById(`step-due-${step.id}`).value;
              chain.saveEdit(step.id, text, due, step);
              setEditing(null);
            }}
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
      </div>
    );
  }

  // A completed element reports what became of its notification. `sent_at` is
  // the discriminator, not the state: a row can be `done` or `cancelled` and
  // what the user needs to know is whether anything actually reached them.
  if (completed) {
    const sent = shortTime(step.sent_at);
    return (
      <p className="mt-1 text-xs text-muted-foreground flex items-center gap-1">
        <Bell className="w-3 h-3 shrink-0" />
        {sent ? `notified ${sent}` : "notification cancelled — step completed"}
      </p>
    );
  }

  const due = shortTime(step.due_at);

  return (
    <div className="mt-1 flex items-center flex-wrap gap-x-3 gap-y-1">
      <span
        className={`text-xs flex items-center gap-1 ${
          step.state === "cancelled" ? "text-muted-foreground" : "text-primary"
        }`}
      >
        <Clock className="w-3 h-3 shrink-0" />
        {step.state === "scheduled" && due && `notify at ${due}`}
        {step.state === "sent" &&
          `notified ${shortTime(step.sent_at) || ""} — awaiting completion`}
        {step.state === "waiting" &&
          `notify ${step.offset_minutes} min after the step above is checked`}
        {step.state === "cancelled" && "notification cancelled"}
        {step.state === "no_subscription" && "not sent — no device was subscribed"}
      </span>

      <span className="flex items-center gap-2">
        {(step.state === "scheduled" || step.state === "sent") && (
          <button
            type="button"
            onClick={() => chain.revert(step.id)}
            disabled={chain.busy}
            className="text-xs underline text-muted-foreground disabled:opacity-50"
          >
            cancel notification
          </button>
        )}
        {step.state === "cancelled" && (
          <button
            type="button"
            onClick={() => chain.revert(step.id)}
            disabled={chain.busy}
            className="text-xs underline text-muted-foreground disabled:opacity-50"
          >
            restore
          </button>
        )}
        {!TERMINAL.has(step.state) && (
          <button
            type="button"
            onClick={() => setEditing(step.id)}
            disabled={chain.busy}
            className="text-xs underline text-muted-foreground disabled:opacity-50"
          >
            edit
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * "Cancel remaining" / "Schedule remaining", rendered inline immediately before
 * the first element that is still waiting.
 *
 * Placed there rather than at the top because "remaining" means "from here on",
 * and the boundary between what has happened and what has not is exactly where
 * that reads true. Deliberately NOT before a `sent` row awaiting completion —
 * that notification has already gone out; the remainder starts after it.
 */
export function chainAnchorIndex(steps) {
  if (!steps || steps.length === 0) return -1;
  const waiting = steps.filter((s) => s.state === "waiting");
  if (waiting.length > 0) {
    return Math.min(...waiting.map((s) => s.seq - 1));
  }
  // Everything remaining is cancelled: anchor on the first of those so the
  // toggle back to "Schedule remaining" is still reachable.
  const cancelled = steps.filter((s) => s.state === "cancelled");
  if (cancelled.length > 0) {
    return Math.min(...cancelled.map((s) => s.seq - 1));
  }
  return -1;
}

export function ChainRemainingToggle({ chain, index }) {
  const steps = chain.steps || [];
  if (chainAnchorIndex(steps) !== index) return null;

  const hasCancelled = steps.some((s) => s.state === "cancelled");
  const live = steps.filter((s) => !TERMINAL.has(s.state));

  if (hasCancelled) {
    return (
      <div className="my-2 flex justify-center">
        <button
          type="button"
          onClick={chain.scheduleRemaining}
          disabled={chain.busy}
          className="px-3 py-2 min-h-[44px] rounded border border-border text-sm text-primary disabled:opacity-50"
        >
          Schedule remaining
        </button>
      </div>
    );
  }

  if (live.length === 0) return null;

  return (
    <div className="my-2 flex justify-center">
      <button
        type="button"
        onClick={() => {
          // eslint-disable-next-line no-restricted-globals
          const ok = window.confirm(
            `Cancel the remaining ${live.length} notification(s)?\n\n` +
              `The steps stay on the list and can still be ticked. You can ` +
              `bring the notifications back with "Schedule remaining".`
          );
          if (ok) chain.cancelRemaining();
        }}
        disabled={chain.busy}
        className="px-3 py-2 min-h-[44px] rounded border border-border text-sm text-destructive disabled:opacity-50"
      >
        Cancel remaining
      </button>
    </div>
  );
}
