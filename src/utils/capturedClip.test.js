import {
  clipIdFor,
  hasClip,
  captureModeFor,
  screenshotNoteFor,
  screenshotCaveat,
  needsShowAll,
  displayLinks,
  COLLAPSE_LINES,
} from "./capturedClip";

// `source_metadata` is jsonb, and storage.toCamelCase recurses into it — so the
// same row has camelCase keys when it came through loadData and snake_case keys
// when it came straight from Postgres. Every reader here is tested against both,
// because reading one spelling and assuming it holds in the other has already cost
// this codebase a failed backfill.
const camel = (meta) => ({ id: "inbox-1", sourceMetadata: meta });
const snake = (meta) => ({ id: "inbox-1", source_metadata: meta });

describe("clipIdFor", () => {
  it("reads the camelCase form React state holds", () => {
    expect(clipIdFor(camel({ clipId: "clip-1" }))).toBe("clip-1");
  });

  it("reads the snake_case form Postgres holds", () => {
    expect(clipIdFor(snake({ clip_id: "clip-1" }))).toBe("clip-1");
  });

  it("is null for a capture that points at nothing", () => {
    // A typed capture, which is most of them.
    expect(clipIdFor({ id: "inbox-1" })).toBeNull();
    expect(clipIdFor(camel({}))).toBeNull();
    expect(clipIdFor(camel({ clipId: "" }))).toBeNull();
  });

  it("tolerates junk without throwing", () => {
    expect(clipIdFor(null)).toBeNull();
    expect(clipIdFor(undefined)).toBeNull();
    expect(clipIdFor(camel("not an object"))).toBeNull();
    expect(clipIdFor(camel({ clipId: 42 }))).toBeNull();
  });
});

describe("hasClip", () => {
  it("keys on the id, not on the source label", () => {
    // A clipboard row whose metadata never recorded an id has nothing fetchable,
    // and should read as "nothing to show" rather than as a failed fetch.
    expect(hasClip({ sourceType: "clipboard", sourceMetadata: {} })).toBe(false);
    expect(hasClip({ sourceType: "manual", sourceMetadata: { clipId: "c" } })).toBe(true);
  });
});

describe("captureModeFor", () => {
  it("reads an explicit visible-screen capture", () => {
    expect(captureModeFor(camel({ captureMode: "visible" }))).toBe("visible");
    expect(captureModeFor(snake({ capture_mode: "visible" }))).toBe("visible");
  });

  it("reads an explicit full-page capture", () => {
    expect(captureModeFor(camel({ captureMode: "full" }))).toBe("full");
  });

  it("treats a MISSING mode as full, which is a fact and not a guess", () => {
    // Clips saved before capture modes existed recorded none, and the visible mode
    // did not exist then — every one of them went through the full-page path.
    expect(captureModeFor(camel({}))).toBe("full");
    expect(captureModeFor({ id: "x" })).toBe("full");
    expect(captureModeFor(null)).toBe("full");
  });

  it("treats an unrecognised mode as full rather than inventing a third state", () => {
    expect(captureModeFor(camel({ captureMode: "something-new" }))).toBe("full");
  });
});

describe("screenshotNoteFor", () => {
  it("reads either spelling", () => {
    expect(screenshotNoteFor(camel({ screenshotNote: "Stopped early." }))).toBe("Stopped early.");
    expect(screenshotNoteFor(snake({ screenshot_note: "Stopped early." }))).toBe("Stopped early.");
  });

  it("treats blank as absent", () => {
    expect(screenshotNoteFor(camel({ screenshotNote: "   " }))).toBeNull();
    expect(screenshotNoteFor(camel({}))).toBeNull();
  });
});

