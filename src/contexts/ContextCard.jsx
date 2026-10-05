import React from "react";
import { Pin, Settings, Share2 } from "lucide-react";
import ObjectIcon from "../shared/ObjectIcon";

export default function ContextCard({ context, onClick, onEdit, showSettings = false }) {
  return (
    // The handler sits on the root, not on the title block. The card already
    // advertised itself as clickable with cursor-pointer and hover:border-primary,
    // but only the left column responded — so the right half, the padding, and
    // the gap beside the gear were all dead. Matches ItemCard and IntentionCard.
    <div
      onClick={onClick}
      className="p-3 sm:p-4 bg-card border border-border rounded-lg cursor-pointer hover:border-primary shadow-sm hover:shadow-md transition-shadow duration-200"
    >
      {/* See CollectionCard — same shape, same collapse. Not a strip 8b added,
          but leaving it at 0 while the other three sit at 12 would recreate the
          inconsistency this step exists to remove. */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex-1 min-w-0">
          {/* Step 12.10. The type glyph LEADS and the pin trails: one is what
              this record is, the other is a flag on it, and identity should not
              queue behind status. The pin stays because the Contexts list mixes
              pinned and unpinned rows and is the only place that says which is
              which — in the Pinned section above it is merely redundant. */}
          <div className="flex items-center gap-2">
            <ObjectIcon type="context" className="w-4 h-4 text-primary" />
            <h3 className="font-medium text-foreground">{context.name}</h3>
            {context.pinned && <Pin className="w-3.5 h-3.5 text-muted-foreground" />}
          </div>
          {context.description && (
            <p className="text-sm text-muted-foreground mt-1">{context.description}</p>
          )}
          <div className="flex items-center gap-2 mt-1">
            {context.shared && (
              <span className="text-xs text-primary flex items-center gap-1">
                <Share2 className="w-3 h-3" />
                Shared
              </span>
            )}
          </div>
        </div>
        {showSettings && onEdit && (
          // KEPT, and now load-bearing. The spec asked for this stopPropagation
          // to go because the gear was a SIBLING of the clickable region and had
          // nothing to stop. Moving the handler to the root above makes the gear
          // a descendant of it, so without this a click here would open the
          // context AND the edit form — defect 0.3 all over again. The premise
          // for removing it was true only before this step's other half.
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-foreground"
          >
            <Settings className="w-5 h-5" />
          </button>
        )}
      </div>
    </div>
  );
}
