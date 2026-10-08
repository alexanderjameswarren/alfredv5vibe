import React, { useEffect, useRef } from "react";

// The rail's More drawer (song rail, step 4). Slides in from the left directly
// beside the rail, over a dimmed score; the rail itself is never covered, so it
// stays usable. Closes on the dim area, on Escape, or via the rail's Close.
//
// Everything is clipped to the area right of the rail, so the slide-in never
// passes over it. The slide is a Web Animation that ends with no transform
// left on the panel: a lingering transform would make it the containing block
// for the fixed-position dialogs inside it (Auto-Match's confirm).
//
// `left-[136px] sm:left-[140px]` is the rail's right edge: the page's px-3 /
// sm:px-4 gutter, the rail's w-28, and its mr-3.
export function DrawerSection({ title, children }) {
  return (
    <section aria-label={title} className="py-3 border-b border-border last:border-b-0">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">{title}</h3>
      {/* min-w-0 + the panel's overflow-x-hidden: rows wrap to the drawer's
          width instead of running off its right edge. */}
      <div className="flex flex-col gap-2 min-w-0 [&>div]:flex-wrap">{children}</div>
    </section>
  );
}

export default function MoreDrawer({ open, onClose, children }) {
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    // jsdom has no element.animate; the drawer simply appears there.
    panelRef.current?.animate?.(
      [{ transform: "translateX(-100%)" }, { transform: "none" }],
      { duration: 180, easing: "ease-out" }
    );
  }, [open]);

  if (!open) return null;

  return (
    <div className="fixed inset-y-0 right-0 left-[136px] sm:left-[140px] z-40 overflow-hidden">
      <div
        data-testid="more-drawer-dim"
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-label="More"
        className="absolute inset-y-0 left-0 w-[410px] max-w-full bg-card border-r border-border shadow-lg overflow-y-auto overflow-x-hidden px-4"
      >
        {children}
      </div>
    </div>
  );
}
