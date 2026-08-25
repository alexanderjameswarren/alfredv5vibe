import Vanish from "./variants/vanish";
import Cascade from "./variants/cascade";
import Drop from "./variants/drop";

// The variant registry. The Games tab renders this list and nothing else knows
// what variants exist — adding one means adding one entry here and one file
// under ./variants, with no edits to the tab, the router, or Alfred.jsx.
//
// `description` is the one-line statement of what the tweak *is*, not a pitch
// for it. It is how two variants get compared after a run.
export const VARIANTS = [
  {
    id: "vanish",
    name: "Vanish",
    description: "Merged tiles leave permanent holes.",
    component: Vanish,
  },
  {
    id: "cascade",
    name: "Cascade",
    description: "Tap clears a drifting chain of near neighbours.",
    component: Cascade,
  },
  {
    id: "drop",
    name: "Drop",
    description: "Horizontal chains only, survivors fall into the gaps.",
    component: Drop,
  },
];

export function findVariant(id) {
  return VARIANTS.find((v) => v.id === id) || null;
}