describe("screenshotCaveat", () => {
  const complete = { screenshotTruncated: false };

  it("says nothing about a complete full-page screenshot", () => {
    expect(screenshotCaveat(camel({ captureMode: "full" }), complete)).toBeNull();
    // And nothing about a clip that predates capture modes, which is full-page.
    expect(screenshotCaveat(camel({}), complete)).toBeNull();
  });

  it("flags an incomplete screenshot and gives the recorded reason", () => {
    const caveat = screenshotCaveat(
      camel({ screenshotNote: "The page grew while it was being captured." }),
      { screenshotTruncated: true },
    );
    expect(caveat.kind).toBe("incomplete");
    expect(caveat.text).toContain("does not show the whole page");
    expect(caveat.text).toContain("The page grew while it was being captured.");
  });

  it("NEVER GUESSES A CAUSE when none was recorded", () => {
    // The tool version of this once asserted a 24-slice cap unconditionally and was
    // wrong three times out of three. Say only what is certain.
    const caveat = screenshotCaveat(camel({}), { screenshotTruncated: true });
    expect(caveat.kind).toBe("incomplete");
    expect(caveat.text).toContain("not recorded");
    expect(caveat.text).not.toMatch(/cap|24/i);
  });

  it("flags a VISIBLE-ONLY capture even though nothing is broken", () => {
    // The case that gets forgotten: not truncated, not broken, and still not the
    // page. get_clip_slices surfaced its note only on the truncated flag, which
    // left the everyday visible capture with nothing at all to say so.
    const caveat = screenshotCaveat(camel({ captureMode: "visible" }), complete);
    expect(caveat.kind).toBe("visible-only");
    expect(caveat.text).toContain("visible screen");
  });

  it("prefers the recorded note for a visible-only capture", () => {
    const caveat = screenshotCaveat(
      camel({ captureMode: "visible", screenshotNote: "Visible screen only, by design." }),
      complete,
    );
    expect(caveat.text).toBe("Visible screen only, by design.");
  });

  it("calls a truncated visible capture incomplete, the more serious of the two", () => {
    const caveat = screenshotCaveat(camel({ captureMode: "visible" }), { screenshotTruncated: true });
    expect(caveat.kind).toBe("incomplete");
  });

  it("reads the truncated flag in either spelling", () => {
    expect(screenshotCaveat(camel({}), { screenshot_truncated: true }).kind).toBe("incomplete");
  });

  it("says nothing when there is no clip to judge", () => {
    expect(screenshotCaveat(camel({}), null)).toBeNull();
  });
});

describe("needsShowAll", () => {
  it("collapses text with many lines, however short each one is", () => {
    // A recipe: thirty short lines.
    expect(needsShowAll("a\n".repeat(COLLAPSE_LINES + 1))).toBe(true);
  });

  it("collapses text with few lines, however long they are", () => {
    // An article: three enormous ones. A line threshold alone would miss this.
    expect(needsShowAll("x".repeat(500))).toBe(true);
  });

  it("leaves short text alone", () => {
    expect(needsShowAll("A short note.")).toBe(false);
    expect(needsShowAll("one\ntwo\nthree")).toBe(false);
  });

  it("tolerates junk", () => {
    expect(needsShowAll(null)).toBe(false);
    expect(needsShowAll(undefined)).toBe(false);
    expect(needsShowAll(123)).toBe(false);
  });
});

describe("displayLinks", () => {
  it("keeps order and pairs text with href", () => {
    expect(
      displayLinks([
        { text: "First", href: "https://a.example" },
        { text: "Second", href: "https://b.example" },
      ]),
    ).toEqual([
      { text: "First", href: "https://a.example" },
      { text: "Second", href: "https://b.example" },
    ]);
  });

  it("drops rows with no href, because there is nothing to open", () => {
    expect(displayLinks([{ text: "Nowhere" }, { text: "Here", href: "https://a.example" }])).toEqual([
      { text: "Here", href: "https://a.example" },
    ]);
  });

  it("collapses duplicates, keeping the FIRST label", () => {
    // The first is nearest the top of the page, so it is the one most likely to
    // name the destination rather than say "read more".
    expect(
      displayLinks([
        { text: "Anthropic careers", href: "https://x.example" },
        { text: "read more", href: "https://x.example" },
      ]),
    ).toEqual([{ text: "Anthropic careers", href: "https://x.example" }]);
  });

  it("falls back to the href so a row is never a blank line", () => {
    expect(displayLinks([{ text: "   ", href: "https://a.example" }])).toEqual([
      { text: "https://a.example", href: "https://a.example" },
    ]);
  });

  it("trims both fields", () => {
    expect(displayLinks([{ text: "  Spaced  ", href: "  https://a.example  " }])).toEqual([
      { text: "Spaced", href: "https://a.example" },
    ]);
  });

  it("treats a capture with no links as an empty list", () => {
    expect(displayLinks(null)).toEqual([]);
    expect(displayLinks(undefined)).toEqual([]);
    expect(displayLinks("not an array")).toEqual([]);
  });
});
