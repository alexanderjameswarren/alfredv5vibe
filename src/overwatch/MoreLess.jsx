import React, { useLayoutEffect, useRef, useState } from "react";

/**
 * Measures whether the element behind `ref` is clamped (its text runs past the visible lines).
 * `extra` forces the toggle on when the collapsed view leaves text out by design (a first line).
 */
export function useClamp(text, extra = false) {
  const ref = useRef(null);
  const [overflow, setOverflow] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && !expanded) setOverflow(el.scrollHeight > el.clientHeight + 1);
  }, [text, expanded]);
  return { ref, expanded, show: extra || overflow || expanded, toggle: () => setExpanded(!expanded) };
}

/** The small "More" / "Less" control under clamped text. It never follows a link or copies. */
export default function MoreLess({ expanded, onToggle }) {
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={(e) => { e.preventDefault(); e.stopPropagation(); onToggle(); }}
      className="relative z-10 self-start inline-flex items-center min-h-[40px] pr-3 p-0 bg-transparent border-0 text-xs text-primary hover:text-primary-hover"
    >
      {expanded ? "Less" : "More"}
    </button>
  );
}
