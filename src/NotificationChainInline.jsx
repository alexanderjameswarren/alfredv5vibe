import React, { useState, useEffect, useCallback } from "react";
import { Bell, BellOff, Clock } from "lucide-react";
import AppLink from "./AppLink";
import {
  getNotificationSteps,
  cancelPendingSteps,
  cancelStep,
  restoreCancelledSteps,
  revertStepToChain,
  updateStepText,
  updateStepDueAt,
} from "./utils/notificationStepsApi";
import {
  describeStepStatus,
  planChainToggle,
} from "./utils/notificationSteps";
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
  // Ticking an element writes to notification_steps from OUTSIDE this hook, so
  // without watching completion the rows here go stale: the panel keeps showing
  // a step as `waiting` after the chain armed it, or a row as `done` against an
  // element that has since been un-ticked. That mismatch is what produced a
  // gutted notification line in the field.
  const completionSignature = (Array.isArray(elements) ? elements : [])
    .map((el) => (el && el.isCompleted ? "1" : "0"))
    .join("");
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
  }, [load, completionSignature]);

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
    cancelAll: () => act(() => cancelPendingSteps(executionId)),
    // Distinct from revert: cancel STOPS the notification. Wiring this to
    // revert made the control appear to do nothing while quietly re-arming the
    // row at a new time.
    cancelOne: (stepId) => act(() => cancelStep(stepId)),
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

  // Every case answered by one TOTAL function. The previous version listed
  // five states as bare JSX conditions with no fallback, so `done` and
  // `skipped` rendered a clock icon and nothing else — no text, no controls.
  const status = describeStepStatus(step, element, shortTime);

  return (
    <div className="mt-1 flex items-center flex-wrap gap-x-3 gap-y-1">
      <span
        className={`text-xs flex items-center gap-1 ${
          status.canCancel || status.canEdit ? "text-primary" : "text-muted-foreground"
        }`}
      >
        {element.isCompleted ? (
          <Bell className="w-3 h-3 shrink-0" />
        ) : (
          <Clock className="w-3 h-3 shrink-0" />
        )}
        {status.text}
      </span>

      <span className="flex items-center gap-2">
        {status.canCancel && (
          <button
            type="button"
            onClick={() => chain.cancelOne(step.id)}
            disabled={chain.busy}
            className="text-xs underline text-muted-foreground disabled:opacity-50"
          >
            cancel notification
          </button>
        )}
        {status.canRestore && (
          <button
            type="button"
            onClick={() => chain.revert(step.id)}
            disabled={chain.busy}
            className="text-xs underline text-muted-foreground disabled:opacity-50"
          >
            restore
          </button>
        )}
        {status.canEdit && (
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
 * "Cancel all notifications" / "Schedule remaining", rendered inline.
 *
 * 🛑 PLACEMENT RULE, so it survives the next edit: **the button sits above
 * everything it will affect and below everything it will not.** Anything else
 * misrepresents its scope.
 *
 * That means the anchor is the first CANCELLABLE row, not the first waiting
 * one. Sitting above the first waiting row while also cancelling the scheduled
 * row above it read as though it only touched the rows below. A `sent` row
 * cannot be cancelled — the notification has already gone — so the button
 * naturally moves below it as the chain progresses.
 *
 * "Cancel all notifications", not "Cancel remaining": it also cancels the
 * currently scheduled step, so "remaining" understated it. The label says what
 * the button does.
 */
export function ChainRemainingToggle({ chain, index }) {
  const toggle = planChainToggle(chain.steps || []);
  if (!toggle.show || toggle.anchorSeq - 1 !== index) return null;

  if (toggle.mode === "restore") {
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

  const pending = (chain.steps || []).filter(
    (s) => s.state === "waiting" || s.state === "scheduled"
  ).length;

  return (
    <div className="my-2 flex justify-center">
      <button
        type="button"
        onClick={() => {
          // eslint-disable-next-line no-restricted-globals
          const ok = window.confirm(
            `Cancel all ${pending} pending notification(s)?

` +
              `Anything already sent is unaffected. The steps stay on the list ` +
              `and can still be ticked, and "Schedule remaining" brings the ` +
              `notifications back.`
          );
          if (ok) chain.cancelAll();
        }}
        disabled={chain.busy}
        className="px-3 py-2 min-h-[44px] rounded border border-border text-sm text-destructive disabled:opacity-50"
      >
        Cancel all notifications
      </button>
    </div>
  );
}
