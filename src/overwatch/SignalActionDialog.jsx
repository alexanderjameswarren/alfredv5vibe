import React, { useState } from "react";
import { createPortal } from "react-dom";
import { BellRing, Inbox, PauseCircle, Trash2 } from "lucide-react";
import CancelButton from "../shared/CancelButton";
import { actOnSignal } from "./overwatchApi";

// The Dispatcher card's "⋯" pop-up (notification_routing-d7v step 11f): hold, drop, or send one signal now.
// In the pop-up shape of ArchiveGroupDialog: portal, buttons, the shared Cancel.

const CHOICES = [
  { key: "hold", label: "Hold", icon: PauseCircle, action: "hold", queuedOnly: true },
  { key: "drop", label: "Drop", icon: Trash2, action: "drop", destructive: true },
  { key: "notify", label: "Send now as a notification", icon: BellRing, action: "deliver", as: "notification" },
  { key: "inbox", label: "Send now as an inbox item", icon: Inbox, action: "deliver", as: "inbox" },
];

// The server refuses an action that no longer applies with "The signal is <state>, so it cannot be …" (its
// "delivered" already reads "sent"). Here that reads "Already <state>. Nothing changed."; any other error as given.
const ALREADY = { sent: "sent", delivered: "sent", merged: "sent", dropped: "dropped", resolved: "dropped", held: "held" };

export function actionError(message) {
  const m = /^the signal is (\w+), so it cannot be/i.exec(String(message || ""));
  const word = m && ALREADY[m[1].toLowerCase()];
  return word ? `Already ${word}. Nothing changed.` : message;
}

/** signal: { id, title, state }. onDone(result) after a change; onCancel to close with nothing done. */
export default function SignalActionDialog({ signal, onDone, onCancel, act = actOnSignal }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const choices = CHOICES.filter((c) => !c.queuedOnly || signal.state === "queued");

  const choose = (c) => {
    setBusy(c.key);
    setError(null);
    act(signal.id, c.action, c.as || null)
      .then((result) => onDone(result))
      .catch((err) => { setError(actionError(err.message)); setBusy(null); });
  };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50" onClick={busy ? undefined : onCancel}>
      <div
        role="dialog"
        aria-label={`Actions for ${signal.title}`}
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4 [overflow-wrap:anywhere]"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-3">{signal.title}</h3>
        <div className="flex flex-col gap-2">
          {choices.map((c) => {
            const Icon = c.icon;
            return (
              <button
                key={c.key}
                type="button"
                onClick={() => choose(c)}
                disabled={!!busy}
                className={`flex items-center gap-2 px-4 py-2.5 min-h-[44px] rounded-lg text-sm border-2 disabled:opacity-60 ${
                  c.destructive ? "border-destructive text-destructive hover:bg-destructive/10"
                    : "border-border text-foreground hover:border-primary"}`}
              >
                <Icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                {busy === c.key ? "Working…" : c.label}
              </button>
            );
          })}
        </div>
        {error && <p role="alert" className="m-0 mt-3 text-sm text-destructive">{error}</p>}
        <div className="flex mt-4">
          <CancelButton onClick={onCancel} disabled={!!busy} className="flex-1" />
        </div>
      </div>
    </div>,
    document.body,
  );
}
