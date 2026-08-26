import {
  parseIngredient,
  matchProduct,
  findNearMisses,
} from "./ingredientMatch";

/**
 * Every fixture below is a real line from the Recipes context, except the three
 * worked examples the spec states directly. Invented cases were deliberately
 * avoided: the corpus already contains unicode fractions, en-dash ranges,
 * compound quantities, parentheticals and trailing preparation clauses.
 */

const CTX = "shopping-ctx";
const item = (id, name, extra = {}) => ({ id, name, contextId: CTX, ...extra });

// A slice of the real Shopping context, including its real duplicates and
// awkward names.
const SHOPPING = [
  item("i1", "Basil"),
  item("i2", "Smoked Gouda"),
  item("i3", "Limes"),
  item("i4", "Garlic"),
  item("i5", "Tomato"),
  item("i6", "Butter"),
  item("i7", "Olive Oil"),
  item("i8", "Green Lentils"),
  item("i9", "Chicken thighs"),
  item("i10", "Soda water"),
  item("i11", "Ginger ale"),
  item("i12", "Root Beer"),
  item("i13", "Red Wine Vinegar"),
  item("i14", "Green onion"),
  item("i15", "Eggs"),
  item("i16", "Yellow Onion"),
  item("i17", "Radish"),
  item("i18", "Peppers"),
  item("i19", "poblano"),
  item("i20", "Juice"),
  item("i21", "Lemon"),
  item("i22", "Cumin"),
];

describe("parseIngredient — the spec's worked examples", () => {
  it("splits quantity and unit from a leading preparation clause", () => {
    expect(parseIngredient("1/4 cup coarsely chopped fresh basil")).toEqual({
      quantity: "1/4 cup",
      product: "basil",
    });
  });

  it("keeps a product-defining modifier and drops a trailing preparation", () => {
    expect(parseIngredient("8 oz smoked Gouda, small dice")).toEqual({
      quantity: "8 oz",
      product: "smoked Gouda",
    });
  });

  it("handles a bare product with no quantity", () => {
    expect(parseIngredient("Salt")).toEqual({ quantity: "", product: "Salt" });
  });
});

describe("parseIngredient — cases named in the progress file", () => {
  it("handles an ASCII range", () => {
    expect(parseIngredient("2-3 dried chipotles")).toEqual({
      quantity: "2-3",
      product: "dried chipotles",
    });
  });

  it("drops a size word, a trailing unit and a trailing preparation", () => {
    expect(parseIngredient("1 small clove garlic, grated")).toEqual({
      quantity: "1",
      product: "garlic",
    });
  });

  it("leaves a conjoined line intact rather than guessing a split", () => {
    // This line should no longer exist in the data; if it reappears it must
    // survive unmangled rather than silently becoming "Salt" or "pepper".
    expect(parseIngredient("Salt and black pepper")).toEqual({
      quantity: "",
      product: "Salt and black pepper",
    });
  });
});

