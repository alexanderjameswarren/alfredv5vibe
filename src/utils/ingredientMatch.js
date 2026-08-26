/**
 * Ingredient line parsing and product-to-item matching.
 *
 * Pure functions — no side effects, no app imports, no React. Everything here
 * is driven by the real corpus in the Recipes context (473 collectable
 * elements across 34 items), not by invented examples.
 *
 * Two exports:
 *   parseIngredient(line)             -> { quantity, product }
 *   matchProduct(product, items, {})  -> item | null
 *
 * Both are deliberately conservative: when a rule does not clearly apply, the
 * original text survives. A wrong product name is visible to the user on the
 * Add to Collection page and can be corrected there; silently mangled text is
 * not.
 */

// Unicode vulgar fractions. The corpus only uses ¼ and ½, but the whole block
// is covered so a new recipe cannot introduce an unhandled one.
const UNICODE_FRACTION = "¼-¾⅐-⅞";

/**
 * Measurement words. A unit is only consumed once a number has been seen, so a
 * product that happens to share a name with a unit ("Bay leaves") is safe.
 */
const UNITS = new Set([
  "tsp", "tsps", "teaspoon", "teaspoons",
  "tbsp", "tbsps", "tablespoon", "tablespoons",
  "cup", "cups", "oz", "ounce", "ounces",
  "lb", "lbs", "pound", "pounds",
  "g", "gram", "grams", "kg", "kilogram", "kilograms",
  "ml", "l", "liter", "liters", "litre", "litres",
  "quart", "quarts", "pint", "pints", "gallon", "gallons",
  "clove", "cloves", "sprig", "sprigs", "stalk", "stalks",
  "bunch", "bunches", "head", "heads", "block", "blocks",
  "can", "cans", "jar", "jars", "package", "packages", "packet", "packets",
  "container", "containers", "box", "boxes", "bag", "bags",
  "slice", "slices", "piece", "pieces", "pinch", "pinches",
  "dash", "dashes", "handful", "handfuls", "stick", "sticks",
]);

/** Joiners inside a compound quantity: "750g / 1.5 lb", "2-3 tbsp", "1/2 - 1 cup". */
const JOINERS = new Set(["-", "–", "—", "/", "+", "~", "to", "or"]);

/** Manner adverbs that only ever qualify a preparation verb. */
const ADVERBS = new Set([
  "coarsely", "finely", "roughly", "thinly", "thickly", "freshly",
  "lightly", "well", "very", "loosely", "firmly", "evenly",
]);

/** Size words. Not product-defining: "1 small clove garlic" is still garlic. */
const SIZE_WORDS = new Set(["small", "medium", "large", "extra", "jumbo", "baby"]);

/**
 * Preparation participles. Stripped from the front of a product and used to
 * recognise a trailing preparation clause.
 *
 * Deliberately excludes product-defining modifiers — "smoked", "dried",
 * "ground", "roasted", "salted", "unsalted" — because smoked Gouda is a
 * different thing to buy than Gouda, and the spec's own worked example keeps
 * "smoked Gouda" intact.
 */
const PREP_WORDS = new Set([
  "chopped", "diced", "dice", "minced", "grated", "sliced", "crushed",
  "rinsed", "peeled", "torn", "shredded", "cubed", "julienned",
  "smashed", "stemmed", "seeded", "trimmed", "drained", "halved",
  "quartered", "crumbled", "husked", "juiced", "zested", "whisked",
  "beaten", "melted", "softened", "divided", "optional", "cut",
  "soaked", "bloomed", "rehydrated", "added", "plus", "dry", "toasted",
  "picked", "pitted", "deveined", "scrubbed", "washed", "cleaned",
]);

/**
 * Words that cannot stand alone as a product. Guards the trailing-unit strip:
 * "3 garlic cloves" -> "garlic", but "3 whole cloves" must stay "whole cloves"
 * because "whole" is not a thing you can buy.
 */
