// Search matching.
//
// Meant to become the single home for "does this row match what was typed",
// so it knows nothing about items, intentions or any other data shape: callers
// pick which fields count and pass them in.
//
// Two matchers, deliberately different, and the difference is the point:
//
//   matchesQuery    case-insensitive substring. Inner whitespace is
//                   SIGNIFICANT — "kosher  salt" does not match "Kosher Salt".
//                   Used by every list page and by ItemPicker.
//   matchesLoosely  ignores case, punctuation AND spacing entirely, so
//                   "wholefoods" matches "whole foods". Used only inside the
//                   tag picker, where the user is reaching for a short label
//                   they half-remember rather than scanning a list.
//
// matchesQuery is NOT widened to behave like matchesLoosely. Doing so would
// change the behaviour of every search in the app at once, and search.test.js
// pins the significant-whitespace rule on purpose.

/**
 * True when any field contains the query as a case-insensitive substring.
 *
 * The query is trimmed, and an empty or whitespace-only query matches
 * everything — an empty box filters nothing. Fields that are not strings
 * (null, undefined, numbers, objects) are skipped rather than thrown on, so a
 * missing description never breaks a search.
 */
export function matchesQuery(query, ...fields) {
  const q = typeof query === "string" ? query.trim().toLowerCase() : "";
  if (!q) return true;
  return fields.some(
    (field) => typeof field === "string" && field.toLowerCase().includes(q),
  );
}

/**
 * Lowercase, turn every non-alphanumeric character into a space, collapse runs
 * of whitespace and trim. Word boundaries SURVIVE as single spaces.
 *
 * Lifted verbatim from the private `normalize` in `ingredientMatch.js`, which
 * now imports it from here. That module splits the result on " " to tokenise
 * ingredient text, so the spaces are load-bearing there and this function must
 * keep producing them. `foldTight` is the variant that removes them.
 *
 * ASCII-only by construction: the character class is `[^a-z0-9\s]`, so an
 * accented letter folds to a space ("café" -> "caf"). That is pre-existing
 * ingredient-matching behaviour, preserved deliberately rather than quietly
 * improved — widening it would change which ingredients match which items.
 * Note that `normaliseTag` in `tags.js` is Unicode-aware and does NOT do this,
 * because it decides what gets STORED. See that file's header.
 */
export function foldText(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * `foldText` with the spaces taken out too, so nothing about how the text was
 * spaced, hyphenated or punctuated survives to be compared.
 *
 * "Whole Foods", "whole-foods", "whole_foods" and "wholefoods" all fold to
 * "wholefoods".
 */
function foldTight(s) {
  return foldText(s).replace(/\s+/g, "");
}

/**
 * True when any field contains the query as a substring, once both sides have
 * had case, punctuation and spacing folded away.
 *
 * Same contract as `matchesQuery` in every other respect: a non-string or
 * empty query matches everything, and non-string fields are skipped rather
 * than thrown on. A query that is nothing BUT punctuation ("!!!") folds to
 * empty and therefore matches everything, which is the right answer — it is
 * indistinguishable from an empty box.
 *
 * Search only. Never use this to decide whether two tags are the same tag:
 * storage equality is exact, on the output of `normaliseTag`.
 */
export function matchesLoosely(query, ...fields) {
  const q = typeof query === "string" ? foldTight(query) : "";
  if (!q) return true;
  return fields.some(
    (field) => typeof field === "string" && foldTight(field).includes(q),
  );
}
