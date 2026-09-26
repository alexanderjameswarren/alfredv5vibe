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
 * ║                                                                          ║
 * ║  SCOPE: the twin rule covers NORMALISATION only — normaliseTag,          ║
 * ║  normaliseTags, MAX_TAG_LENGTH, MAX_TAGS. The tag-pool functions at the  ║
 * ║  bottom of this file are front-end only and have NO twin: they count     ║
 * ║  rows already sitting in React state, which the Deno side never sees.    ║
 * ║  Their tests live in tags.pool.test.js, deliberately apart from the      ║
 * ║  shared contract in tags.test.js.                                        ║
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

// ─── Tag pools (front-end only, no Deno twin) ────────────────────────────────

/**
 * Every tag currently in use across the records passed in, most-used first.
 *
 * This is the suggestion pool the tag picker offers. Derived client-side from
 * rows already loaded — the same thing `TagFilter` does with its counts (in
 * src/TagFilter.jsx), and for the same reason: there is no query worth adding
 * for a dozen strings that are already sitting in state.
 *
 * Frequency order, ties broken alphabetically. The tags you reach for most are
 * the ones worth putting under your thumb.
 *
 * DELIBERATELY DIFFERENT from `TagFilter` (src/TagFilter.jsx), which went
 * alphabetical on 2026-09-21. The two lists answer different questions: this
 * one offers a tag you have not named yet, where the common ones should come
 * first; that one helps you find a tag you already have in mind, where only
 * alphabetical lets you aim. If you are here to make them agree, read the note
 * in src/TagFilter.jsx first — the difference is the point.
 *
 * Items and intentions share one pool. Collections get their own in Phase 6 —
 * per-trip tags like "tjs" have no business being suggested on a recipe.
 *
 * Lived in src/Alfred.jsx until 2026-09-25, where nothing could import it and
 * so nothing tested it. Unchanged by the move: this is still a pure "count the
 * tags in these lists" helper with no opinion about what belongs in them. The
 * archived rule is `tagPoolForRecords` below.
 *
 * @param {...(Array|null|undefined)} recordLists - Lists of records with `tags`.
 * @returns {string[]} Tags, most-used first, ties alphabetical.
 */
export function tagPoolFrom(...recordLists) {
  const counts = new Map();
  for (const list of recordLists) {
    for (const record of list || []) {
      for (const tag of record?.tags || []) {
        if (typeof tag === "string" && tag) {
          counts.set(tag, (counts.get(tag) || 0) + 1);
        }
      }
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([tag]) => tag);
}

/**
 * The item/intention suggestion pool, with archived rows left out.
 *
 * ARCHIVED ROWS ARE EXCLUDED (§A6, 2026-09-21). They always were from the
 * filter BAR — each list filters them out before handing rows over — but the
 * pool was built from the raw state arrays, which hold every row the query
 * returned, archived included. So the picker kept offering tags that no living
 * record carried and no bar would ever show: `due`, `late`, `overdue`, `past`,
 * `urgent`, `test tag`, `another tag`, `outdoor maintenance`, `cleaning`.
 *
 * A tag carried by both an archived and a live row still appears — it is
 * counted from the live row only, so archiving can change its POSITION in the
 * list without removing it.
 *
 * Separate from `tagPoolFrom` rather than folded into it so the counting helper
 * keeps no opinion about what belongs in the lists it is given.
 *
 * @param {Array|null|undefined} items
 * @param {Array|null|undefined} intents
 * @returns {string[]} Tags on live rows, most-used first, ties alphabetical.
 */
export function tagPoolForRecords(items, intents) {
  const live = (list) => (Array.isArray(list) ? list : []).filter((r) => !r?.archived);
  return tagPoolFrom(live(items), live(intents));
}
