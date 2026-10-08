import React, { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";

const MENU_WIDTH = 224; // w-56
const EDGE = 16; // the page gutter

// The ⋯ button and its menu. Every row has an icon AND a label; a disabled row
// keeps its reason in `title`. `actions`: [{ label, icon, onClick, disabled,
// title, destructive }].
export default function OverflowMenu({ actions, label = "More actions" }) {
  const [open, setOpen] = useState(false);
  const [align, setAlign] = useState("right");
  const ref = useRef(null);

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

  function toggle() {
    // Same rule as SchedulePopover: grow away from whichever edge is nearer.
    const rect = ref.current?.getBoundingClientRect();
    setAlign(rect && rect.right - MENU_WIDTH < EDGE ? "left" : "right");
    setOpen((v) => !v);
  }

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className="flex items-center justify-center min-h-[44px] min-w-[44px] bg-secondary hover:bg-secondary text-foreground rounded-lg shadow-sm hover:shadow-md transition-all duration-200"
      >
        <MoreHorizontal className="w-5 h-5" />
      </button>
      {open && (
        <div
          role="menu"
          data-align={align}
          className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full mt-2 z-30 w-56 py-1 bg-card border border-border rounded-lg shadow-lg`}
        >
          {actions.map(({ label: text, icon: Icon, onClick, disabled, title, destructive }) => (
            <button
              key={text}
              type="button"
              role="menuitem"
              disabled={disabled}
              title={title || undefined}
              onClick={() => {
                setOpen(false);
                onClick();
              }}
              className={`w-full flex items-center gap-3 px-4 min-h-[44px] text-left text-sm hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed ${
                destructive ? "text-destructive" : "text-foreground"
              }`}
            >
              {Icon && <Icon className="w-4 h-4 shrink-0" />}
              {text}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
