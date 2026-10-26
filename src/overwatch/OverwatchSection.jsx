import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import OverwatchCopyButton from "./OverwatchCopyButton";

/** One collapsible section card on the Overwatch tab; the header follows Context's section toggles. */
export default function OverwatchSection({ id, title, icon, count = null, defaultOpen = false, copy = null, children }) {
  const [open, setOpen] = useState(defaultOpen);
  const headingId = `overwatch-${id}`;
  return (
    <section aria-labelledby={headingId} className="bg-card border border-border rounded-lg">
      <div className="flex items-center justify-between gap-2 px-4 py-1">
        <button
          type="button"
          id={headingId}
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex items-center gap-2 min-h-[44px] text-base sm:text-lg font-medium text-foreground"
        >
          <ChevronDown className={`w-4 h-4 transition-transform ${open ? "" : "-rotate-90"}`} aria-hidden="true" />
          {icon}
          <span>
            {title}
            {count !== null && ` (${count})`}
          </span>
        </button>
        {copy && <OverwatchCopyButton copy={copy} />}
      </div>
      {open && <div className="px-4 pb-4">{children}</div>}
    </section>
  );
}
