import React from "react";
import { Pause, Play } from "lucide-react";
import ObjectIcon from "../shared/ObjectIcon";

// `children` render inside the card, below its state line (the run's notes on detail pages).
export default function ExecutionBadge({ exec, intents, contexts, getIntentDisplay, onOpen, children }) {
  const intent = intents.find((i) => i.id === exec.intentId);
  const isActive = exec.status === "active";

  return (
    <div
      onClick={(e) => {
        e.stopPropagation();
        onOpen(exec);
      }}
      // Teal means running, app-wide: the same colour as the Start and Continue
      // buttons that reach it. Paused stays amber, a different state.
      data-state={isActive ? "active" : "paused"}
      className={`p-3 sm:p-4 rounded-lg cursor-pointer shadow-sm hover:shadow-md transition-shadow duration-200 min-h-[44px] ${
        isActive
          ? "bg-success-light border-2 border-success"
          : "bg-warning-light border-2 border-warning"
      }`}
    >
      {/* The glyph says this card is a RUN; the Play/Pause line below says
          which state that run is in. Two different jobs, which is why the
          badge carries both — it previously carried only the second, and so
          never said what kind of record it was. */}
      <p className="flex items-start gap-1.5 font-medium text-foreground">
        <ObjectIcon type="execution" className="w-4 h-4" align="first-line" />
        <span className="min-w-0">
          {intent ? getIntentDisplay(intent) : "Execution"}
        </span>
      </p>
      {exec.contextId && (
        <p className="flex items-center gap-1.5 text-sm text-foreground">
          <ObjectIcon type="context" className="w-3.5 h-3.5" />
          {contexts.find((c) => c.id === exec.contextId)?.name}
        </p>
      )}
      {isActive && (
        <p className="text-xs text-foreground mt-1 flex items-center gap-1">
          <Play className="w-3 h-3" />
          In progress
        </p>
      )}
      {!isActive && (
        <p className="text-xs text-warning mt-1 flex items-center gap-1">
          <Pause className="w-3 h-3" />
          Paused — click to resume
        </p>
      )}
      {children}
    </div>
  );
}