describe("parseIngredient — real corpus lines", () => {
  it("reads a unicode vulgar fraction as the quantity", () => {
    expect(parseIngredient("½ large onion, diced")).toEqual({
      quantity: "½",
      product: "onion",
    });
  });

  it("reads an en-dash range with a unit", () => {
    expect(parseIngredient("2–3 tbsp tomato paste")).toEqual({
      quantity: "2–3 tbsp",
      product: "tomato paste",
    });
  });

  it("reads a dual-unit quantity and strips a long parenthetical", () => {
    expect(
      parseIngredient(
        "750g / 1.5 lb cream cheese (blocks, room temp — Philadelphia or similar, NOT low fat)",
      ),
    ).toEqual({ quantity: "750g / 1.5 lb", product: "cream cheese" });
  });

  it("reads an additive quantity and strips a leading adverb-participle pair", () => {
    expect(
      parseIngredient(
        "3/4 cup + 1 tbsp lightly whisked eggs (~4-5 large eggs — must measure, 220g / 200ml)",
      ),
    ).toEqual({ quantity: "3/4 cup + 1 tbsp", product: "eggs" });
  });

  it("reads a mixed number", () => {
    expect(
      parseIngredient("1 1/4 cups whipping cream (must be whippable, NOT low fat)"),
    ).toEqual({ quantity: "1 1/4 cups", product: "whipping cream" });
  });

  it("reads a fraction-to-whole range", () => {
    expect(
      parseIngredient("½ - 1 cup unsalted or salted butter (European-style preferred)"),
    ).toEqual({ quantity: "½ - 1 cup", product: "unsalted or salted butter" });
  });

  it("moves a trailing unit noun out of the product", () => {
    expect(parseIngredient("3 garlic cloves, grated")).toEqual({
      quantity: "3",
      product: "garlic",
    });
  });

  it("keeps a trailing unit noun when it IS the product", () => {
    // "whole" cannot stand alone, so "cloves" must survive here even though it
    // is a unit word in "3 garlic cloves".
    expect(parseIngredient("3 whole cloves (dry toasted)")).toEqual({
      quantity: "3",
      product: "whole cloves",
    });
  });

  it("captures a trailing count rather than discarding it", () => {
    expect(parseIngredient("Limes x6")).toEqual({ quantity: "x6", product: "Limes" });
  });

  it("captures a trailing quantity with a unit", () => {
    expect(parseIngredient("Olive Oil 1 cup")).toEqual({
      quantity: "1 cup",
      product: "Olive Oil",
    });
  });

  it("drops a serving note", () => {
    expect(parseIngredient("Salt to taste")).toEqual({ quantity: "", product: "Salt" });
  });

  it("keeps a non-preparation trailing clause", () => {
    // "skin-on chicken thighs" is the product, not a preparation note.
    expect(parseIngredient("2 lbs bone-in, skin-on chicken thighs")).toEqual({
      quantity: "2 lbs",
      product: "bone-in, skin-on chicken thighs",
    });
  });

  it("does not mistake a multi-option list for a preparation clause", () => {
    expect(parseIngredient("5–6 cups chicken, beef, or mushroom stock")).toEqual({
      quantity: "5–6 cups",
      product: "chicken, beef, or mushroom stock",
    });
  });

  it("drops a compound trailing preparation", () => {
    expect(parseIngredient("2 tbsp pecans, toasted and finely chopped")).toEqual({
      quantity: "2 tbsp",
      product: "pecans",
    });
  });

  it("does not let the 'or' joiner run away with the product", () => {
    expect(parseIngredient("1 tsp vanilla bean extract or paste")).toEqual({
      quantity: "1 tsp",
      product: "vanilla bean extract or paste",
    });
  });

  it("handles a glued gram amount", () => {
    expect(parseIngredient("165g dark chocolate melts")).toEqual({
      quantity: "165g",
      product: "dark chocolate melts",
    });
  });
});

describe("parseIngredient — leading extraction phrases", () => {
  it("reads through 'Juice of' to the thing you actually buy", () => {
    // What you buy for "Juice of 3 limes" is limes, and the 3 is the quantity.
    expect(parseIngredient("Juice of 3 limes")).toEqual({
      quantity: "3",
      product: "limes",
    });
    expect(parseIngredient("Juice of 0.5 lemon")).toEqual({
      quantity: "0.5",
      product: "lemon",
    });
    expect(parseIngredient("Squeeze of lemon")).toEqual({
      quantity: "",
      product: "lemon",
    });
  });

  it("leaves a bare extraction word alone", () => {
    expect(parseIngredient("Juice").product).toBe("Juice");
  });

  it("does not touch a trailing use of the same word", () => {
    expect(parseIngredient("2 tbsp lemon juice").product).toBe("lemon juice");
  });
});

describe("parseIngredient — trailing purpose phrases", () => {
  it("drops a purpose clause that would mint a junk item", () => {
    // The same recipe also yields "salt" from "1/4 tsp salt"; without this the
    // two become separate items.
    expect(parseIngredient("Salt for the bean water (~1 tsp per quart)")).toEqual({
      quantity: "",
      product: "Salt",
    });
    expect(parseIngredient("Chili oil, for serving (optional)").product).toBe(
      "Chili oil",
    );
  });
});

