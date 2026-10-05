// --- List sort options (Step 9b, docs/technical-spec-ui-standardization.md) --
//
// One list per page rather than one shared list, because the fields genuinely
// differ: an event has a scheduled date, a capture has a suggested one, a
// context has neither. The spec's rule is "show only applicable options; do not
// render disabled ones".
//
// "Name" maps to the key `title` throughout. That is not cosmetic — the shared
// comparator uses `get.title` as its tiebreaker for EVERY order, so the name
// accessor has to live under that key whether or not the page offers Name as a
// choice. See utils/sortOrders.js.

export const EVENT_SORT_OPTIONS = [
  // "Scheduled date", never "Date" — an event also has a created date and a
  // modified date, and this is the one the user thinks of as the event's own.
  { value: "time", label: "Scheduled date", defaultDir: "asc" },
  // On these two pages the row is an EVENT, so "Created" means when it was
  // scheduled, not when the intention behind it was conceived.
  { value: "created", label: "Created", defaultDir: "desc" },
  { value: "updated", label: "Last modified", defaultDir: "desc" },
  { value: "title", label: "Name", defaultDir: "asc" },
];

export const INBOX_SORT_OPTIONS = [
  { value: "created", label: "Created", defaultDir: "desc" },
  { value: "updated", label: "Last modified", defaultDir: "desc" },
  // Populated only by AI enrichment, so it is null on every un-enriched
  // capture. Nulls sort last in both directions, which means an all-null inbox
  // collapses to the title tiebreaker rather than shuffling — predictable, if
  // not useful until enrichment has run.
  { value: "suggested", label: "Suggested date", defaultDir: "asc" },
  { value: "title", label: "Name", defaultDir: "asc" },
];

// Contexts and Collections carry the same three, and the same accessors.
export const NAMED_RECORD_SORT_OPTIONS = [
  { value: "title", label: "Name", defaultDir: "asc" },
  { value: "created", label: "Created", defaultDir: "desc" },
  { value: "updated", label: "Last modified", defaultDir: "desc" },
];

export const NAMED_RECORD_ACCESSORS = {
  title: (r) => r.name,
  created: (r) => r.createdAt,
  updated: (r) => r.updatedAt,
};

// What an item search matches: its name, its description, and the name and
// description of every element. One definition, so Memories and Context detail
// cannot disagree about what finds an item. Pass to `matchesQuery` spread.
export function itemSearchFields(item) {
  const elements = Array.isArray(item.elements) ? item.elements : [];
  return [
    item.name,
    item.description,
    ...elements.flatMap((el) => [el?.name, el?.description]),
  ];
}

// Intentions — Step 12.8.
//
// NO scheduled date, unlike the two event pages. This list is
// `intentionsWithoutActiveEvent`: an intention that has an event drops out of it
// entirely, so the field would be null on every row present and the order would
// collapse to the title tiebreaker. An option that can only ever do nothing is
// worse than an absent one.
export const INTENTION_SORT_OPTIONS = [
  { value: "title", label: "Name", defaultDir: "asc" },
  { value: "created", label: "Created", defaultDir: "desc" },
  { value: "updated", label: "Last modified", defaultDir: "desc" },
];

// `title` maps to `text`, not `name` — an intention has no name. It must be
// present whether or not the page offers Name as a choice: `comparatorFor` uses
// `get.title` as the universal tiebreaker for EVERY order, so omitting it throws
// inside the comparator rather than failing in any sort-shaped way.
export const INTENTION_ACCESSORS = {
  title: (r) => r.text,
  created: (r) => r.createdAt,
  updated: (r) => r.updatedAt,
};

export const INBOX_ACCESSORS = {
  title: (r) => r.capturedText,
  created: (r) => r.createdAt,
  updated: (r) => r.updatedAt,
  suggested: (r) => r.suggestedEventDate,
};
