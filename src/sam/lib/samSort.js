// Sort orders for the SAM library lists (Recent / New / All songs / Drills).
//
// The MACHINERY moved to src/utils/sortOrders.js in Step 9a — it turned out to
// be what every Alfred list page needs, not something specific to songs. What
// stays here is the part that genuinely is song-specific: which three orders
// are offered, and where each one reads its value from.
//
// Lives here rather than in useSongLibrary because it is a VIEW concern: the
// hook's outputs are shared with ContinueSection, which must keep its own
// recency ordering no matter what the browse list is sorted by. Sorting at
// render time also means changing the order never refetches.
//
// The three conventions this module established — total ordering via a title
// tiebreaker, a tiebreaker that does not flip with direction, and missing
// values last in both directions — are documented at the top of
// utils/sortOrders.js and are unchanged.

import {
  defaultDirectionFor as sharedDefaultDirectionFor,
  sortRows,
} from "../../utils/sortOrders";

export const SORT_OPTIONS = [
  { value: "played", label: "Last played", defaultDir: "desc" },
  { value: "title", label: "Title", defaultDir: "asc" },
  { value: "added", label: "Date added", defaultDir: "desc" },
];

export const SORT_VALUES = SORT_OPTIONS.map((o) => o.value);

/**
 * Direction a field starts in. Unknown fields fall back to descending.
 *
 * Binds SAM's own option list to the shared lookup, so callers here keep the
 * one-argument signature they already use.
 */
export function defaultDirectionFor(key) {
  return sharedDefaultDirectionFor(key, SORT_OPTIONS);
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

// `compareValues` and `comparatorFor` used to live here. See
// utils/sortOrders.js — the only change on promotion was that `comparatorFor`
// looks its accessor up by key instead of hardcoding a two-field ternary, which
// resolves identically for SAM's three keys.

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
  // `dir` is resolved here rather than defaulted inside the comparator: the
  // shared version takes an explicit direction, because "the natural direction
  // for this key" depends on an option list it does not own.
  return sortRows(songs, key, SONG_ACCESSORS, dir ?? defaultDirectionFor(key));
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
  return sortRows(families, key, FAMILY_ACCESSORS, dir ?? defaultDirectionFor(key));
}
