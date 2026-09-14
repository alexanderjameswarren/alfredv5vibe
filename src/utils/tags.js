/**
 * The canonical tag rule. Applied on every write path.
 *
 * Pure functions — no side effects, no app imports, no React.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  TWIN FILE: supabase/functions/_shared/tags.ts                           ║
 * ║                                                                          ║
 * ║  These two files implement the SAME RULE and must be changed TOGETHER.   ║
 * ║  A change to one is a bug until the same change lands in the other.      ║
 * ║                                                                          ║
 * ║  This duplication is deliberate, not an oversight. Edge Functions run    ║
 * ║  on Deno and cannot import from `src/`, which is bundled by CRA for the  ║
 * ║  browser. There is no shared module that both runtimes can reach.        ║
 * ║                                                                          ║
 * ║  Alfred has been bitten by this exact shape before — two copies of a     ║
 * ║  normaliser that drifted apart, with the divergence only visible as      ║
 * ║  mismatched data much later. If you are reading this because you are     ║
 * ║  about to edit the rule: open the Deno twin now, in the other window,    ║
 * ║  and edit both before you run anything.                                  ║
 * ║                                                                          ║
 * ║  The cases in tags.test.js are the shared contract. Add a case here and  ║
 * ║  the twin must satisfy it too.                                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ─── Normalise on WRITE, never on LOAD ───────────────────────────────────────
 *
 * This is the load-bearing rule and it is easy to get wrong in a way that only
 * shows up as a bug report about phantom unsaved changes.
 *
 * Four "you have unsaved changes" checks in Alfred.jsx compare tags exactly as
 * stored, with `JSON.stringify(tags) !== JSON.stringify(record.tags || [])`.
 * They are correct today only because component state always already holds
 * canonical values — normalisation happens when the user COMMITS a tag, so the
 * value in state and the value in the database are the same string.
 *
 * Normalising on load would break that. A record holding a non-canonical tag
 * would load as `["whole foods"]` while the database still said
 * `["Whole Foods"]`, the comparison would report a difference that the user
 * never made, and opening the record and navigating away would be blocked by
 * an unsaved-changes prompt about an edit that does not exist.
 *
 * So: call this when a tag is committed in the UI, and on any non-UI write
 * path. Do not call it in a `useState` initialiser or anywhere a record is
 * being read.
 *
 * ─── Storage form vs matching form ───────────────────────────────────────────
 *
 * What this produces is what gets STORED, and equality between two tags is
 * exact string equality on that output. Searching inside the tag picker is
 * deliberately looser — see `matchesLoosely` in `utils/search.js`, which also
 * folds away spaces so "wholefoods" finds "whole foods". Never use the loose
 * fold to decide whether two tags are the same tag.
 *
 * ─── Unicode ────────────────────────────────────────────────────────────────
 *
 * "Letter" and "digit" below mean `\p{L}` and `\p{N}`, not `[a-z0-9]`, so
 * "café" normalises to "café" rather than "caf". Two reasons: silently
 * deleting a character the user typed is the behaviour this whole change set
 * exists to remove, and Migration A preserves accented characters (it only
 * lowercases and swaps underscores), so an ASCII-only rule here would leave
 * migrated tags that could never be retyped.
 *
 * This differs from `foldText` in `utils/search.js`, which is ASCII-only
 * because it inherited pre-existing ingredient-matching behaviour. That one
 * decides what MATCHES; this one decides what is STORED.
 */

/** Longest a single tag may be, measured after normalisation. */
export const MAX_TAG_LENGTH = 50;

/** Most tags one record may carry. Carried over from the old TagInput. */
export const MAX_TAGS = 20;

/**
 * Fold raw input into the canonical stored form of a tag.
 *
 * 1. Lowercase.
 * 2. Delete apostrophes outright, so "tj's" becomes "tjs" rather than "tj s".
 *    Both the ASCII `'` and the typographic `’` phones insert automatically.
 * 3. Every other character that is not a letter, digit, space, hyphen or
 *    underscore becomes a space.
 * 4. Underscores AND hyphens become spaces. Both were ways of writing a word
 *    break before spaces were legal, so "stir_fry", "stir-fry" and "stir fry"
 *    are one tag rather than three.
 * 5. Collapse whitespace runs, trim.
 * 6. Reject empty, or longer than MAX_TAG_LENGTH.
 *
 * Hyphens used to survive, and that was wrong. It left "stir-fry" sitting
 * beside "stir fry" as a permanently separate tag. The picker's loose matcher
 * hid the problem when a human typed, because it folds both to "stirfry" — but
 * the AI write paths never touch the picker, so a model returning "stir-fry"
 * created the duplicate anyway. Folding here means there is exactly one
 * canonical spelling of any multi-word tag, whoever wrote it.
 *
 * A leading or trailing hyphen leaves no stray space: the collapse-and-trim in
 * step 5 runs after this.
 *
 * @param {*} raw - Anything. Non-strings are rejected rather than coerced.
 * @returns {string|null} The canonical tag, or null if nothing survived.
 */
export function normaliseTag(raw) {
  if (typeof raw !== "string") return null;

  const canonical = raw
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^\p{L}\p{N} \-_]/gu, " ")
    .replace(/[-_]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!canonical) return null;
  if (canonical.length > MAX_TAG_LENGTH) return null;
  return canonical;
}

/**
 * Normalise a list of tags, dropping anything that does not survive,
 * deduplicating, and capping at MAX_TAGS.
 *
 * Order is preserved and first-occurrence wins, so a list that normalises to
 * duplicates keeps the position of the first one. The cap is applied AFTER
 * deduplication — twenty-five entries that collapse to eight tags give eight,
 * not a truncated mess.
 *
 * @param {*} rawList - Anything. A non-array gives [].
 * @returns {string[]} Canonical, deduplicated, at most MAX_TAGS long.
 */
export function normaliseTags(rawList) {
  if (!Array.isArray(rawList)) return [];

  const out = [];
  const seen = new Set();

  for (const raw of rawList) {
    const tag = normaliseTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }

  return out;
}
