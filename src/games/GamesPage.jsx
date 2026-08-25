import React, { useState } from "react";
import { ArrowLeft, ChevronRight, ChevronDown } from "lucide-react";
import {
  CURRENT_VARIANTS,
  ARCHIVED_VARIANTS,
  findVariant,
} from "./variants";

// One row of the variant list. Shared by the current and the archived lists so
// an earlier version looks and behaves exactly like the current one — it is
// superseded, not demoted.
function VariantRow({ variant, onOpen }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(variant.id)}
      className="w-full text-left p-4 min-h-[44px] bg-card border border-border rounded-lg flex items-center justify-between gap-3"
    >
      <span>
        <span className="block font-medium text-foreground">
          {variant.name}
        </span>
        <span className="block text-sm text-muted-foreground">
          {variant.description}
        </span>
      </span>
      {/* Permanently visible, not revealed on hover — this is a phone. */}
      <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
    </button>
  );
}

// The Games tab: a variant harness.
//
// Games is a list of rule experiments over the same shared tile, not a single
// game. The tab's whole job is to list what exists and open one; everything
// about how a variant plays lives in its own file.
//
// The split between current and earlier versions is read straight off the
// registry, so a new round means flipping one `status` and adding one entry —
// nothing here changes.
export default function GamesPage() {
  const [openId, setOpenId] = useState(null);
  const [showArchived, setShowArchived] = useState(false);
  const open = findVariant(openId);

  if (open) {
    const Variant = open.component;
    return (
      <div>
        <div className="flex items-center gap-3 mb-4">
          <button
            type="button"
            onClick={() => setOpenId(null)}
            className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground rounded"
            title="Back to Games"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-lg sm:text-xl font-medium">{open.name}</h2>
            <p className="text-sm text-muted-foreground">{open.description}</p>
          </div>
        </div>
        {/* Remounts on reopen, which is the reset — no run survives leaving. */}
        <Variant />
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg sm:text-xl font-medium mb-3 sm:mb-4">Games</h2>

      <div className="space-y-2">
        {CURRENT_VARIANTS.map((variant) => (
          <VariantRow key={variant.id} variant={variant} onOpen={setOpenId} />
        ))}
      </div>

      {ARCHIVED_VARIANTS.length > 0 && (
        <div className="mt-6">
          <button
            type="button"
            onClick={() => setShowArchived((shown) => !shown)}
            aria-expanded={showArchived}
            className="w-full text-left px-1 py-2 min-h-[44px] flex items-center justify-between gap-3 text-sm text-muted-foreground"
          >
            <span>Earlier versions ({ARCHIVED_VARIANTS.length})</span>
            <ChevronDown
              className={`w-4 h-4 shrink-0 transition-transform ${
                showArchived ? "rotate-180" : ""
              }`}
            />
          </button>

          {showArchived && (
            <div className="space-y-2 mt-2">
              {ARCHIVED_VARIANTS.map((variant) => (
                <VariantRow
                  key={variant.id}
                  variant={variant}
                  onOpen={setOpenId}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
