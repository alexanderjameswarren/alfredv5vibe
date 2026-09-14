// Tests for the loose matcher. Deliberately a separate file from
// search.test.js, which pins matchesQuery's significant-whitespace rule and is
// not touched by this project.

import { matchesLoosely, foldText, matchesQuery } from "./search";

describe("foldText", () => {
  test("lowercases, drops punctuation, collapses whitespace", () => {
    expect(foldText("Kosher Salt")).toBe("kosher salt");
    expect(foldText("extra-virgin olive oil")).toBe("extra virgin olive oil");
    expect(foldText("  a  ,  b  ")).toBe("a b");
  });

  test("keeps word boundaries as single spaces", () => {
    // ingredientMatch splits the result on " " to tokenise, so this is
    // load-bearing there and must not become foldTight's behaviour.
    expect(foldText("whole foods").split(" ")).toEqual(["whole", "foods"]);
  });

  test("non-strings fold to an empty string rather than throwing", () => {
    expect(foldText(null)).toBe("");
    expect(foldText(undefined)).toBe("");
    expect(foldText("")).toBe("");
  });

  test("is ASCII-only, preserving ingredientMatch's existing behaviour", () => {
    // Deliberate, and different from normaliseTag, which is Unicode-aware.
    // Documented in both files.
    expect(foldText("café")).toBe("caf");
  });
});

describe("matchesLoosely", () => {
  test("ignores case", () => {
    expect(matchesLoosely("TJS", "tjs")).toBe(true);
    expect(matchesLoosely("tjs", "TJS")).toBe(true);
  });

  test("ignores punctuation on either side", () => {
    expect(matchesLoosely("TJ's", "tjs")).toBe(true);
    expect(matchesLoosely("tj-s", "tjs")).toBe(true);
    expect(matchesLoosely("tjs", "TJ's")).toBe(true);
  });

  test("ignores spacing — the case matchesQuery cannot do", () => {
    expect(matchesLoosely("wholefoods", "whole foods")).toBe(true);
    expect(matchesLoosely("whole foods", "wholefoods")).toBe(true);
    expect(matchesLoosely("whole_foods", "whole-foods")).toBe(true);

    // The same query against the strict matcher, for contrast.
    expect(matchesQuery("wholefoods", "whole foods")).toBe(false);
  });

  test("still a substring match, not a fuzzy one", () => {
    expect(matchesLoosely("foods", "whole foods")).toBe(true);
    expect(matchesLoosely("whl", "whole foods")).toBe(false);
    expect(matchesLoosely("pepper", "kosher salt")).toBe(false);
  });

  test("empty, whitespace-only and non-string queries match everything", () => {
    expect(matchesLoosely("", "anything")).toBe(true);
    expect(matchesLoosely("   ", "anything")).toBe(true);
    expect(matchesLoosely(null, "anything")).toBe(true);
    expect(matchesLoosely(undefined, "anything")).toBe(true);
    expect(matchesLoosely(42, "anything")).toBe(true);
  });

  test("a query that is nothing but punctuation matches everything", () => {
    // It folds to empty, and is indistinguishable from an empty box.
    expect(matchesLoosely("!!!", "anything")).toBe(true);
    expect(matchesLoosely("-", "anything")).toBe(true);
  });

  test("matches if any field matches", () => {
    expect(matchesLoosely("tjs", "groceries", null, "TJ's")).toBe(true);
    expect(matchesLoosely("tjs", "groceries", "produce")).toBe(false);
  });

  test("non-string fields are skipped, not thrown on", () => {
    expect(() => matchesLoosely("a", null, undefined, 42, {}, [])).not.toThrow();
    expect(matchesLoosely("42", 42)).toBe(false);
    expect(matchesLoosely("a", null, undefined)).toBe(false);
  });

  test("no fields with a real query matches nothing", () => {
    expect(matchesLoosely("a")).toBe(false);
  });

  test("the tag cases this exists for", () => {
    const pool = ["tjs", "whole foods", "gluten-free", "trader joes"];
    const find = (q) => pool.filter((t) => matchesLoosely(q, t));

    expect(find("tj")).toEqual(["tjs"]);
    expect(find("TJ's")).toEqual(["tjs"]);
    expect(find("wholefoods")).toEqual(["whole foods"]);
    expect(find("WHOLE")).toEqual(["whole foods"]);
    expect(find("glutenfree")).toEqual(["gluten-free"]);
    expect(find("joes")).toEqual(["trader joes"]);
    expect(find("zzz")).toEqual([]);
  });
});

describe("matchesQuery is unchanged", () => {
  // Guard rather than duplication: the project must not widen the strict
  // matcher, and this fails loudly if someone does.
  test("inner whitespace is still significant", () => {
    expect(matchesQuery("kosher salt", "Kosher Salt")).toBe(true);
    expect(matchesQuery("kosher  salt", "Kosher Salt")).toBe(false);
  });

  test("punctuation is still significant", () => {
    expect(matchesQuery("tjs", "TJ's")).toBe(false);
  });
});
