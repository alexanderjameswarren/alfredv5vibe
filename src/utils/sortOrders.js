// Shared list-sort orders.
//
// Promoted out of src/sam/lib/samSort.js in Step 9a of
// docs/technical-spec-ui-standardization.md, where this logic was written for
// the SAM library and then turned out to be what every Alfred list page needs.
// SAM keeps its own option list and accessors — "Last played" does not
// generalize — and consumes the machinery from here.
//
// Three conventions carried over verbatim, each arrived at deliberately:
//
//   1. Every comparator falls through to a TITLE TIEBREAKER, so no two rows
//      ever compare equal unless their titles match too. Without it,
//      Array.prototype.sort's stability leaves the result dependent on the
//      incoming order — and the incoming order is usually already sorted by
//      something else, so "sort by date added" would silently mean "by date
//      added, then by whatever the previous sort happened to produce".
//   2. The tiebreaker stays A→Z REGARDLESS of direction. It is not what the
//      user asked for; it is the thing that makes the order total, and a
//      tiebreaker that flipped would shuffle equal rows for no visible reason.
//      Only when title IS the sort key does direction apply to it.
//   3. MISSING VALUES SORT LAST IN BOTH DIRECTIONS. This is the one asymmetry
//      here and it is intentional. A song never played, or an inbox capture
//      with no suggested date, belongs at the bottom whichever way the arrow
//      points — otherwise "oldest first" opens with a wall of rows that have
//      no date at all, sorted there by accident rather than by intent.
//
// Timestamps are compared as STRINGS. `created_at`, `updated_at` and
// `lastPracticedAt` are ISO 8601, and `events.time` and
// `inbox.suggested_event_date` are "YYYY-MM-DD"; all four sort correctly
// lexicographically. Parsing to Date per comparison would cost more and buy
// nothing.

const text = (v) => (v == null ? "" : String(v));

/**
 * Compare two already-stringified field values.
 *
 * Missing values are forced last before direction is considered — see
 * convention 3 above.
 */
export function compareValues(a, b, dir) {
  if (a === b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  const cmp = a > b ? 1 : -1;
  return dir === "asc" ? cmp : -cmp;
}

/**
 * Build a comparator.
 *
 * @param {string} key - which field to sort on; must match a key in `get`,
 *   except for "title" which is handled specially.
 * @param {Object} get - accessor bag, e.g. { title: r => r.name, created: … }.
 *   MUST include `title`; every comparator falls through to it.
 * @param {"asc"|"desc"} dir
 *
 * Generalised during the promotion: SAM's version hardcoded
 * `key === "added" ? get.added : get.played`, which allowed exactly two
 * non-title fields. It now looks the accessor up by key, so a page can offer
 * as many orders as it likes. SAM's three keys resolve identically.
 *
 * An unknown key degrades to title order rather than throwing — a stored
 * preference can outlive the option that produced it (see readStoredSort,
 * which also guards this), and a list that renders in the wrong order is a
 * better failure than a list that does not render.
 */
export function comparatorFor(key, get, dir) {
  const byTitle = (a, b) =>
    text(get.title(a)).localeCompare(text(get.title(b)));

  if (key === "title") {
    return dir === "asc" ? byTitle : (a, b) => -byTitle(a, b);
  }

  const field = get[key];
  if (typeof field !== "function") return byTitle;

  return (a, b) =>
    compareValues(text(field(a)), text(field(b)), dir) || byTitle(a, b);
}

/**
 * The direction a field starts in when it is chosen — the one that is
 * obviously right for it. Nobody picks "Name" wanting Z→A first, or "Last
 * modified" wanting the row they have not touched since spring.
 *
 * Takes the option list rather than reading a module-level one, which is what
 * makes this usable by pages whose options differ.
 */
export function defaultDirectionFor(key, options = []) {
  return options.find((o) => o.value === key)?.defaultDir ?? "desc";
}

/** Sort a list. Returns a new array; the input is never mutated. */
export function sortRows(rows = [], key, get, dir) {
  return [...rows].sort(comparatorFor(key, get, dir));
}

// --- Persistence -------------------------------------------------------------
//
// One key per page, holding both field and direction. Pure functions rather
// than a hook so they can be unit-tested without React; the hook that uses them
// lives in SortControl.jsx.
//
// Every access is wrapped: localStorage throws rather than returning null when
// storage is disabled or the quota is full, and a sort preference is not worth
// taking a page down for.

/**
 * Read a stored preference, validating it against the options actually on
 * offer. Anything absent, malformed, or naming an option this page no longer
 * has falls back to the page default.
 */
export function readStoredSort(storageKey, options, fallbackKey) {
  const fallback = {
    key: fallbackKey,
    dir: defaultDirectionFor(fallbackKey, options),
  };
  let raw;
  try {
    raw = window.localStorage.getItem(storageKey);
  } catch {
    return fallback;
  }
  if (!raw) return fallback;

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== "object") return fallback;

  // The stored key must still be an option this page offers. Options change
  // between releases; a preference naming a field that no longer exists would
  // otherwise sort by an accessor that is not there.
  const known = options.some((o) => o.value === parsed.key);
  if (!known) return fallback;

  const dir = parsed.dir === "asc" || parsed.dir === "desc" ? parsed.dir : null;
  return { key: parsed.key, dir: dir || defaultDirectionFor(parsed.key, options) };
}

/** Persist a preference. Silently does nothing if storage is unavailable. */
export function writeStoredSort(storageKey, sort) {
  try {
    window.localStorage.setItem(
      storageKey,
      JSON.stringify({ key: sort.key, dir: sort.dir }),
    );
  } catch {
    /* preference not saved; the list is still sorted for this session */
  }
}
