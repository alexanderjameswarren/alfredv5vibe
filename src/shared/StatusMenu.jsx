import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown } from "lucide-react";
import { STATUS_LABELS, statusOf, statusOptionsFor } from "../utils/status";
import { PILL_CLASS } from "./StatusPill";

// The detail-page status control: the card pill plus a caret, opening a short
// menu. `onChoose` gets the new status and runs the page's own guard and sheet.
// Two taps to change anything; no confirm (see Restructure P1 step 21).
export default function StatusMenu({ row, onChoose }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const current = statusOf(row);

  useEffect(() => {
    if (!open) return;
    function close(e) {
      if (e.type === "keydown" ? e.key === "Escape" : !ref.current?.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div className="relative shrink-0" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Status: ${STATUS_LABELS[current]}. Change`}
        className={`${PILL_CLASS} inline-flex items-center gap-1 min-h-[32px] hover:bg-secondary`}
      >
        {STATUS_LABELS[current]}
        <ChevronDown className="w-3 h-3" />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 z-30 w-44 py-1 bg-card border border-border rounded-lg shadow-lg">
          {statusOptionsFor(current).map((status) => (
            <button
              key={status}
              type="button"
              role="menuitemradio"
              aria-checked={status === current}
              onClick={() => {
                setOpen(false);
                if (status !== current) onChoose(status);
              }}
              className="w-full flex items-center justify-between gap-2 px-4 min-h-[44px] text-left text-sm text-foreground hover:bg-secondary"
            >
              {STATUS_LABELS[status]}
              {status === current && <Check className="w-4 h-4" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
