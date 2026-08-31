// Unit tests for dj-normalise.ts — the match_key rules and the bucket→date
// ladder. Pure functions, no network, no database.
//
// Run (Node 24+, no Deno toolchain needed):
//   node --experimental-strip-types --test supabase/functions/_shared/tools/dj-normalise.test.mjs
//
// ⚠️ These tests are NOT wired into `npm test` — that runs react-scripts/jest
// over src/ only, and this file lives under supabase/functions. Run it by hand
// when touching the normaliser. Given spec §4.1.2 makes a rule change a
// backfill migration rather than a deploy, that is a deliberate stop-and-think
// moment anyway.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARTIST_ALIASES,
  buildMatchKey,
  canonicalArtist,
  normalisePart,
  resolvePlayDate,
  shiftDate,
  stripDashQualifiers,
  stripQualifierGroups,
  tidy,
} from "./dj-normalise.ts";

// ---------------------------------------------------------------------------
// The case the whole design exists for
// ---------------------------------------------------------------------------

test("remaster variant groups with the clean version", () => {
  // The first probe returned exactly this title (spec §4.1).
  const remaster = buildMatchKey(["Herbie Hancock"], "The Pleasure Is Mine (Remastered 1999)");
  const clean = buildMatchKey(["Herbie Hancock"], "The Pleasure Is Mine");
  assert.equal(remaster, clean);
  assert.equal(clean, "herbie hancock|the pleasure is mine");
});

test("remaster spellings all collapse to the same key", () => {
  const base = buildMatchKey(["A"], "Song");
  for (
    const variant of [
      "Song (Remastered)",
      "Song (Remaster)",
      "Song (Remastered 1999)",
      "Song (2011 Remaster)",
      "Song - Remastered 2011",
      "Song - 2011 Remaster",
    ]
  ) {
    assert.equal(buildMatchKey(["A"], variant), base, `failed for: ${variant}`);
  }
});

// ---------------------------------------------------------------------------
// The trap: positional stripping would destroy a real title
// ---------------------------------------------------------------------------

test("Undone - The Sweater Song keeps its dashed half", () => {
  // A "strip everything after a dash" rule would turn this into "undone".
  // The dashed half IS the song name. Vocabulary matching is what saves it.
  assert.equal(
    buildMatchKey(["Weezer"], "Undone - The Sweater Song"),
    "weezer|undone the sweater song",
  );
});

test("unrecognised parentheticals survive", () => {
  // A reprise is different music; nothing in the vocabulary matches it.
  assert.equal(normalisePart("Finale (Reprise)"), "finale reprise");
  assert.equal(normalisePart("Song (Part 2)"), "song part 2");
  assert.notEqual(buildMatchKey(["A"], "Song (Reprise)"), buildMatchKey(["A"], "Song"));
});

test("instrumental is deliberately NOT stripped", () => {
  // Documented decision, not an oversight — see dj-normalise.ts header.
  assert.notEqual(
    buildMatchKey(["A"], "Song (Instrumental)"),
    buildMatchKey(["A"], "Song"),
  );
});

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

test("parenthetical 'with' is a feature marker and strips", () => {
  // Real Weezer case: Go Away (with Bethany Cosentino) — spec §7 phase 3.
  assert.equal(
    buildMatchKey(["Weezer"], "Go Away (with Bethany Cosentino)"),
    buildMatchKey(["Weezer"], "Go Away"),
  );
});

test("bare 'with' is ordinary English and does NOT strip", () => {
  // Stripping on a bare "with" would eat real titles.
  assert.equal(normalisePart("Sitting With You"), "sitting with you");
});

test("inline feat. clauses strip", () => {
  const base = buildMatchKey(["A"], "Song");
  for (const v of ["Song feat. B", "Song ft. B", "Song featuring B", "Song (feat. B)"]) {
    assert.equal(buildMatchKey(["A"], v), base, `failed for: ${v}`);
  }
});

test("only the primary artist feeds the key", () => {
  // artists[] varies between variants of the same song; those must group.
  assert.equal(
    buildMatchKey(["Weezer", "Bethany Cosentino"], "Go Away"),
    buildMatchKey(["Weezer"], "Go Away"),
  );
});

// ---------------------------------------------------------------------------
// Documented merge behaviour — spec §4.1.3
// ---------------------------------------------------------------------------

test("live and studio DO group — correct for familiarity, stated so it is not a surprise", () => {
  assert.equal(
    buildMatchKey(["Weezer"], "Say It Ain't So - Live"),
    buildMatchKey(["Weezer"], "Say It Ain't So"),
  );
  assert.equal(
    buildMatchKey(["Weezer"], "Say It Ain't So (Live at Wembley)"),
    buildMatchKey(["Weezer"], "Say It Ain't So"),
  );
});

test("apostrophes close up rather than splitting words", () => {
  assert.equal(tidy("say it ain't so"), "say it aint so");
});

