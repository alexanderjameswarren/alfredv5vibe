import React from "react";
import { ArrowLeft } from "lucide-react";

/**
 * Shared chrome for the two add pages — Step 12.6.
 *
 * The add forms used to render inline, wedged between a section header and the
 * list below. These are real pages with real addresses, so browser Back works
 * on them like any other navigation.
 *
 * ONE of these per form type, not one per entry point. Four near-identical
 * pages is the copy-paste drift that produced the three collection rows in
 * Step 4a; the entry point is data (a target in the URL), not code.
 *
 * The heading is load-bearing, not decoration. **Defect 0.1** was a phantom
 * "New Item" created by an Archive rendering in add mode, and the reason the
 * confusion was possible is that an add form and an edit form looked alike. A
 * page makes them look MORE alike — same width, same chrome, same sticky
 * footer — so the heading says "New Item" where the edit screen shows the
 * record's own name. Archive is still structurally absent (the seed record has
 * a null id and no `onArchive` prop); this is the visible half of the same
 * guarantee.
 */
export default function AddPageChrome({ title, subtitle, onBack, children }) {
  return (
    <div>
      <button
        onClick={onBack}
        className="flex items-center gap-2 mb-3 sm:mb-4 min-h-[44px] text-primary hover:text-primary-hover"
      >
        <ArrowLeft className="w-4 h-4" />
        Back
      </button>

      <div className="mb-3 sm:mb-4">
        <h2 className="text-xl sm:text-2xl font-bold text-foreground">{title}</h2>
        {subtitle && (
          <p className="text-sm text-muted-foreground mt-1">{subtitle}</p>
        )}
      </div>

      {children}
    </div>
  );
}
