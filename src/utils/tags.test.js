import {
  normaliseTag,
  normaliseTags,
  MAX_TAG_LENGTH,
  MAX_TAGS,
} from "./tags";

describe("normaliseTag", () => {
  test("lowercases", () => {
    expect(normaliseTag("Groceries")).toBe("groceries");
    expect(normaliseTag("WHOLE FOODS")).toBe("whole foods");
  });

  test("spaces are legal and survive — the point of the change", () => {
    expect(normaliseTag("Whole Foods")).toBe("whole foods");
    expect(normaliseTag("trader joes run")).toBe("trader joes run");
  });

  test("apostrophes vanish rather than becoming a space", () => {
    // "tj s" would be wrong, and is what a naive punctuation-to-space rule gives.
    expect(normaliseTag("tj's")).toBe("tjs");
    expect(normaliseTag("TJ's")).toBe("tjs");
    expect(normaliseTag("Trader Joe's")).toBe("trader joes");
  });

  test("the typographic apostrophe a phone inserts is handled too", () => {
    expect(normaliseTag("TJ’s")).toBe("tjs");
    expect(normaliseTag("Trader Joe’s")).toBe("trader joes");
  });

  test("underscores become spaces, so the legacy form and the new one agree", () => {
    expect(normaliseTag("stir_fry")).toBe("stir fry");
    expect(normaliseTag("nervous_system")).toBe("nervous system");
    expect(normaliseTag("stir_fry")).toBe(normaliseTag("Stir Fry"));
  });

  test("hyphens become spaces, exactly as underscores do", () => {
    // Amended after Phase 2. Hyphens used to survive into storage, which left
    // "stir-fry" beside "stir fry" as a separate tag forever.
    expect(normaliseTag("stir-fry")).toBe("stir fry");
    expect(normaliseTag("whole-foods")).toBe("whole foods");
    expect(normaliseTag("Gluten-Free")).toBe("gluten free");
    expect(normaliseTag("e-bike")).toBe("e bike");
  });

  test("hyphen, underscore and space spellings converge on one tag", () => {
    // The whole point: one canonical spelling, whoever or whatever wrote it.
    const expected = "stir fry";
    expect(normaliseTag("stir-fry")).toBe(expected);
    expect(normaliseTag("stir_fry")).toBe(expected);
    expect(normaliseTag("stir fry")).toBe(expected);
    expect(normaliseTag("Stir-Fry")).toBe(expected);
    expect(normaliseTag("STIR_FRY")).toBe(expected);
  });

  test("a leading or trailing hyphen leaves no stray space", () => {
    expect(normaliseTag("-leading")).toBe("leading");
    expect(normaliseTag("trailing-")).toBe("trailing");
    expect(normaliseTag("-both-")).toBe("both");
    expect(normaliseTag("_under_")).toBe("under");
    expect(normaliseTag("- - -")).toBeNull();
  });

  test("other punctuation becomes a space", () => {
    expect(normaliseTag("home/garden")).toBe("home garden");
    expect(normaliseTag("dinner: friday")).toBe("dinner friday");
    expect(normaliseTag("50% off!")).toBe("50 off");
  });

  test("whitespace is collapsed and trimmed", () => {
    expect(normaliseTag("  whole   foods  ")).toBe("whole foods");
    expect(normaliseTag("whole\tfoods")).toBe("whole foods");
    expect(normaliseTag("whole\nfoods")).toBe("whole foods");
  });

  test("punctuation does not leave a double space behind", () => {
    expect(normaliseTag("a , b")).toBe("a b");
    expect(normaliseTag("a---b")).toBe("a b"); // three hyphens, one space
    expect(normaliseTag("a_-_b")).toBe("a b");
    expect(normaliseTag("a !!! b")).toBe("a b");
  });

  test("accented letters survive", () => {
    // Migration A preserves them, so the normaliser must be able to reproduce
    // a migrated tag from what the user types.
    expect(normaliseTag("Café")).toBe("café");
    expect(normaliseTag("Jalapeño")).toBe("jalapeño");
  });

  test("digits survive", () => {
    expect(normaliseTag("Aisle 7")).toBe("aisle 7");
    expect(normaliseTag("2026")).toBe("2026");
  });

  test("returns null for anything that does not survive", () => {
    expect(normaliseTag("")).toBeNull();
    expect(normaliseTag("   ")).toBeNull();
    expect(normaliseTag("!!!")).toBeNull();
    expect(normaliseTag("___")).toBeNull();
    expect(normaliseTag("'")).toBeNull();
  });

  test("non-strings are rejected, not coerced", () => {
    expect(normaliseTag(null)).toBeNull();
    expect(normaliseTag(undefined)).toBeNull();
    expect(normaliseTag(42)).toBeNull();
    expect(normaliseTag(["a"])).toBeNull();
    expect(normaliseTag({})).toBeNull();
    expect(() => normaliseTag(Symbol("x"))).not.toThrow();
  });

  test("length is capped at 50, measured after normalising", () => {
    const fifty = "a".repeat(MAX_TAG_LENGTH);
    expect(MAX_TAG_LENGTH).toBe(50);
    expect(normaliseTag(fifty)).toBe(fifty);
    expect(normaliseTag("a".repeat(MAX_TAG_LENGTH + 1))).toBeNull();
    // Normalising can bring an over-length string back under the cap.
    expect(normaliseTag(`  ${fifty}  `)).toBe(fifty);
  });

  test("is idempotent — the property the dirty-checks depend on", () => {
    // Alfred's four unsaved-changes checks compare stored tags with
    // JSON.stringify. They stay correct only if normalising an already
    // normalised tag is a no-op, so a saved record reloads byte-identical.
    const inputs = [
      "Whole Foods", "TJ's", "stir_fry", "gluten-free",
      "home/garden", "  spaced  out  ", "Café", "Aisle 7",
    ];
    for (const raw of inputs) {
      const once = normaliseTag(raw);
      expect(normaliseTag(once)).toBe(once);
    }
  });
});

