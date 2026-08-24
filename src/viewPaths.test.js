import {
  VIEW_TO_PATH,
  DEFAULT_VIEW,
  pathToView,
  viewToPath,
  normalizePath,
  parentPath,
  samSongPath,
  samSongIdFromPath,
  isSamStatsPath,
  isKnownPath,
} from "./viewPaths";

// The bridge (Alfred.jsx) hands arbitrary runtime values to viewToPath and
// arbitrary URLs to pathToView. These tests pin the contract the bridge relies
// on — above all "never crash, fall back to home".

describe("the map itself", () => {
  it("covers all 19 view values", () => {
    expect(Object.keys(VIEW_TO_PATH)).toHaveLength(19);
  });

  it("is a bijection — no two views share a path", () => {
    const paths = Object.values(VIEW_TO_PATH);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it("round-trips every view through its path", () => {
    for (const view of Object.keys(VIEW_TO_PATH)) {
      expect(pathToView(viewToPath(view))).toBe(view);
    }
  });

  it("uses absolute lowercase paths throughout", () => {
    for (const path of Object.values(VIEW_TO_PATH)) {
      expect(path).toMatch(/^\/[a-z-/]*$/);
    }
  });
});

describe("viewToPath tolerates non-literal call sites", () => {
  // 11 of the 39 setView call sites pass a runtime value, so this is the
  // path most likely to be handed something unexpected.
  it.each([
    [undefined, "undefined"],
    [null, "null"],
    ["", "empty string"],
    ["not-a-view", "unknown string"],
    [42, "a number"],
    [{}, "an object"],
  ])("falls back to home for %s (%s)", (input) => {
    expect(viewToPath(input)).toBe("/");
  });

  it("never produces a path containing undefined", () => {
    expect(viewToPath(undefined)).not.toContain("undefined");
  });
});

describe("pathToView tolerates arbitrary URLs", () => {
  it("maps unknown paths to home without throwing", () => {
    expect(pathToView("/testing")).toBe(DEFAULT_VIEW);
    expect(pathToView("/a/b/c")).toBe(DEFAULT_VIEW);
    expect(pathToView("/stats")).toBe(DEFAULT_VIEW); // the SAM island, until Step 8
  });

  it("treats a trailing slash as equivalent", () => {
    expect(pathToView("/inbox/")).toBe("inbox");
    expect(pathToView("/collections/history/")).toBe("collection-history");
  });

  it("handles root and empty input", () => {
    expect(pathToView("/")).toBe("home");
    expect(pathToView("")).toBe("home");
    expect(pathToView(undefined)).toBe("home");
  });

  it("is case-sensitive, falling back rather than guessing", () => {
    expect(pathToView("/Inbox")).toBe(DEFAULT_VIEW);
  });
});

describe("normalizePath", () => {
  it("leaves root alone", () => {
    expect(normalizePath("/")).toBe("/");
  });

  it("strips trailing slashes but never empties the path", () => {
    expect(normalizePath("/inbox/")).toBe("/inbox");
    expect(normalizePath("/inbox///")).toBe("/inbox");
    expect(normalizePath("///")).toBe("/");
  });
});

describe("parentPath (used by Step 9's cold-load redirect)", () => {
  it("strips the last segment of each detail path", () => {
    expect(parentPath("/contexts/detail")).toBe("/contexts");
    expect(parentPath("/intentions/detail")).toBe("/intentions");
    expect(parentPath("/memories/detail")).toBe("/memories");
    expect(parentPath("/schedule/execution")).toBe("/schedule");
    expect(parentPath("/collections/detail")).toBe("/collections");
    expect(parentPath("/collections/history")).toBe("/collections");
    expect(parentPath("/collections/add-items")).toBe("/collections");
  });

  it("resolves every detail parent to a real, cold-loadable view", () => {
    const details = Object.values(VIEW_TO_PATH).filter(
      (p) => p.split("/").length > 2
    );
    expect(details).toHaveLength(7);
    for (const path of details) {
      expect(pathToView(parentPath(path))).not.toBe(undefined);
      expect(VIEW_TO_PATH[pathToView(parentPath(path))]).toBe(parentPath(path));
    }
  });

  it("bottoms out at home", () => {
    expect(parentPath("/inbox")).toBe("/");
    expect(parentPath("/")).toBe("/");
  });
});

describe("SAM sub-routes (Step 8)", () => {
  it("treats every path under /sam as the SAM view", () => {
    expect(pathToView("/sam")).toBe("sam");
    expect(pathToView("/sam/")).toBe("sam");
    expect(pathToView("/sam/stats")).toBe("sam");
    expect(pathToView("/sam/songs/abc-123")).toBe("sam");
  });

  it("does not treat a look-alike prefix as SAM", () => {
    expect(pathToView("/samurai")).toBe("home");
  });

  it("still maps the SAM view back to the bare /sam path", () => {
    expect(viewToPath("sam")).toBe("/sam");
  });

  it("round-trips a song id", () => {
    expect(samSongIdFromPath(samSongPath("abc-123"))).toBe("abc-123");
  });

  it("extracts the song id only from a song path", () => {
    expect(samSongIdFromPath("/sam/songs/9f8e")).toBe("9f8e");
    expect(samSongIdFromPath("/sam/songs/9f8e/")).toBe("9f8e");
    expect(samSongIdFromPath("/sam")).toBeNull();
    expect(samSongIdFromPath("/sam/stats")).toBeNull();
    expect(samSongIdFromPath("/memories")).toBeNull();
  });

  it("degrades to no-song rather than throwing on a malformed song path", () => {
    expect(samSongIdFromPath("/sam/songs/")).toBeNull();
    expect(samSongIdFromPath("/sam/songs")).toBeNull();
    expect(samSongIdFromPath("/sam/songs/a/b")).toBeNull();
  });

  it("identifies the stats path exactly", () => {
    expect(isSamStatsPath("/sam/stats")).toBe(true);
    expect(isSamStatsPath("/sam/stats/")).toBe(true);
    expect(isSamStatsPath("/sam")).toBe(false);
    expect(isSamStatsPath("/stats")).toBe(false); // the old address is gone
  });

  it("leaves the retired /stats address unmapped", () => {
    // Renamed to /sam/stats. Nothing links to the old one; it falls back to
    // home like any other unknown path until Step 9 redirects it.
    expect(pathToView("/stats")).toBe("home");
  });
});

describe("isKnownPath (Step 9's unknown-path redirect)", () => {
  it("accepts every mapped path", () => {
    for (const path of Object.values(VIEW_TO_PATH)) {
      expect(isKnownPath(path)).toBe(true);
    }
  });

  it("accepts SAM sub-routes", () => {
    expect(isKnownPath("/sam/stats")).toBe(true);
    expect(isKnownPath("/sam/songs/abc")).toBe(true);
  });

  it("accepts trailing-slash forms", () => {
    expect(isKnownPath("/inbox/")).toBe(true);
    expect(isKnownPath("/")).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isKnownPath("/testing")).toBe(false);
    expect(isKnownPath("/a/b/c")).toBe(false);
    expect(isKnownPath("/stats")).toBe(false); // retired, deliberately not redirected
    expect(isKnownPath("/Inbox")).toBe(false);
    expect(isKnownPath("/samurai")).toBe(false);
  });

  it("never redirects a path to another unknown path", () => {
    // The redirect targets must themselves be servable, or the effect loops.
    const details = Object.values(VIEW_TO_PATH).filter((p) => p.split("/").length > 2);
    for (const path of details) {
      expect(isKnownPath(parentPath(path))).toBe(true);
    }
    expect(isKnownPath("/")).toBe(true);
  });
});
