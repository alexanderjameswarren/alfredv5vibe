import test from "node:test";
import assert from "node:assert/strict";
import { isNotAnArtist, bylineHasPageFurniture } from "./not-an-artist.mjs";

test("upload dates are not artists", () => {
  for (const s of ["Dec 29, 2023", "Oct 24, 2019", "Dec 29 2023", "29 Dec 2023",
                   "December 29, 2023", "Dec 2023", "2023-12-29", "Premiered Jan 4, 2021"]) {
    assert.ok(isNotAnArtist(s), s);
  }
});

test("view counts are not artists", () => {
  for (const s of ["1.7M views", "1,234 views", "823 views", "1 view", "No views", "12K views"]) {
    assert.ok(isNotAnArtist(s), s);
  }
});

test("REAL ACTS SURVIVE — without this the rules above pass by excluding everything", () => {
  for (const s of ["Charlie Parker", "Earth, Wind & Fire", "Tyler, The Creator", "Chicago",
                   "Blood, Sweat & Tears", "Bud Powell", "Art Blakey & The Jazz Messengers",
                   "May Erlewine", "August Burns Red", "Marcus King", "The 1975"]) {
    assert.ok(!isNotAnArtist(s), s);
  }
});

test("one bad run condemns the byline — the two rows Alex named", () => {
  // "Jazz and Blues Experience, 1.7M views" is not a collaboration between a
  // channel and a view count. §14.9 records this exact string.
  assert.ok(bylineHasPageFurniture("Jazz and Blues Experience, 1.7M views",
    ["Jazz and Blues Experience", "1.7M views"]));
  assert.ok(bylineHasPageFurniture("Joel Silva Music, 42K views",
    ["Joel Silva Music", "42K views"]));
  assert.ok(bylineHasPageFurniture("Dec 29, 2023", ["Dec 29, 2023"]));
  // ...and a clean byline is not condemned.
  assert.ok(!bylineHasPageFurniture("Clifford Brown, Max Roach",
    ["Clifford Brown", "Max Roach"]));
});

test("matching is WHOLE-SEGMENT — a substring rule would eat real names", () => {
  assert.ok(!isNotAnArtist("Views"));
  assert.ok(!isNotAnArtist("The Views"));
  assert.ok(!isNotAnArtist("May Day"));
  assert.ok(!isNotAnArtist("2 Chainz"));
});
