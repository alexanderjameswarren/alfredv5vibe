import React, { useLayoutEffect, useRef, useState } from "react";
import { Archive, CalendarX, CircleCheckBig, CircleStop, NotebookPen } from "lucide-react";
import OverflowMenu from "./OverflowMenu";
import { ACTION_BUTTON } from "./actionButton";

/** Skip the live date (grey). Callers hide it while an execution is in progress. */
export function skipAction(onClick) {
  return {
    menu: { label: "Skip", icon: CalendarX, onClick },
    button: (
      <button
        onClick={onClick}
        title="Skip this date"
        className={`${ACTION_BUTTON} bg-secondary hover:bg-secondary text-foreground`}
      >
        <CalendarX className="w-4 h-4" />
        Skip
      </button>
    ),
  };
}

/**
 * Log Execution: record an execution that already happened, in one step (brown, the
 * primary colour). Not Complete, which finishes the execution in progress and lives
 * only on the execution page. Callers hide it while one is in progress.
 */
export function logAction(onClick) {
  return {
    menu: { label: "Log Execution", icon: NotebookPen, onClick },
    button: (
      <button
        onClick={onClick}
        title="Record an execution that already happened"
        className={`${ACTION_BUTTON} bg-primary hover:bg-primary-hover text-white`}
      >
        <NotebookPen className="w-4 h-4" />
        Log Execution
      </button>
    ),
  };
}

/** Stop (Step 10): end the repeat, keep the intention. Neutral, not destructive. */
export function stopAction(onClick) {
  return {
    menu: { label: "Stop repeating", icon: CircleStop, onClick },
    button: (
      <button onClick={onClick} className={`${ACTION_BUTTON} bg-secondary hover:bg-secondary text-foreground`}>
        <CircleStop className="w-4 h-4" />
        Stop repeating
      </button>
    ),
  };
}

/** Close (Restructure P5 step 13, groups): neutral, as the row's Close; nothing is destroyed. */
export function closeAction(onClick, blockedTitle = null) {
  return {
    menu: { label: "Close", icon: CircleCheckBig, onClick, disabled: Boolean(blockedTitle), title: blockedTitle },
    button: (
      <button
        onClick={onClick}
        disabled={Boolean(blockedTitle)}
        className={`${ACTION_BUTTON} bg-secondary hover:bg-secondary text-foreground disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <CircleCheckBig className="w-4 h-4" />
        Close
      </button>
    ),
  };
}

/** Archive: the red outline as a button, red text in the menu. */
export function archiveAction(onClick, blockedTitle = null) {
  return {
    menu: { label: "Archive", icon: Archive, destructive: true, onClick, disabled: Boolean(blockedTitle), title: blockedTitle },
    button: (
      <button
        onClick={onClick}
        disabled={Boolean(blockedTitle)}
        title={blockedTitle || "Archive"}
        className={`${ACTION_BUTTON} border-2 border-destructive text-destructive hover:bg-destructive/10 disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        <Archive className="w-4 h-4" />
        Archive
      </button>
    ),
  };
}

const GAP = 8; // gap-2
const MORE = 44; // the ⋯ button

/**
 * How many leading actions fit in `width` (Restructure P4): all of them when they
 * fit with no ⋯ (and nothing is menu-only), otherwise as many as fit beside the ⋯
 * button, never fewer than `pinned`.
 */
export function actionsThatFit(width, widths, { pinned = 0, menuOnly = false } = {}) {
  const span = (n) => widths.slice(0, n).reduce((s, w, i) => s + w + (i ? GAP : 0), 0);
  if (!menuOnly && span(widths.length) <= width) return widths.length;
  let n = widths.length;
  while (n > pinned && span(n) + (n ? GAP : 0) + MORE > width) n -= 1;
  return n;
}

/**
 * One row of record actions, in a fixed order: as many as fit at the current width
 * are buttons, the rest go into ⋯ in the same order, followed by `menuOnly` ones.
 * Measured at runtime (ResizeObserver); where it cannot measure, every action shows.
 *
 * actions: [{ key, button, menu, pinned }]
 *   button  the inline control
 *   menu    { label, icon, onClick, disabled, title, destructive } for the ⋯ menu, or
 *           null for an action that cannot live in a menu (it must be `pinned`)
 *   pinned  always a button (leading actions only)
 * menuOnly: [{ label, icon, onClick, ... }] always in ⋯, after the rest.
 */
export default function ActionBar({ actions, menuOnly = [] }) {
  const boxRef = useRef(null);
  const measureRef = useRef(null);
  const [shown, setShown] = useState(actions.length);
  const pinned = actions.filter((a) => a.pinned).length;
  const key = actions.map((a) => a.key).join("|") + `|${menuOnly.length}`;

  useLayoutEffect(() => {
    const box = boxRef.current;
    const measure = measureRef.current;
    if (!box || !measure || typeof ResizeObserver === "undefined") return undefined;
    const fit = () => {
      const width = box.clientWidth;
      const widths = [...measure.children].map((el) => el.offsetWidth);
      if (!width || widths.some((w) => !w)) return setShown(actions.length);
      setShown(actionsThatFit(width, widths, { pinned, menuOnly: menuOnly.length > 0 }));
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(box);
    return () => observer.disconnect();
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const overflow = [...actions.slice(shown).map((a) => a.menu).filter(Boolean), ...menuOnly];
  return (
    <div ref={boxRef} className="relative flex flex-nowrap gap-2 mt-3">
      {actions.slice(0, shown).map((a) => (
        <React.Fragment key={a.key}>{a.button}</React.Fragment>
      ))}
      {overflow.length > 0 && <OverflowMenu actions={overflow} />}
      {/* Off-screen copy, for widths only. */}
      <div ref={measureRef} aria-hidden="true" inert="" className="absolute invisible flex gap-2 w-max left-0 top-0 pointer-events-none">
        {actions.map((a) => (
          <div key={a.key}>{a.button}</div>
        ))}
      </div>
    </div>
  );
}