const MODIFIER_ONLY = new Set([
  "whole", "fresh", "dried", "ground", "raw", "cooked", "frozen", "canned",
  "black", "white", "red", "green", "yellow", "brown", "hot", "sweet", "sour",
]);

/** Tokens ignored when comparing a product to an item name. */
const STOPWORDS = new Set(["of", "the", "a", "an", "and", "or", "with", "in", "for"]);

const TOKEN_RE = new RegExp(
  "([" + UNICODE_FRACTION + "])" +
    "|(\\d+(?:\\.\\d+)?(?:\\/\\d+)?)" +
    "|([A-Za-z][A-Za-z'’-]*)" +
    "|(\\S)",
  "g",
);

function tokenize(text) {
  const out = [];
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(text)) !== null) {
    out.push({
      text: m[0],
      index: m.index,
      isNumber: Boolean(m[1]) || Boolean(m[2]),
      isWord: Boolean(m[3]),
    });
  }
  return out;
}

function collapse(s) {
  return s.replace(/\s+/g, " ").trim();
}

/** Strip parentheticals, including an unclosed trailing one. */
function stripParentheticals(s) {
  let out = s;
  let prev;
  do {
    prev = out;
    out = out.replace(/\([^()]*\)/g, " ");
  } while (out !== prev);
  return collapse(out.replace(/\([^()]*$/, " "));
}

/**
 * Does a trailing comma clause describe preparation rather than the product?
 *
 * Leading adverbs and size words are peeled off first, so "small dice" and
 * "thinly sliced" both resolve to a preparation word, while "skin-on chicken
 * thighs" and "or mushroom stock" do not and are therefore kept.
 */
function isPreparationClause(clause) {
  const words = collapse(clause.replace(/[-–—]/g, " "))
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
  let i = 0;
  while (
    i < words.length &&
    (ADVERBS.has(words[i]) || SIZE_WORDS.has(words[i]) || words[i].endsWith("ly"))
  ) {
    i += 1;
  }
  if (i >= words.length) return false;
  return PREP_WORDS.has(words[i]);
}

function stripTrailingPreparation(s) {
  let out = s;
  for (;;) {
    const comma = out.lastIndexOf(",");
    if (comma === -1) break;
    const clause = out.slice(comma + 1);
    if (!clause.trim() || isPreparationClause(clause)) {
      out = out.slice(0, comma).trim();
      continue;
    }
    break;
  }
  return out;
}

/**
 * Peel preparation words, adverbs, size words and stray unit nouns off the
 * front. Reverts entirely if it would consume the whole string.
 */
function stripLeadingModifiers(s) {
  const tokens = collapse(s).split(" ").filter(Boolean);
  const strippable = (w) =>
    ADVERBS.has(w) || SIZE_WORDS.has(w) || PREP_WORDS.has(w) ||
    UNITS.has(w) || w === "fresh" || w === "of";

  let i = 0;
  while (i < tokens.length) {
    const w = tokens[i].toLowerCase().replace(/[.,]$/, "");
    if (strippable(w)) {
      i += 1;
      continue;
    }
    // Any -ly adverb qualifying a preparation word, so the vocabulary does not
    // need to enumerate them: "diagonally sliced celery" -> "celery".
    const next = (tokens[i + 1] || "").toLowerCase().replace(/[.,]$/, "");
    if (w.endsWith("ly") && next && (strippable(next) || next.endsWith("ly"))) {
      i += 1;
      continue;
    }
    break;
  }
  const rest = tokens.slice(i).join(" ");
  return rest || collapse(s);
}

/**
 * Remove a trailing quantity that the writer put after the product, as the
 * Shopping-style lines do: "Limes x6", "Olive Oil 1 cup", "cinnamon stick, ~1g".
 */
function stripTrailingQuantity(s) {
  let out = s;
  let captured = "";
  let prev;
  do {
    prev = out;
    const x = out.match(/[,\s]+(x\s*\d+)\s*$/i);
    if (x) {
      captured = captured || x[1];
      out = out.slice(0, x.index).trim();
    }
    const tilde = out.match(/[,\s]+(~\s*\d+(?:\.\d+)?\s*[a-z]*)\s*$/i);
    if (tilde) {
      captured = captured || tilde[1];
      out = out.slice(0, tilde.index).trim();
    }
    const m = out.match(/[,\s]+(\d+(?:\.\d+)?(?:\/\d+)?)\s*([a-z]+)?\s*$/i);
    if (m) {
      const unit = (m[2] || "").toLowerCase();
      if (!m[2] || UNITS.has(unit)) {
        captured = captured || collapse(m[0]);
        out = out.slice(0, m.index).trim();
      }
    }
  } while (out !== prev && out);
  return out ? { text: out, captured } : { text: s, captured: "" };
}

/**
 * Remove a trailing purpose phrase: "Salt for the bean water" -> "Salt".
 *
 * Without this the same recipe mints "Salt for the bean water" as a new item
 * alongside "salt" from another of its own lines — exactly the catalogue
 * pollution the picker exists to prevent.
 */
function stripTrailingPurpose(s) {
  const out = s.replace(/\s+for\s+\S.*$/i, "").trim();
  return out || s;
}

/** Remove a trailing "to taste" / "to cover" style serving note. */
function stripTrailingToClause(s) {
  const out = s.replace(/[,\s]+to\s+[a-z]+\s*$/i, "").trim();
  return out || s;
}

/**
 * "3 garlic cloves" reads as "3 cloves of garlic" — the unit trails the
 * product. Strip it only when what remains can stand alone as a product.
 */
function stripTrailingUnitNoun(s) {
  const tokens = collapse(s).split(" ").filter(Boolean);
  if (tokens.length < 2) return s;
  const last = tokens[tokens.length - 1].toLowerCase().replace(/[.,]$/, "");
  if (!UNITS.has(last)) return s;
  const rest = tokens.slice(0, -1);
  const meaningful = rest.some((t) => {
    const w = t.toLowerCase();
    return !MODIFIER_ONLY.has(w) && !SIZE_WORDS.has(w) && !ADVERBS.has(w);
  });
  return meaningful ? rest.join(" ") : s;
}

/**
 * Strip a leading extraction phrase: "Juice of 3 limes" -> "3 limes".
 *
 * These name a *process applied to* the product, not the product. What you buy
 * for "Juice of 3 limes" is limes. Removed before quantity extraction so the
 * "3" is still read as the quantity.
 */
function stripLeadingExtraction(s) {
  const out = s.replace(
    /^\s*(?:juice|zest|squeeze|splash|pinch|handful|dash|drizzle|grating)\s+of\s+/i,
    "",
  );
  return out.trim() || s;
}

/**
 * Split an ingredient line into a free-text quantity and a product name.
 *
 * Capitalisation of the product is preserved; only the comparison inside
 * matchProduct is case-insensitive.
 *
 * @param {string} line - e.g. "1/4 cup coarsely chopped fresh basil"
 * @returns {{quantity: string, product: string}}
 */
export function parseIngredient(line) {
  if (typeof line !== "string" || !line.trim()) return { quantity: "", product: "" };
  const src = stripLeadingExtraction(line.replace(/ /g, " "));
  const tokens = tokenize(src);

  let i = 0;
  let sawNumber = false;
  while (i < tokens.length) {
    const t = tokens[i];
    const w = t.text.toLowerCase();
    if (t.isNumber) {
      sawNumber = true;
      i += 1;
      continue;
    }
    if (sawNumber && t.isWord && UNITS.has(w)) {
      i += 1;
      continue;
    }
    // A joiner only counts when a number follows it, so the "or" in
    // "vanilla bean extract or paste" cannot run away with the product.
    if (sawNumber && JOINERS.has(w) && tokens[i + 1] && tokens[i + 1].isNumber) {
      i += 1;
      continue;
    }
    break;
  }

  const cut = i < tokens.length ? tokens[i].index : src.length;
  let quantity = collapse(src.slice(0, cut))
    .replace(/[-–—/+~]$/, "")
    .trim();
  let product = src.slice(cut);

  // Nothing but a quantity ("2 cans") — treat the whole line as the product.
  if (!collapse(product)) return { quantity: "", product: collapse(src) };

  product = stripParentheticals(product);
  product = stripTrailingPreparation(product);
  const trailing = stripTrailingQuantity(product);
  product = trailing.text;
  // "Limes x6" and "Olive Oil 1 cup" put the amount after the product. Keep it
  // rather than dropping it, but never let it override a leading quantity.
  if (!quantity && trailing.captured) quantity = trailing.captured;
  product = stripTrailingPurpose(product);
  product = stripTrailingToClause(product);
  product = stripTrailingPreparation(product);
  product = stripLeadingModifiers(product);
  product = stripTrailingUnitNoun(product);
  product = collapse(product).replace(/[.,;:]+$/, "").trim();

  return { quantity, product: product || collapse(src) };
}

/** Lowercase, drop punctuation, collapse whitespace. */
function normalize(s) {
  return collapse(String(s || "").toLowerCase().replace(/[^a-z0-9\s]/g, " "));
}

/** Crude but sufficient English singulariser for grocery nouns. */
function singularize(word) {
  if (word.length <= 3) return word;
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (/(ch|sh|s|x|z)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("oes")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function keyOf(s) {
  return normalize(s).split(" ").filter(Boolean).map(singularize).join(" ");
}

function contentTokens(s) {
  return normalize(s)
    .split(" ")
    .filter((t) => t && !STOPWORDS.has(t))
    .map(singularize);
}

/** Non-archived items, optionally narrowed to one context. Shared by both exports. */
function candidatePool(items, opts = {}) {
  const { contextId } = opts;
  if (!Array.isArray(items)) return [];
  return items.filter((it) => {
    if (!it || !it.name) return false;
    if (it.archived) return false;
    if (contextId != null) {
      const owner = it.contextId != null ? it.contextId : it.context_id;
      if (owner !== contextId) return false;
    }
    return true;
  });
}

/**
 * Match a product string to an item, preferring the most exact hit.
 *
 * Tiers, in order — first hit wins:
 *   1. case-insensitive exact name match
 *   2. normalised match ignoring plurals and punctuation
 *   3. token containment: the item name's content tokens are a subset of the
 *      product's AND the product's head noun is shared
 *
 * Tier 3 requires the head noun so that "chicken stock" does not collapse onto
 * an item called "Chicken".
 *
 * @param {string} product - product name from parseIngredient
 * @param {Array<{id: string, name: string, contextId?: string, archived?: boolean}>} items
 * @param {{contextId?: string}} [opts] - when given, only items in this context match
 * @returns {object|null} the matched item, or null
 */
export function matchProduct(product, items, opts = {}) {
  const query = String(product || "").trim();
  if (!query || !Array.isArray(items)) return null;

  const pool = candidatePool(items, opts);
  if (!pool.length) return null;

  const lower = query.toLowerCase();
  const exact = pool.find((it) => it.name.trim().toLowerCase() === lower);
  if (exact) return exact;

  const qKey = keyOf(query);
  if (qKey) {
    const normalized = pool.find((it) => keyOf(it.name) === qKey);
    if (normalized) return normalized;
  }

  const qTokens = contentTokens(query);
  if (!qTokens.length) return null;
  const head = qTokens[qTokens.length - 1];

  const qSet = new Set(qTokens);
  let best = null;
  let bestScore = 0;
  for (const it of pool) {
    const iTokens = contentTokens(it.name);
    if (!iTokens.length) continue;
    // Only the "item name is contained in the product" direction is safe. The
    // reverse would match the product "Water" onto an item called "Soda water",
    // silently putting the wrong thing on the shopping list.
    if (!iTokens.every((t) => qSet.has(t))) continue;
    // Head-noun-only: the candidate matches nothing but the final word of a
    // multi-word product — "Peppers" for "poblano peppers", "Juice" for
    // "lemon juice". That is a category, not the product. Demote it to a
    // near-miss so the user is offered it in one tap rather than defaulted onto
    // it silently, and let a candidate matching a non-final token win instead
    // (which is how "poblano peppers" reaches the item "poblano").
    if (qTokens.length > 1 && iTokens.length === 1 && iTokens[0] === head) {
      continue;
    }
    const score = iTokens.filter((t) => qSet.has(t)).length;
    if (score > bestScore) {
      best = it;
      bestScore = score;
    }
  }
  return best;
}


/**
 * Candidates that matching rejected, offered to the user as suggestions.
 *
 * `matchProduct` is deliberately one-directional: it will not match the product
 * "water" onto an item called "Soda water", because doing that automatically
 * puts the wrong thing on a shopping list. But refusing the *automatic* match is
 * not a reason to hide the candidate — without somewhere to surface it, the
 * Shopping context accumulates "Salt", "kosher salt" and "Sea salt" as three
 * separate items.
 *
 * A near-miss is an item that shares the product's head noun but was not
 * selected. That is the same head-noun test tier 3 uses, so these are precisely
 * the rows containment rejected — not loose keyword hits.
 *
 * Ranked closest first: most shared tokens, then the tightest name, so the
 * generic "Salt" outranks "Sea salt" for the product "kosher salt". Consolidating
 * onto the generic item is the point.
 *
 * Deduplicated by normalised name, because the real Shopping context contains
 * genuine duplicates ("Banana" twice) and offering the same suggestion twice is
 * noise.
 *
 * @param {string} product - product name from parseIngredient
 * @param {Array<Object>} items
 * @param {{contextId?: string, limit?: number, exclude?: string}} [opts]
 *   `exclude` is an item id to omit — pass the matchProduct result so a row
 *   never suggests the target it already has.
 * @returns {Array<Object>} at most `limit` items (default 3), closest first
 */
export function findNearMisses(product, items, opts = {}) {
  const query = String(product || "").trim();
  if (!query) return [];

  const limit = Number.isFinite(opts.limit) ? Math.max(0, opts.limit) : 3;
  if (limit === 0) return [];

  const qTokens = contentTokens(query);
  if (!qTokens.length) return [];
  const head = qTokens[qTokens.length - 1];
  const qSet = new Set(qTokens);

  const scored = [];
  for (const it of candidatePool(items, opts)) {
    if (opts.exclude && it.id === opts.exclude) continue;
    const iTokens = contentTokens(it.name);
    if (!iTokens.length) continue;
    if (!iTokens.includes(head)) continue;
    // An item that IS the match is not a near-miss.
    if (iTokens.every((t) => qSet.has(t)) && qTokens.every((t) => new Set(iTokens).has(t))) {
      continue;
    }
    const shared = iTokens.filter((t) => qSet.has(t)).length;
    // A shared head noun alone is too weak once the product has several words:
    // "vanilla bean extract or paste" and "Tomato Paste" share only "paste".
    // Require a majority of the product's own words to be present.
    if (shared * 2 < qTokens.length) continue;
    scored.push({ item: it, shared, width: iTokens.length });
  }

  scored.sort(
    (a, b) =>
      b.shared - a.shared ||
      a.width - b.width ||
      a.item.name.localeCompare(b.item.name),
  );

  const seen = new Set();
  const out = [];
  for (const entry of scored) {
    const k = keyOf(entry.item.name);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(entry.item);
    if (out.length >= limit) break;
  }
  return out;
}