describe("parseIngredient — degenerate input", () => {
  it.each([
    [null, { quantity: "", product: "" }],
    [undefined, { quantity: "", product: "" }],
    ["", { quantity: "", product: "" }],
    ["   ", { quantity: "", product: "" }],
  ])("returns empty for %p", (input, expected) => {
    expect(parseIngredient(input)).toEqual(expected);
  });

  it("treats a quantity-only line as the product rather than emptying it", () => {
    expect(parseIngredient("2 cans").product).toBe("2 cans");
  });
});

describe("matchProduct — tiers", () => {
  it("tier 1: exact name, case-insensitive", () => {
    expect(matchProduct("basil", SHOPPING, { contextId: CTX })).toMatchObject({ id: "i1" });
  });

  it("tier 2: ignores plurals", () => {
    expect(matchProduct("Tomatoes", SHOPPING, { contextId: CTX })).toMatchObject({ id: "i5" });
    expect(matchProduct("radishes", SHOPPING, { contextId: CTX })).toMatchObject({ id: "i17" });
  });

  it("tier 2: ignores punctuation and case", () => {
    expect(matchProduct("smoked gouda", SHOPPING, { contextId: CTX })).toMatchObject({ id: "i2" });
  });

  it("tier 3: item name contained in a more specific product", () => {
    // Both cover more than the final word, so neither is head-noun-only.
    expect(matchProduct("extra-virgin olive oil", SHOPPING, { contextId: CTX })).toMatchObject({ id: "i7" });
    expect(matchProduct("French green lentils", SHOPPING, { contextId: CTX })).toMatchObject({ id: "i8" });
  });

  it("tier 3: demotes a candidate matching only the product's final word", () => {
    // "Butter" for "unsalted butter" and "Peppers" for "black pepper" are
    // categories, not the product. They must not win by default; they are
    // offered as near-misses instead.
    expect(matchProduct("unsalted butter", SHOPPING, { contextId: CTX })).toBeNull();
    expect(matchProduct("black pepper", SHOPPING, { contextId: CTX })).toBeNull();
    expect(matchProduct("ground cumin", SHOPPING, { contextId: CTX })).toBeNull();
    expect(
      findNearMisses("black pepper", SHOPPING, { contextId: CTX }).map((i) => i.name),
    ).toContain("Peppers");
    expect(
      findNearMisses("ground cumin", SHOPPING, { contextId: CTX }).map((i) => i.name),
    ).toContain("Cumin");
  });

  it("tier 3: a candidate matching a non-final token still wins", () => {
    // The reported bug: "poblano peppers" resolved to Peppers even though
    // poblano exists. Both match by containment; the head-noun one is demoted,
    // so poblano wins.
    expect(matchProduct("poblano peppers", SHOPPING, { contextId: CTX })).toMatchObject({
      id: "i19",
    });
  });

  it("a single-word product is never head-noun-only", () => {
    // Demotion only applies to multi-word products; "Limes" must still match.
    expect(matchProduct("limes", SHOPPING, { contextId: CTX })).toMatchObject({ id: "i3" });
  });

  it("returns null when nothing matches", () => {
    expect(matchProduct("peppermint extract", SHOPPING, { contextId: CTX })).toBeNull();
  });
});

describe("matchProduct — precision guards", () => {
  it("does not match a bare product onto a more specific item", () => {
    // The regression that matters: a recipe asking for water must not silently
    // put Soda water on the shopping list.
    expect(matchProduct("Water", SHOPPING, { contextId: CTX })).toBeNull();
    expect(matchProduct("ginger", SHOPPING, { contextId: CTX })).toBeNull();
    expect(matchProduct("beer", SHOPPING, { contextId: CTX })).toBeNull();
    expect(matchProduct("red wine", SHOPPING, { contextId: CTX })).toBeNull();
    expect(matchProduct("onion", SHOPPING, { contextId: CTX })).toBeNull();
  });

  it("requires the head noun to be shared", () => {
    // "chicken stock" must not collapse onto "Chicken thighs".
    expect(matchProduct("chicken stock", SHOPPING, { contextId: CTX })).toBeNull();
  });
});

