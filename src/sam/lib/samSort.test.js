// Library sort orders.
//
// The interesting cases are not "does A come before B" — they are the ones
// that make a sort silently wrong: missing values, ties, and mutation of the
// caller's array.

import {
  SORT_OPTIONS,
  SORT_VALUES,
  DEFAULT_SORT,
  defaultDirectionFor,
  sortSongs,
  sortFamilies,
} from "./samSort";

const song = (over = {}) => ({
  id: over.title,
  title: "Untitled",
  created_at: "2019-01-01T00:00:00Z",
  lastPracticedAt: null,
  ...over,
});

const titles = (rows) => rows.map((r) => r.title);
const roots = (rows) => rows.map((r) => r.root.title);

// Deliberately NOT in any of the three sorted orders, so a comparator that
// silently does nothing cannot accidentally pass.
const CORPUS = [
  song({ title: "Clocks", created_at: "2019-03-01T10:00:00Z", lastPracticedAt: "2019-06-01T10:00:00Z" }),
  song({ title: "Alfie", created_at: "2019-05-01T10:00:00Z", lastPracticedAt: null }),
  song({ title: "Yellow", created_at: "2019-01-01T10:00:00Z", lastPracticedAt: "2019-07-01T10:00:00Z" }),
  song({ title: "Bones", created_at: "2019-04-01T10:00:00Z", lastPracticedAt: "2019-05-01T10:00:00Z" }),
];

describe("the options offered", () => {
  test("exactly the three orders the UI promises", () => {
    expect(SORT_VALUES).toEqual(["played", "title", "added"]);
    expect(SORT_OPTIONS.map((o) => o.label)).toEqual([
      "Last played",
      "Title",
      "Date added",
    ]);
  });

  test("the default is one of them", () => {
    expect(SORT_VALUES).toContain(DEFAULT_SORT);
  });

  test("each field starts in the direction that is obviously right for it", () => {
    expect(defaultDirectionFor("title")).toBe("asc");
    expect(defaultDirectionFor("played")).toBe("desc");
    expect(defaultDirectionFor("added")).toBe("desc");
  });

  test("an unknown field falls back rather than returning undefined", () => {
    expect(defaultDirectionFor("nonsense")).toBe("desc");
    expect(defaultDirectionFor(undefined)).toBe("desc");
  });
});

describe("direction", () => {
  test("omitting the direction uses the field's natural one", () => {
    expect(titles(sortSongs(CORPUS, "title"))).toEqual(
      titles(sortSongs(CORPUS, "title", "asc"))
    );
    expect(titles(sortSongs(CORPUS, "played"))).toEqual(
      titles(sortSongs(CORPUS, "played", "desc"))
    );
    expect(titles(sortSongs(CORPUS, "added"))).toEqual(
      titles(sortSongs(CORPUS, "added", "desc"))
    );
  });

  test("flipping title gives Z to A", () => {
    expect(titles(sortSongs(CORPUS, "title", "desc"))).toEqual([
      "Yellow", "Clocks", "Bones", "Alfie",
    ]);
  });

  test("flipping last played gives least-recent first", () => {
    // Alfie has never been played and must NOT lead — see below.
    expect(titles(sortSongs(CORPUS, "played", "asc"))).toEqual([
      "Bones", "Clocks", "Yellow", "Alfie",
    ]);
  });

  test("flipping date added gives oldest first", () => {
    expect(titles(sortSongs(CORPUS, "added", "asc"))).toEqual([
      "Yellow", "Clocks", "Bones", "Alfie",
    ]);
  });

  // The asymmetry that makes the toggle usable rather than annoying.
  test("MISSING VALUES STAY LAST IN BOTH DIRECTIONS", () => {
    const rows = [
      song({ title: "Never", lastPracticedAt: null, created_at: null }),
      song({ title: "Bravo", lastPracticedAt: "2019-02-01T00:00:00Z", created_at: "2019-02-01T00:00:00Z" }),
      song({ title: "Alpha", lastPracticedAt: "2019-01-01T00:00:00Z", created_at: "2019-01-01T00:00:00Z" }),
    ];
    for (const key of ["played", "added"]) {
      for (const dir of ["asc", "desc"]) {
        expect(titles(sortSongs(rows, key, dir)).at(-1)).toBe("Never");
      }
    }
  });

  test("reversing twice returns the original order", () => {
    for (const key of SORT_VALUES) {
      const natural = titles(sortSongs(CORPUS, key));
      const flipped = titles(sortSongs(CORPUS, key, defaultDirectionFor(key) === "asc" ? "desc" : "asc"));
      expect(flipped).not.toEqual(natural);
      expect(titles(sortSongs(CORPUS, key, defaultDirectionFor(key)))).toEqual(natural);
    }
  });

  test("the title tiebreaker stays A to Z even when the field is reversed", () => {
    // Two songs share a timestamp. Whichever way the date arrow points, the
    // pair reads alphabetically — the tiebreaker is not part of the ask.
    const tied = [
      song({ title: "Zulu", created_at: "2019-01-01T00:00:00Z" }),
      song({ title: "Alpha", created_at: "2019-01-01T00:00:00Z" }),
    ];
    expect(titles(sortSongs(tied, "added", "desc"))).toEqual(["Alpha", "Zulu"]);
    expect(titles(sortSongs(tied, "added", "asc"))).toEqual(["Alpha", "Zulu"]);
  });

  test("families honour direction too", () => {
    const fam = (title, lastPracticedAt) => ({
      root: song({ title }), simplified: [], drills: [], lastPracticedAt,
    });
    const rows = [
      fam("Beta", "2019-02-01T00:00:00Z"),
      fam("Alpha", "2019-03-01T00:00:00Z"),
    ];
    expect(roots(sortFamilies(rows, "played", "desc"))).toEqual(["Alpha", "Beta"]);
    expect(roots(sortFamilies(rows, "played", "asc"))).toEqual(["Beta", "Alpha"]);
    expect(roots(sortFamilies(rows, "title", "desc"))).toEqual(["Beta", "Alpha"]);
  });
});