test("ampersand normalises to 'and'", () => {
  assert.equal(
    buildMatchKey(["Simon & Garfunkel"], "Song"),
    buildMatchKey(["Simon and Garfunkel"], "Song"),
  );
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

test("stacked qualifiers strip repeatedly", () => {
  assert.equal(
    buildMatchKey(["A"], "Song - Live - Remastered 2011"),
    buildMatchKey(["A"], "Song"),
  );
  assert.equal(
    buildMatchKey(["A"], "Song (Live) (Remastered)"),
    buildMatchKey(["A"], "Song"),
  );
});

test("a title that is entirely a qualifier still yields a key", () => {
  // Falls back to plain tidying rather than returning "" — a key of "" would
  // group unrelated rows together, which is worse than no grouping.
  const k = buildMatchKey(["A"], "(Live)");
  assert.equal(k, "a|live");
});

test("missing artists yields an empty artist half, not a crash", () => {
  assert.equal(buildMatchKey(undefined, "Song"), "|song");
  assert.equal(buildMatchKey([], "Song"), "|song");
});

test("a title with no usable characters yields null", () => {
  assert.equal(buildMatchKey(["A"], "!!!"), null);
});

test("case and whitespace are irrelevant", () => {
  assert.equal(
    buildMatchKey(["  WEEZER "], "  Buddy   Holly  "),
    buildMatchKey(["weezer"], "Buddy Holly"),
  );
});

test("helpers behave in isolation", () => {
  assert.equal(stripQualifierGroups("song (live)").trim(), "song");
  assert.equal(stripQualifierGroups("song (reprise)"), "song (reprise)");
  assert.equal(stripDashQualifiers("song - live"), "song");
  assert.equal(stripDashQualifiers("undone - the sweater song"), "undone - the sweater song");
});

// ---------------------------------------------------------------------------
// Bucket → date, spec §4.2
// ---------------------------------------------------------------------------

test("the precision ladder matches the spec table", () => {
  const poll = "2026-08-27";
  assert.deepEqual(resolvePlayDate("Today", poll), { played_on: "2026-08-27", precision: "day" });
  assert.deepEqual(resolvePlayDate("Yesterday", poll), { played_on: "2026-08-26", precision: "day" });
  assert.deepEqual(resolvePlayDate("This week", poll), { played_on: "2026-08-25", precision: "week" });
  assert.deepEqual(resolvePlayDate("Last week", poll), { played_on: "2026-08-18", precision: "fortnight" });
});

test("estimates skew to the RECENT end of the bucket", () => {
  // Deliberate: the question is "how long since I heard this", and a
  // recent-skewed guess makes the answer conservative.
  const poll = "2026-08-27";
  assert.ok(resolvePlayDate("This week", poll).played_on > "2026-08-20");
  assert.ok(resolvePlayDate("Last week", poll).played_on > "2026-08-13");
});

test("date arithmetic crosses month and year boundaries", () => {
  assert.equal(shiftDate("2026-03-01", 9), "2026-02-20");
  assert.equal(shiftDate("2026-01-05", 9), "2025-12-27");
  // 2028 is a leap year.
  assert.equal(shiftDate("2028-03-01", 1), "2028-02-29");
});

test("an unknown bucket throws and names the alternative", () => {
  assert.throws(
    () => resolvePlayDate("Fortnight ago", "2026-08-27"),
    /unknown played_bucket .* played_on and precision explicitly/s,
  );
});


// ---------------------------------------------------------------------------
// Artist aliases — one act, two vocabularies (spec §4.1.4)
// ---------------------------------------------------------------------------

test("aliases translate toward the POLL vocabulary, in both directions", () => {
  // The direction REVERSES between entries, which is the whole reason no
  // automatic rule works: "prefer the longer form" fixes one and breaks the
  // other.
  assert.equal(canonicalArtist("Eddie Higgins"), "Eddie Higgins Trio");
  assert.equal(canonicalArtist("The Red Garland Trio"), "Red Garland");
});

test("an alias makes both spellings produce the SAME match_key", () => {
  // The point of the map. Without it these are two acts.
  assert.equal(
    buildMatchKey(["Eddie Higgins"], "Detour Ahead"),
    buildMatchKey(["Eddie Higgins Trio"], "Detour Ahead"),
  );
  assert.equal(
    buildMatchKey(["The Red Garland Trio"], "Hey Now"),
    buildMatchKey(["Red Garland"], "Hey Now"),
  );
  assert.equal(buildMatchKey(["Eddie Higgins"], "Detour Ahead"),
    "eddie higgins trio|detour ahead");
});

test("matching is case- and whitespace-insensitive but not fuzzy", () => {
  assert.equal(canonicalArtist("  eddie higgins  "), "Eddie Higgins Trio");
  assert.equal(canonicalArtist("EDDIE HIGGINS"), "Eddie Higgins Trio");
  // NOT fuzzy: a near-miss is left alone rather than guessed at.
  assert.equal(canonicalArtist("Eddie Higgins Quartet"), "Eddie Higgins Quartet");
});

test("unknown artists pass through untouched", () => {
  for (const a of ["Weezer", "Coldplay", "Miles Davis", "The Miles Davis Quintet"]) {
    assert.equal(canonicalArtist(a), a);
  }
});

test("Miles Davis is deliberately NOT an alias", () => {
  // The case that shows the map cannot be automated: whether the Quintet is the
  // same act for familiarity purposes is a judgment call, and it has not arisen.
  const froms = ARTIST_ALIASES.map((a) => a.from.toLowerCase());
  assert.ok(!froms.includes("miles davis"));
  assert.ok(!froms.includes("the miles davis quintet"));
  assert.notEqual(
    buildMatchKey(["Miles Davis"], "So What"),
    buildMatchKey(["The Miles Davis Quintet"], "So What"),
  );
});

test("every alias records WHY it is correct", () => {
  // Hand-curation only beats a derived rule if the reasoning survives for the
  // next person to add an entry.
  for (const a of ARTIST_ALIASES) {
    assert.ok(a.why && a.why.length > 60, `${a.from}: missing or thin rationale`);
    assert.notEqual(a.from.toLowerCase(), a.to.toLowerCase(), "alias must change something");
  }
});

test("no alias chains — a `to` is never another entry's `from`", () => {
  // A chain would make the result depend on evaluation order, which is exactly
  // the class of silent input to identity the map exists to remove.
  const froms = new Set(ARTIST_ALIASES.map((a) => a.from.toLowerCase()));
  for (const a of ARTIST_ALIASES) {
    assert.ok(!froms.has(a.to.toLowerCase()), `${a.to} is both a target and a key`);
  }
});
