import React, { useState } from "react";
import { NotebookPen } from "lucide-react";
import CompleteNoteDialog from "../notes/CompleteNoteDialog";
import { getTodayDate } from "../utils/eventDates";

/**
 * Log Execution on a menu (Restructure P5 step 14b): the Phase 4 pop-up with
 * "Completed on" and a note, plus the menu's recipes, all ticked. An unticked recipe
 * is recorded as skipped. `onLog({ note, completedOn, doneIds })` resolves true when saved.
 */
export default function LogMenuDialog({ recipes, onLog, onCancel }) {
  const [ticked, setTicked] = useState(() => new Set(recipes.map((r) => r.id)));
  const toggle = (id) =>
    setTicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <CompleteNoteDialog
      title="Log execution"
      confirmLabel="Log"
      confirmIcon={NotebookPen}
      completion={{ today: getTodayDate() }}
      onCancel={onCancel}
      onComplete={(note, _next, completedOn) => onLog({ note, completedOn, doneIds: [...ticked] })}
    >
      {recipes.length > 0 && (
        <fieldset className="mb-4">
          <legend className="text-sm font-medium text-foreground mb-2">Recipes cooked</legend>
          <div className="space-y-1">
            {recipes.map((r) => (
              <label key={r.id} className="flex items-center gap-3 min-h-[44px] text-sm">
                <input type="checkbox" checked={ticked.has(r.id)} onChange={() => toggle(r.id)} className="w-5 h-5 accent-primary" />
                <span className={ticked.has(r.id) ? "" : "text-muted-foreground line-through"}>{r.name}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-1">Unticked ones are recorded as skipped.</p>
        </fieldset>
      )}
    </CompleteNoteDialog>
  );
}
