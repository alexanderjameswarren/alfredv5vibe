/**
 * The capture a record was filed from, read-only — Alfred Clipboard, Step 24.
 *
 * Triage archives the inbox row rather than deleting it (Step 14), and every item,
 * intention and event it creates carries `source_inbox_id` back to it. Until now
 * nothing read that link on the way out: once a capture was processed, the words
 * originally typed were in the database and on no screen in the app.
 *
 * Clamped rather than cut, the same way the clipboard section on the inbox detail page
 * does it: "Show all" reveals text that was always in the DOM, so a browser find still
 * reaches it.
 *
 * The text block's styling is the inbox detail page's, deliberately — one capture should
 * look the same wherever it is shown. The heading is the host screen's `text-lg
 * font-medium`, because this section sits among that screen's other sections.
 */

import { useState } from "react";
import { AlignLeft, ChevronDown, ChevronUp } from "lucide-react";
import { COLLAPSE_LINES, needsShowAll } from "./utils/capturedClip";

/** @param {string} capturedText The archived inbox row's text. Nothing renders without it. */
export default function OriginalCapture({ capturedText }) {
  const [showAll, setShowAll] = useState(false);
  const text = (capturedText || "").trim();
  // A record filed by hand has no capture, and a heading over nothing would read as a
  // capture that went missing.
  if (!text) return null;

  return (
    <section className="mt-6">
      <h3 className="flex items-center gap-2 text-lg font-medium text-foreground mb-3">
        <AlignLeft className="w-[18px] h-[18px] shrink-0" aria-hidden="true" />
        Original capture
      </h3>
      <div
        className="px-4 py-3.5 rounded-lg bg-background text-base leading-relaxed whitespace-pre-wrap"
        style={
          showAll
            ? undefined
            : {
                display: "-webkit-box",
                WebkitLineClamp: COLLAPSE_LINES,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }
        }
      >
        {text}
      </div>
      {needsShowAll(text) && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-2 inline-flex items-center gap-1.5 min-h-[44px] text-sm text-primary hover:text-primary-hover"
        >
          {showAll ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          {showAll ? "Show less" : "Show all"}
        </button>
      )}
    </section>
  );
}