describe("sortSongs", () => {
  test("title sorts A to Z", () => {
    expect(titles(sortSongs(CORPUS, "title"))).toEqual([
      "Alfie", "Bones", "Clocks", "Yellow",
    ]);
  });

  test("last played puts the most recent first", () => {
    expect(titles(sortSongs(CORPUS, "played"))).toEqual([
      "Yellow", "Clocks", "Bones", "Alfie",
    ]);
  });

  test("date added puts the newest first", () => {
    expect(titles(sortSongs(CORPUS, "added"))).toEqual([
      "Alfie", "Bones", "Clocks", "Yellow",
    ]);
  });

  // The bug this guards against: an empty string sorts high under a plain
  // descending compare, so never-played songs would head the list.
  test("never-played songs sink to the bottom, not the top", () => {
    const rows = sortSongs(
      [
        song({ title: "Never", lastPracticedAt: null }),
        song({ title: "Played", lastPracticedAt: "2019-01-01T00:00:00Z" }),
      ],
      "played"
    );
    expect(titles(rows)).toEqual(["Played", "Never"]);
  });

  test("a missing created_at also sinks", () => {
    const rows = sortSongs(
      [
        song({ title: "NoDate", created_at: null }),
        song({ title: "Dated", created_at: "2019-01-01T00:00:00Z" }),
      ],
      "added"
    );
    expect(titles(rows)).toEqual(["Dated", "NoDate"]);
  });

  test("every order is total — ties break on title, never on input order", () => {
    // Same timestamp, fed in reverse alphabetical order. A comparator that
    // returns 0 here would leave them as given, because sort is stable.
    const tied = [
      song({ title: "Zulu", lastPracticedAt: "2019-01-01T00:00:00Z", created_at: "2019-01-01T00:00:00Z" }),
      song({ title: "Alpha", lastPracticedAt: "2019-01-01T00:00:00Z", created_at: "2019-01-01T00:00:00Z" }),
    ];
    expect(titles(sortSongs(tied, "played"))).toEqual(["Alpha", "Zulu"]);
    expect(titles(sortSongs(tied, "added"))).toEqual(["Alpha", "Zulu"]);
  });

  test("all-null timestamps collapse to a title sort", () => {
    // This is what keeps the New tab identical to its pre-sort behaviour.
    const unplayed = CORPUS.map((s) => ({ ...s, lastPracticedAt: null }));
    expect(titles(sortSongs(unplayed, "played"))).toEqual(titles(sortSongs(unplayed, "title")));
  });

  test("the caller's array is never mutated", () => {
    const input = [...CORPUS];
    const before = titles(input);
    sortSongs(input, "title");
    sortSongs(input, "added");
    expect(titles(input)).toEqual(before);
  });

  test("empty and absent inputs are handled", () => {
    expect(sortSongs([], "title")).toEqual([]);
    expect(sortSongs()).toEqual([]);
  });
});

describe("sortFamilies", () => {
  const family = (root, lastPracticedAt = null, members = {}) => ({
    root,
    simplified: members.simplified || [],
    drills: members.drills || [],
    lastPracticedAt,
  });

  const FAMILIES = [
    family(song({ title: "Clocks", created_at: "2019-03-01T10:00:00Z" }), "2019-06-01T10:00:00Z"),
    family(song({ title: "Alfie", created_at: "2019-05-01T10:00:00Z" }), null),
    family(song({ title: "Yellow", created_at: "2019-01-01T10:00:00Z" }), "2019-07-01T10:00:00Z"),
  ];

  test("title and date added read from the ROOT", () => {
    expect(roots(sortFamilies(FAMILIES, "title"))).toEqual(["Alfie", "Clocks", "Yellow"]);
    expect(roots(sortFamilies(FAMILIES, "added"))).toEqual(["Alfie", "Clocks", "Yellow"]);
  });

  test("last played reads the FAMILY total, not the root's own", () => {
    // Yellow's root has never been played; the family is most recent because
    // a member was. Sorting on root.lastPracticedAt would bury it.
    const rows = sortFamilies(FAMILIES, "played");
    expect(roots(rows)).toEqual(["Yellow", "Clocks", "Alfie"]);
    expect(rows[0].root.lastPracticedAt).toBeNull();
  });

  test("members keep their tier/recency grouping regardless of sort", () => {
    const withKids = [
      family(song({ title: "Root" }), "2019-06-01T10:00:00Z", {
        simplified: [song({ title: "Tier one" }), song({ title: "Tier two" })],
        drills: [song({ title: "Arpeggios" })],
      }),
    ];
    for (const key of SORT_VALUES) {
      const f = sortFamilies(withKids, key)[0];
      expect(titles(f.simplified)).toEqual(["Tier one", "Tier two"]);
      expect(titles(f.drills)).toEqual(["Arpeggios"]);
    }
  });

  test("the caller's array is never mutated", () => {
    const input = [...FAMILIES];
    const before = roots(input);
    sortFamilies(input, "title");
    expect(roots(input)).toEqual(before);
  });

  test("empty and absent inputs are handled", () => {
    expect(sortFamilies([], "title")).toEqual([]);
    expect(sortFamilies()).toEqual([]);
  });
});
