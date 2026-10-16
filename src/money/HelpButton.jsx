import React, { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { HelpCircle, X } from "lucide-react";
import { HELP, HELP_HEADINGS } from "./helpText";

/**
 * The help panel: one card at every width, near the top of the screen over a
 * dimmed backdrop, with the four fixed headings and, when given, the live
 * working from your data. Rendered into document.body, so it inherits nothing
 * (such as nowrap) from the title it was opened from. The body scrolls vertically only.
 */
export function HelpSheet({ helpKey, working, onClose }) {
  const entry = HELP[helpKey];
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);
  if (!entry) return null;

  return createPortal(
    // React events still bubble through a portal to the title's ancestors, so stop them here.
    <div className="fixed inset-0 z-[100] bg-black/50 whitespace-normal text-left font-normal text-foreground"
      onClick={(e) => { e.stopPropagation(); onClose(); }}>
      <div role="dialog" aria-modal="true" aria-label={entry.title} onClick={(e) => e.stopPropagation()}
        className="fixed left-1/2 -translate-x-1/2 top-[10vh] w-[calc(100vw-32px)] max-w-[480px] max-h-[80vh] supports-[height:100dvh]:max-h-[80dvh] flex flex-col bg-background border border-border rounded-lg shadow-xl">
        <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-2 shrink-0">
          <h3 className="text-lg font-medium min-w-0 [overflow-wrap:anywhere]">{entry.title}</h3>
          <button type="button" onClick={onClose} aria-label="Close"
            className="min-h-[44px] min-w-[44px] shrink-0 flex items-center justify-center text-muted-foreground rounded">
            <X className="w-5 h-5" />
          </button>
        </div>
        <dl data-testid="help-body"
          className="space-y-3 text-sm overflow-y-auto overflow-x-hidden overscroll-contain whitespace-normal [overflow-wrap:anywhere] px-5 pb-5">
          {HELP_HEADINGS.map((h) => (
            <div key={h.field}>
              <dt className="font-medium">{h.label}</dt>
              <dd className="text-muted-foreground mt-0.5">{entry[h.field]}</dd>
            </div>
          ))}
          {working && (
            <div>
              <dt className="font-medium">How this was worked out from your data</dt>
              <dd className="mt-0.5">{working}</dd>
            </div>
          )}
        </dl>
      </div>
    </div>,
    document.body,
  );
}

/**
 * A "?" that opens the help for one key from helpText.js. The icon sits inline
 * with text; an invisible box around it keeps the 44px tap target.
 */
export default function HelpButton({ helpKey, working }) {
  const [open, setOpen] = useState(false);
  const entry = HELP[helpKey];
  if (!entry) return null;
  return (
    <>
      <button type="button" onClick={(e) => { e.stopPropagation(); setOpen(true); }} aria-label={`About ${entry.title}`}
        className="relative inline-flex items-center justify-center w-6 h-6 ml-1 align-middle text-muted-foreground hover:text-primary rounded">
        <span className="absolute -inset-2.5" aria-hidden="true" />
        <HelpCircle className="w-4 h-4" aria-hidden="true" />
      </button>
      {open && <HelpSheet helpKey={helpKey} working={working} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * The last word of a title with its "?", kept together so the "?" wraps with
 * the title instead of sitting in a column of its own.
 */
export function HelpAfter({ children, helpKey, working }) {
  return (
    <span className="whitespace-nowrap">{children}<HelpButton helpKey={helpKey} working={working} /></span>
  );
}

/** Plain title text with its "?" after the last word. */
export function HelpTitle({ text, helpKey, working }) {
  const at = text.lastIndexOf(" ");
  return (
    <>
      {at < 0 ? "" : text.slice(0, at + 1)}
      <HelpAfter helpKey={helpKey} working={working}>{text.slice(at + 1)}</HelpAfter>
    </>
  );
}
