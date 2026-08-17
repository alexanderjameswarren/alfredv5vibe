// Sort orders for the SAM library lists (Recent / New / All songs / Drills).
//
// Lives here rather than in useSongLibrary because it is a VIEW concern: the
// hook's outputs are shared with ContinueSection, which must keep its own
// recency ordering no matter what the browse list is sorted by. Sorting at
// render time also means changing the order never refetches.
//
// Every comparator is a TOTAL order — each one falls through to title as a
// tiebreaker, so two songs never compare equal unless their titles match too.
// Without that, Array.prototype.sort's stability would leave the result
// dependent on the incoming order, and the incoming order is itself already
// sorted by recency. Sorting by "date added" would then silently mean "by
// date added, then by whatever recency happened to produce".
//
// Timestamps are compared as STRINGS. `created_at` and `lastPracticedAt` are
// both ISO 8601 UTC, which sorts correctly lexicographically, and this is the
// convention the rest of the library already uses. Parsing to Date here would
// add cost per comparison and buy nothing.

/**
 * The sort control's options, in the order they are offered. `value` is what
 * the component stores; `label` is what the user reads.
 *
 * `defaultDir` is the direction each field STARTS in when selected — the one
 * that is obviously right for it. Nobody picks "Title" wanting Z→A first, or
 * "Last played" wanting the song they have not touched since March. The
 * direction toggle flips from there.
 */
export const SORT_OPTIONS = [
  { value: "played", label: "Last played", defaultDir: "desc" },
  { value: "title", label: "Title", defaultDir: "asc" },
  { value: "added", label: "Date added", defaultDir: "desc" },
];

export const SORT_VALUES = SORT_OPTIONS.map((o) => o.value);

/** Direction a field starts in. Unknown fields fall back to descending. */
export function defaultDirectionFor(key) {
  return SORT_OPTIONS.find((o) => o.value === key)?.defaultDir ?? "desc";
}

/**
 * Default order. Chosen so that switching this feature on changes NOTHING
 * about how any of the four tabs already looked:
 *
 *   Recent / Drills  were already last-practiced desc, then title
 *   All songs        was already family-last-practiced desc, then root title
 *   New              holds only never-practiced songs, so every row's
 *                    timestamp is null and this collapses to the title
 *                    tiebreaker — which is exactly its previous behaviour
 */
export const DEFAULT_SORT = "played";

const text = (v) => (v == null ? "" : String(v));

/**
 * Compare two field values, honouring direction, with MISSING VALUES ALWAYS
 * LAST — in both directions, which is the one asymmetry here and is
 * deliberate.
 *
 * A song that has never been played belongs at the bottom of a last-played
 * list whichever way the arrow points. Letting direction move it would mean
 * "oldest first" opens with a wall of songs that have no date at all, and the
 * empty string would sort it there by accident rather than by intent.
 */
function compareValues(a, b, dir) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const cmp = a > b ? 1 : -1;
  return dir === "asc" ? cmp : -cmp;
}

/**
 * Build a comparator for `key` over items whose fields are reached through
 * `get` — the same three orders drive both the flat song lists and the
 * grouped family list, which read their values from different places.
 *
 * The title TIEBREAKER stays A→Z regardless of direction. It is not part of
 * what the user asked for; it is the thing that makes the order total, and a
 * tiebreaker that flips would shuffle equal rows for no reason the user can
 * see. Only when title IS the sort key does direction apply to it.
 *
 * @param {"played"|"title"|"added"} key
 * @param {{title:Function, played:Function, added:Function}} get
 * @param {"asc"|"desc"} [dir] - defaults to the key's natural direction
 */
export function comparatorFor(key, get, dir = defaultDirectionFor(key)) {
  const byTitle = (a, b) => text(get.title(a)).localeCompare(text(get.title(b)));
  if (key === "title") {
    return dir === "asc" ? byTitle : (a, b) => -byTitle(a, b);
  }
  const field = key === "added" ? get.added : get.played;
  return (a, b) =>
    compareValues(text(field(a)), text(field(b)), dir) || byTitle(a, b);
}

const SONG_ACCESSORS = {
  title: (s) => s.title,
  played: (s) => s.lastPracticedAt,
  added: (s) => s.created_at,
};

// A family sorts on its ROOT's title and creation, but on the FAMILY's last
// practice — `lastPracticedAt` is already the max across root and children,
// so a family whose only recent activity was a drill still sorts as recent.
const FAMILY_ACCESSORS = {
  title: (f) => f.root?.title,
  played: (f) => f.lastPracticedAt,
  added: (f) => f.root?.created_at,
};

/** Sort a flat song list. Returns a new array; the input is not mutated. */
export function sortSongs(songs = [], key = DEFAULT_SORT, dir) {
  return [...songs].sort(comparatorFor(key, SONG_ACCESSORS, dir));
}

/**
 * Sort a grouped family list by its roots. Returns a new array.
 *
 * Members WITHIN a family are left exactly as `useSongLibrary` arranged them
 * — variants by difficulty tier, drills by recency. That grouping carries
 * meaning the sort key does not: tier 1 before tier 3 is useful in a way that
 * "tier 3, because it was generated first" is not.
 */
export function sortFamilies(families = [], key = DEFAULT_SORT, dir) {
  return [...families].sort(comparatorFor(key, FAMILY_ACCESSORS, dir));
}
