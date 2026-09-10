// Search matching.
//
// Meant to become the single home for "does this row match what was typed",
// so it knows nothing about items, intentions or any other data shape: callers
// pick which fields count and pass them in.

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