describe("matchProduct — scoping", () => {
  it("ignores items from another context", () => {
    expect(matchProduct("basil", SHOPPING, { contextId: "other-ctx" })).toBeNull();
  });

  it("ignores archived items", () => {
    const archived = [item("a1", "Saffron", { archived: true })];
    expect(matchProduct("Saffron", archived, { contextId: CTX })).toBeNull();
  });

  it("reads a snake_case context key too", () => {
    const snake = [{ id: "s1", name: "Basil", context_id: CTX }];
    expect(matchProduct("basil", snake, { contextId: CTX })).toMatchObject({ id: "s1" });
  });

  it("searches every context when none is given", () => {
    expect(matchProduct("basil", SHOPPING)).toMatchObject({ id: "i1" });
  });

  it.each([
    ["empty product", "", SHOPPING],
    ["null product", null, SHOPPING],
    ["non-array items", "basil", null],
    ["empty items", "basil", []],
  ])("returns null for %s", (_label, product, items) => {
    expect(matchProduct(product, items, { contextId: CTX })).toBeNull();
  });

  it("prefers the more specific item when several could contain the head", () => {
    const pool = [item("p1", "Onion"), item("p2", "Yellow Onion")];
    expect(matchProduct("yellow onions", pool, { contextId: CTX })).toMatchObject({ id: "p2" });
  });
});

describe("findNearMisses — the candidates matching rejected", () => {
  it("surfaces the item that directional matching refused", () => {
    // matchProduct returns null for "Water"; the user should still see it.
    expect(matchProduct("Water", SHOPPING, { contextId: CTX })).toBeNull();
    const near = findNearMisses("Water", SHOPPING, { contextId: CTX });
    expect(near.map((i) => i.name)).toContain("Soda water");
  });

  it("ranks the generic name above the more specific one", () => {
    // The whole point: consolidate onto "Salt" instead of minting a third item.
    const pool = [
      { id: "s1", name: "Sea salt", contextId: CTX },
      { id: "s2", name: "Salt", contextId: CTX },
    ];
    const near = findNearMisses("kosher salt", pool, { contextId: CTX });
    expect(near.map((i) => i.name)).toEqual(["Salt", "Sea salt"]);
  });

  it("requires the head noun, so it is not a keyword search", () => {
    // "Chocolate bar" shares "chocolate" but not the head "melt".
    const pool = [{ id: "c1", name: "Chocolate bar", contextId: CTX }];
    expect(findNearMisses("dark chocolate melts", pool, { contextId: CTX })).toEqual([]);
  });

  it("never suggests the item already matched", () => {
    const match = matchProduct("French green lentils", SHOPPING, { contextId: CTX });
    const near = findNearMisses("French green lentils", SHOPPING, {
      contextId: CTX,
      exclude: match.id,
    });
    expect(near.map((i) => i.id)).not.toContain(match.id);
  });

  it("deduplicates by name, because the real catalogue has duplicates", () => {
    const pool = [
      { id: "d1", name: "Banana", contextId: CTX },
      { id: "d2", name: "Banana", contextId: CTX },
      { id: "d3", name: "Banana bread", contextId: CTX },
    ];
    const near = findNearMisses("frozen banana", pool, { contextId: CTX });
    expect(near.filter((i) => i.name === "Banana")).toHaveLength(1);
  });

  it("caps the list", () => {
    const pool = [
      { id: "p1", name: "Green onion", contextId: CTX },
      { id: "p2", name: "Red onion", contextId: CTX },
      { id: "p3", name: "Purple onion", contextId: CTX },
      { id: "p4", name: "Sweet onion", contextId: CTX },
    ];
    expect(findNearMisses("onion", pool, { contextId: CTX })).toHaveLength(3);
    expect(findNearMisses("onion", pool, { contextId: CTX, limit: 2 })).toHaveLength(2);
  });

  it("respects context scoping and degenerate input", () => {
    expect(findNearMisses("Water", SHOPPING, { contextId: "other" })).toEqual([]);
    expect(findNearMisses("", SHOPPING, { contextId: CTX })).toEqual([]);
    expect(findNearMisses(null, SHOPPING, { contextId: CTX })).toEqual([]);
    expect(findNearMisses("Water", null, { contextId: CTX })).toEqual([]);
    expect(findNearMisses("Water", SHOPPING, { contextId: CTX, limit: 0 })).toEqual([]);
  });
});
