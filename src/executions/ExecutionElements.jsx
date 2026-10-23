import React, { useCallback, useEffect, useState } from "react";
import { Check, Timer } from "lucide-react";
import {
  useNotificationChain,
  ChainUnreachableNotice,
  ElementNotification,
  ChainRemainingToggle,
} from "../NotificationChainInline";

function formatElapsed(startedAt) {
  if (!startedAt) return "";
  const startMs = typeof startedAt === "string" ? new Date(startedAt).getTime() : startedAt;
  const seconds = Math.floor((Date.now() - startMs) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

/**
 * An execution's elements, steps tickable (moved out of ExecutionDetailView unchanged,
 * Restructure P5 step 14, so each recipe section of a menu run shows its own).
 * `onToggleElement(index)` resolves once its write is done; the chain reloads after it.
 */
export default function ExecutionElements({ execution, closed, onToggleElement, onUpdateElement, onOpenSettings }) {
  const [, setTick] = useState(0);
  // Notification state lives ON the elements, so the chain is loaded here
  // and threaded into the element rows rather than rendered as its own list.
  const chain = useNotificationChain(execution.id, execution.elements);
  const [editingStep, setEditingStep] = useState(null);

  // 🛑 Reload the chain AFTER the toggle has finished writing, not when the
  // element state changes.
  //
  // toggleExecutionElement updates elements optimistically and only THEN awaits
  // the storage write and the chain advance. The hook's completion-change
  // effect therefore fired first and read the rows back BEFORE the advance had
  // written them — so a ticked step left the next one still showing "notify N
  // min after…", and the stale read only corrected itself on the next unrelated
  // reload. Awaiting the toggle removes the race entirely.
  const handleToggleElement = useCallback(
    async (elementIndex) => {
      if (closed) return;
      await onToggleElement(elementIndex);
      await chain.reload();
    },
    [onToggleElement, chain, closed]
  );

  // Timer tick for in-progress elements
  useEffect(() => {
    const hasInProgress = execution.elements?.some((el) => el.inProgress);
    if (!hasInProgress) return;
    const interval = setInterval(() => setTick((t) => t + 1), 10000);
    return () => clearInterval(interval);
  }, [execution.elements]);

  if (!execution.elements || execution.elements.length === 0) return null;
  let stepCounter = 0;
  return (
    <div className="space-y-2">
      {!closed && <ChainUnreachableNotice chain={chain} onOpenSettings={onOpenSettings} />}
      {execution.elements.map((el, index) => {
        const indent = el.indent || 0;
        const indentPx = indent * 24;

        if (el.missing) {
          return (
            <div key={index} className="flex items-center gap-2 py-1 text-muted-foreground italic" style={{ marginLeft: indentPx }}>
              <span>⚠ {el.name} (item deleted)</span>
            </div>
          );
        }

        if (el.circular) {
          return (
            <div key={index} className="flex items-center gap-2 py-1 text-muted-foreground italic" style={{ marginLeft: indentPx }}>
              <span>↻ {el.name} (circular ref)</span>
            </div>
          );
        }

        if (el.displayType === "header") {
          return (
            <div key={index} className="mt-4 mb-2" style={{ marginLeft: indentPx }}>
              <h4 className="text-md font-bold text-foreground uppercase tracking-wide">
                {el.name}
              </h4>
            </div>
          );
        }

        if (el.displayType === "bullet") {
          return (
            <div key={index} className="flex items-start gap-2 py-1" style={{ marginLeft: indentPx + 16 }}>
              <span className="text-muted-foreground mt-0.5">•</span>
              <div className="flex-1">
                <span className="text-foreground">
                  {el.quantity && (
                    <span className="font-medium">{el.quantity} · </span>
                  )}
                  {el.name}
                </span>
                {el.description && (
                  <p className="text-sm text-muted-foreground">{el.description}</p>
                )}
              </div>
            </div>
          );
        }

        // step or any other displayType
        stepCounter++;
        const stepNum = stepCounter;
        return (
          <div key={index} style={{ marginLeft: indentPx }}>
            {!closed && <ChainRemainingToggle chain={chain} index={index} />}
            <div
              className={`flex items-start gap-3 py-2 px-3 rounded ${closed ? "" : "hover:bg-secondary/50"}`}
            >
              <span className={`font-medium min-w-[24px] mt-0.5 ${el.isCompleted ? "text-muted-foreground" : "text-muted-foreground"}`}>
                {stepNum}.
              </span>
              <span
                onClick={closed ? undefined : () => handleToggleElement(index)}
                aria-disabled={closed || undefined}
                data-testid="element-check"
                className={`mt-1 w-5 h-5 flex-shrink-0 rounded border-2 flex items-center justify-center ${closed ? "cursor-default" : "cursor-pointer"} ${
                  el.isCompleted
                    ? "bg-primary border-primary"
                    : el.inProgress
                      ? "bg-white border-primary"
                      : "bg-white border-border"
                }`}
              >
                {el.isCompleted && (
                  <Check className="w-3 h-3 text-white" />
                )}
              </span>
              <div className="flex-1">
                <span
                  className={
                    el.isCompleted
                      ? "line-through text-muted-foreground"
                      : el.inProgress
                        ? "text-primary font-medium"
                        : "text-foreground"
                  }
                >
                  {el.name}
                </span>
                {(el.quantity || el.description) && (
                  <p
                    className={`text-sm ${el.isCompleted ? "text-muted-foreground" : "text-muted-foreground"}`}
                  >
                    {[el.quantity, el.description]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                )}
                {!closed && (
                  <ElementNotification
                    chain={chain}
                    element={el}
                    index={index}
                    editing={editingStep}
                    setEditing={setEditingStep}
                  />
                )}
              </div>
              {!closed && !el.isCompleted && !el.inProgress && (
                <button
                  onClick={() => onUpdateElement(index, { inProgress: true, startedAt: new Date().toISOString() })}
                  className="text-sm text-primary hover:text-primary-hover whitespace-nowrap"
                >
                  Start
                </button>
              )}
              {!closed && el.inProgress && !el.isCompleted && (
                <button
                  onClick={() => onUpdateElement(index, { inProgress: false, startedAt: null })}
                  className="text-sm text-muted-foreground hover:text-muted-foreground whitespace-nowrap"
                >
                  Reset
                </button>
              )}
            </div>
            {!closed && el.inProgress && el.startedAt && !el.isCompleted && (
              <div className="ml-16 pb-1 text-xs text-primary">
                <Timer className="w-3.5 h-3.5 inline" /> Started {formatElapsed(el.startedAt)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
