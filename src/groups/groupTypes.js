// Group types in Settings (Restructure P5 step 11). Pure.
import { GROUP_TYPE_ICONS } from "../shared/ObjectIcon";

export const TYPE_ICON_CHOICES = Object.keys(GROUP_TYPE_ICONS);

export const EXECUTION_MODES = [
  { value: "together", label: "Cooked together (one tap starts every member)" },
  { value: "separately", label: "Worked separately (members on their own)" },
];

export const modeLabel = (mode) => EXECUTION_MODES.find((m) => m.value === mode)?.label || mode;

/** How many groups, archived ones included, use this type: a type in use cannot be deleted. */
export const groupsUsingType = (typeId, groups = []) => groups.filter((g) => g.groupTypeId === typeId).length;

/** The form's draft for a type (or a new one). */
export function typeDraft(type) {
  return {
    labelSingular: type?.labelSingular || "",
    labelPlural: type?.labelPlural || "",
    icon: type?.icon || "Boxes",
    executionMode: type?.executionMode || "separately",
  };
}

/** The first problem with a draft, or null. */
export function typeProblem(draft, groupTypes = [], editingId = null) {
  if (!draft.labelSingular.trim()) return "Give it a name.";
  if (!draft.labelPlural.trim()) return "Give it a plural name.";
  const clash = groupTypes.find(
    (t) => t.id !== editingId && t.labelSingular.trim().toLowerCase() === draft.labelSingular.trim().toLowerCase(),
  );
  if (clash) return `There is already a type called ${clash.labelSingular}.`;
  if (!TYPE_ICON_CHOICES.includes(draft.icon)) return "Pick an icon.";
  if (!EXECUTION_MODES.some((m) => m.value === draft.executionMode)) return "Pick how it is worked.";
  return null;
}

/** The row written to group_types. */
export const typeRow = (draft) => ({
  labelSingular: draft.labelSingular.trim(),
  labelPlural: draft.labelPlural.trim(),
  icon: draft.icon,
  executionMode: draft.executionMode,
});