describe("normaliseTags", () => {
  test("normalises every entry", () => {
    expect(normaliseTags(["Whole Foods", "TJ's", "stir_fry"])).toEqual([
      "whole foods",
      "tjs",
      "stir fry",
    ]);
  });

  test("drops entries that do not survive", () => {
    expect(normaliseTags(["ok", "", "   ", "!!!", null, 42, "fine"])).toEqual([
      "ok",
      "fine",
    ]);
  });

  test("deduplicates, first occurrence wins and keeps its position", () => {
    expect(normaliseTags(["b", "a", "B", "A", "b"])).toEqual(["b", "a"]);
  });

  test("deduplicates entries that only collide after normalising", () => {
    // The underscore and hyphen conversions are what make these one tag.
    expect(
      normaliseTags(["stir_fry", "Stir Fry", "STIR_FRY", "stir-fry", "Stir-Fry"]),
    ).toEqual(["stir fry"]);
  });

  test("caps at 20, applied after deduplication", () => {
    expect(MAX_TAGS).toBe(20);

    const many = Array.from({ length: 30 }, (_, i) => `tag ${i}`);
    expect(normaliseTags(many)).toHaveLength(MAX_TAGS);
    expect(normaliseTags(many)[0]).toBe("tag 0");
    expect(normaliseTags(many)[MAX_TAGS - 1]).toBe("tag 19");

    // 25 entries that collapse to 8 distinct tags give 8, not a truncation.
    const dupes = Array.from({ length: 25 }, (_, i) => `tag ${i % 8}`);
    expect(normaliseTags(dupes)).toHaveLength(8);
  });

  test("non-arrays give an empty array", () => {
    expect(normaliseTags(null)).toEqual([]);
    expect(normaliseTags(undefined)).toEqual([]);
    expect(normaliseTags("whole foods")).toEqual([]);
    expect(normaliseTags({})).toEqual([]);
  });

  test("empty array in, empty array out", () => {
    expect(normaliseTags([])).toEqual([]);
  });

  test("is idempotent", () => {
    const once = normaliseTags(["Whole Foods", "TJ's", "stir_fry", "bad!!"]);
    expect(normaliseTags(once)).toEqual(once);
  });

  test("never returns a duplicate, whatever goes in", () => {
    const out = normaliseTags(["a", "A", "a ", " a", "a_", "_a", "a!"]);
    expect(new Set(out).size).toBe(out.length);
  });
});
