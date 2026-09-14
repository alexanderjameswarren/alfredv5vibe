/**
 * The canonical tag rule — Deno side.
 *
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  TWIN FILE: src/utils/tags.js                                            ║
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
 * ║  about to edit the rule: open src/utils/tags.js now, in the other        ║
 * ║  window, and edit both before you run anything.                          ║
 * ║                                                                          ║
 * ║  The behaviour is pinned on the browser side by src/utils/tags.test.js.  ║
 * ║  Port any new case there to here as well.                                ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ─── Why this exists at all ──────────────────────────────────────────────────
 *
 * `ai-enrich` asks a model for suggested tags and used to write whatever came
 * back straight to `inbox.suggested_tags`. Those values flow into `items.tags`
 * and `intents.tags` verbatim on triage if the user never opens the tag box —
 * so the model was the one write path that could put a NON-CANONICAL tag into
 * the database, with nothing validating it.
 *
 * That matters because four "you have unsaved changes" checks in Alfred.jsx
 * compare tags exactly as stored, with `JSON.stringify`. They are correct only
 * while every stored tag is already canonical. A record holding "Whole Foods"
 * would load, compare unequal against the normalised form the UI produces, and
 * report itself permanently edited — blocking navigation with a prompt about a
 * change nobody made. See technical-spec-tags.md §4.
 *
 * Prompt wording alone does not fix this. A model asked for lowercase tags will
 * still occasionally return capitals, and once spaces became legal it will
 * return punctuation too. The instructions were updated as well, but the
 * normaliser is what makes it true.
 *
 * ─── Normalise on WRITE, never on LOAD ───────────────────────────────────────
 *
 * Call this when a tag is about to be STORED. Never when a record is read.
 * Normalising on load would reintroduce exactly the mismatch described above,
 * because state and database would then disagree for any legacy row.
 *
 * ─── Unicode ────────────────────────────────────────────────────────────────
 *
 * "Letter" and "digit" mean `\p{L}` and `\p{N}`, not `[a-z0-9]`, so "Café"
 * normalises to "café" rather than "caf". Migration A preserves accented
 * characters (it only lowercases and swaps underscores), so an ASCII-only rule
 * would leave migrated tags that could never be reproduced by typing them.
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
 * the AI write paths never touch the picker, and THIS FILE IS THOSE PATHS, so a
 * model returning "stir-fry" created the duplicate anyway. Folding here means
 * there is exactly one canonical spelling of any multi-word tag.
 *
 * A leading or trailing hyphen leaves no stray space: the collapse-and-trim in
 * step 5 runs after this.
 *
 * @param raw Anything. Non-strings are rejected rather than coerced.
 * @returns The canonical tag, or null if nothing survived.
 */
export function normaliseTag(raw: unknown): string | null {
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
 * Order is preserved and first-occurrence wins. The cap is applied AFTER
 * deduplication — twenty-five entries that collapse to eight tags give eight,
 * not a truncated mess.
 *
 * @param rawList Anything. A non-array gives [].
 * @returns Canonical, deduplicated, at most MAX_TAGS long.
 */
export function normaliseTags(rawList: unknown): string[] {
  if (!Array.isArray(rawList)) return [];

  const out: string[] = [];
  const seen = new Set<string>();

  for (const raw of rawList) {
    const tag = normaliseTag(raw);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }

  return out;
}
