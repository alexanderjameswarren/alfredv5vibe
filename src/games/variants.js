import Vanish from "./variants/vanish";
import Cascade from "./variants/cascade";
import Drop from "./variants/drop";
import SightReader from "./variants/sightReader";

// The variant registry. The Games tab renders this list and nothing else knows
// what variants exist — adding one means adding one entry here and one file
// under ./variants, with no edits to the tab, the router, or Alfred.jsx.
//
// `description` is the one-line statement of what the tweak *is*, not a pitch
// for it. It is how two variants get compared after a run.
//
// `status` is either "current" or "archived". Variants are frozen once they are
// superseded, so this list only grows — with one exception, taken deliberately:
// the "Push Notification Test" entry was DELETED rather than archived when the
// diagnostic moved to Settings. Archiving is for a variant that has been
// superseded and is still playable; that was neither. Leaving it registered
// would have meant two copies of a diagnostic with no way to tell which one you
// were looking at, which is worse than none.
//
// Keep it in the order they were built and
// let the tab do the sorting. Anything not explicitly archived counts as
// current, which means forgetting the field puts a new variant at the top where
// it will be noticed, rather than burying it.
export const VARIANTS = [
  {
    id: "vanish",
    name: "Vanish",
    description: "Merged tiles leave permanent holes.",
    status: "archived",
    component: Vanish,
  },
  {
    id: "cascade",
    name: "Cascade",
    description: "Tap clears a drifting chain of near neighbours.",
    status: "archived",
    component: Cascade,
  },
  {
    id: "drop",
    name: "Drop",
    description: "Horizontal chains only, survivors fall into the gaps.",
    status: "current",
    component: Drop,
  },
  // Not a tile-merge variant — the tab is the registry, and the registry does
  // not care. Sight Reader draws one note or chord on a stave and asks you to
  // name it. It is here rather than behind its own route because the registry
  // costs one entry and one file, and moving it out later is reversible.
  {
    id: "sight-reader",
    name: "Sight Reader",
    description: "Name the note or chord drawn on the stave.",
    status: "current",
    component: SightReader,
  },
];

export const CURRENT_VARIANTS = VARIANTS.filter((v) => v.status !== "archived");
export const ARCHIVED_VARIANTS = VARIANTS.filter((v) => v.status === "archived");

// Archived variants are still playable — they are superseded, not withdrawn —
// so this searches the whole registry.
export function findVariant(id) {
  return VARIANTS.find((v) => v.id === id) || null;
}
