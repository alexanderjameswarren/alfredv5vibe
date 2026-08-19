/**
 * Key-case conversion between the database and React state.
 *
 * Pure functions — no side effects, no app imports, no React.
 *
 * This is the single implementation in the codebase. It was lifted verbatim from
 * the `toSnakeCase` / `toCamelCase` methods on the `storage` object in
 * Alfred.jsx, which now imports from here and exposes them as storage properties
 * so its own `storage.toCamelCase(...)` callers keep working unchanged.
 *
 * The recursion into arrays is load-bearing, not incidental. It is what converts
 * the keys *inside* a jsonb array — which is why `item_collections.items` stores
 * `item_id` on disk while React state holds `itemId`. Reading one layer's key
 * name and assuming it holds in the other has already cost one failed backfill.
 */

/**
 * Convert camelCase keys to snake_case, recursively, for writing to Postgres.
 *
 * @param {*} obj - Any value. Non-objects pass through untouched.
 * @returns {*} The same shape with snake_case keys.
 */
export function toSnakeCase(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => toSnakeCase(item));

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const snakeKey = key.replace(
      /[A-Z]/g,
      (letter) => `_${letter.toLowerCase()}`,
    );
    result[snakeKey] =
      typeof value === "object" && value !== null ? toSnakeCase(value) : value;
  }
  return result;
}

/**
 * Convert snake_case keys to camelCase, recursively, for reading into React state.
 *
 * @param {*} obj - Any value. Non-objects pass through untouched.
 * @returns {*} The same shape with camelCase keys.
 */
export function toCamelCase(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map((item) => toCamelCase(item));

  const result = {};
  for (const [key, value] of Object.entries(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) =>
      letter.toUpperCase(),
    );
    result[camelKey] =
      typeof value === "object" && value !== null ? toCamelCase(value) : value;
  }
  return result;
}
