import {
  VIEW_TO_PATH,
  DEFAULT_VIEW,
  pathToView,
  viewToPath,
  normalizePath,
  parentPath,
  samSongPath,
  samSongIdFromPath,
  executionPath,
  executionIdFromPath,
  inboxDetailPath,
  inboxIdFromPath,
  intentionDetailPath,
  intentionIdFromPath,
  addPath,
  addRouteFromPath,
  isSamStatsPath,
  isKnownPath,
  isRecordId,
  recordIdFromPath,
  recordPath,
  RECORD_VIEW,
  moneyAccountPath,
  moneyRouteFromPath,
} from "./viewPaths";
import { uid } from "./utils/flattenElements";

// The bridge (Alfred.jsx) hands arbitrary runtime values to viewToPath and
// arbitrary URLs to pathToView. These tests pin the contract the bridge relies
// on — above all "never crash, fall back to home".

describe("the map itself", () => {
  it("covers all 24 view values", () => {
    // 20 until Step 12.6 added the two add pages; 23 since Clipboard Step 17
    // made inbox triage a page; 24 with Money (warren_buffet-w7b).
    expect(Object.keys(VIEW_TO_PATH)).toHaveLength(24);
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
    expect(parentPath("/inbox/detail")).toBe("/inbox");
    expect(parentPath("/collections/detail")).toBe("/collections");
    expect(parentPath("/collections/history")).toBe("/collections");
    expect(parentPath("/collections/add-items")).toBe("/collections");
  });

  it("resolves every detail parent to a real, cold-loadable view", () => {
    const details = Object.values(VIEW_TO_PATH).filter(
      (p) => p.split("/").length > 2
    );
    // 8 until Step 12.6 added /memories/new and /intentions/new; 11 since
    // Clipboard Step 17 added /inbox/detail.
    expect(details).toHaveLength(11);
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

describe("add sub-routes (Step 12.6)", () => {
  it("resolves the bare form to its view, with no target", () => {
    expect(pathToView("/memories/new")).toBe("item-add");
    expect(pathToView("/intentions/new")).toBe("intention-add");
    expect(addRouteFromPath("/memories/new")).toEqual({
      view: "item-add",
      target: null,
    });
  });

  it("resolves a targeted form to the same view", () => {
    expect(pathToView("/memories/new/context/abc")).toBe("item-add");
    expect(pathToView("/intentions/new/item/xyz")).toBe("intention-add");
    expect(addRouteFromPath("/intentions/new/context/abc")).toEqual({
      view: "intention-add",
      target: { kind: "context", id: "abc" },
    });
  });

  it("round-trips a target through addPath", () => {
    const target = { kind: "context", id: "ctx 1/2" };
    const path = addPath("item-add", target);
    expect(addRouteFromPath(path).target).toEqual(target);
  });

  it("keeps the view map a bijection — viewToPath is always the bare form", () => {
    expect(viewToPath("item-add")).toBe("/memories/new");
    expect(viewToPath("intention-add")).toBe("/intentions/new");
  });

  it("treats a malformed target as no address at all, not a partial one", () => {
    // A half-read target would open an add form pointing somewhere unintended.
    for (const bad of [
      "/memories/new/context",
      "/memories/new/context/a/b",
      "/memories/new/nonsense/abc",
      "/memories/new/context/",
    ]) {
      expect(addRouteFromPath(bad)).toBeNull();
      expect(isKnownPath(bad)).toBe(false);
    }
  });

  it("does not treat a look-alike prefix as an add path", () => {
    expect(addRouteFromPath("/memories/detail")).toBeNull();
    expect(addRouteFromPath("/memories/add-to-collection")).toBeNull();
    expect(addRouteFromPath("/memories/newsletter")).toBeNull();
  });

  it("sends a targeted form's parent to the LIST, not to its own bare form", () => {
    // Stripping one segment would land on /memories/new/context, which is not
    // an address — one visible correction instead of two.
    expect(parentPath("/memories/new/context/abc")).toBe("/memories");
    expect(parentPath("/intentions/new/item/xyz")).toBe("/intentions");
    expect(parentPath("/memories/new")).toBe("/memories");
  });

  it("falls back rather than throwing on rubbish input", () => {
    expect(addPath("not-a-view")).toBe("/");
    expect(addPath("item-add", { kind: "nope", id: "x" })).toBe("/memories/new");
    expect(addPath("item-add", { kind: "context" })).toBe("/memories/new");
    expect(addRouteFromPath("")).toBeNull();
    expect(addRouteFromPath(undefined)).toBeNull();
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

describe("execution sub-route (notification chains, Phase 1)", () => {
  it("round-trips an execution id", () => {
    expect(executionIdFromPath(executionPath("abc-123"))).toBe("abc-123");
  });

  it("round-trips a uid()-shaped id", () => {
    // uid() is Date.now().toString(36) + Math.random().toString(36).slice(2)
    const id = "m7q2x1a9k3f8d0";
    expect(executionIdFromPath(executionPath(id))).toBe(id);
  });

  it("resolves the id-bearing path to the execution-detail view", () => {
    expect(pathToView("/schedule/execution/abc")).toBe("execution-detail");
  });

  it("still resolves the bare path to the same view", () => {
    // The id-less form has to keep working: it is what viewToPath produces
    // and what any remaining id-less navigation still uses.
    expect(pathToView("/schedule/execution")).toBe("execution-detail");
    expect(viewToPath("execution-detail")).toBe("/schedule/execution");
  });

  it("extracts an id only from an id-bearing execution path", () => {
    expect(executionIdFromPath("/schedule/execution/9f8e")).toBe("9f8e");
    expect(executionIdFromPath("/schedule/execution/9f8e/")).toBe("9f8e");
    // The bare form is the id-less address, not an id of "".
    expect(executionIdFromPath("/schedule/execution")).toBeNull();
    expect(executionIdFromPath("/schedule")).toBeNull();
    expect(executionIdFromPath("/memories/detail")).toBeNull();
  });

  it("degrades to no-id rather than throwing on a malformed path", () => {
    expect(executionIdFromPath("/schedule/execution/")).toBeNull();
    expect(executionIdFromPath("/schedule/execution/a/b")).toBeNull();
  });

  it("treats an id-bearing path as known", () => {
    expect(isKnownPath("/schedule/execution/abc")).toBe(true);
  });

  it("does not rescue a malformed id-bearing path", () => {
    // Falls through to home rather than being half-served.
    expect(isKnownPath("/schedule/execution/a/b")).toBe(false);
  });

  it("falls back to the schedule list, not to the id-less form", () => {
    // Stripping one segment would land on /schedule/execution, which is itself
    // unrenderable cold and would redirect again.
    expect(parentPath("/schedule/execution/abc")).toBe("/schedule");
    expect(isKnownPath(parentPath("/schedule/execution/abc"))).toBe(true);
  });
});

describe("inbox detail sub-route (Alfred Clipboard, Step 17)", () => {
  it("round-trips an inbox row id", () => {
    expect(inboxIdFromPath(inboxDetailPath("abc-123"))).toBe("abc-123");
  });

  it("round-trips a uid()-shaped id", () => {
    const id = "m7q2x1a9k3f8d0";
    expect(inboxIdFromPath(inboxDetailPath(id))).toBe(id);
  });

  it("round-trips a uuid, which is what clip-capture mints", () => {
    // Captures from the Chrome extension and the CLI arrive with uuid ids, so
    // the two id shapes in `inbox` both have to survive the URL.
    const id = "f979a4df-cebd-4f91-b076-e1d99c452e4a";
    expect(inboxIdFromPath(inboxDetailPath(id))).toBe(id);
  });

  it("resolves the id-bearing path to the inbox-detail view", () => {
    expect(pathToView("/inbox/detail/abc")).toBe("inbox-detail");
  });

  it("still resolves the bare path to the same view", () => {
    expect(pathToView("/inbox/detail")).toBe("inbox-detail");
    expect(viewToPath("inbox-detail")).toBe("/inbox/detail");
  });

  it("does not swallow the inbox list", () => {
    // The whole point of the /detail segment: /inbox stays the list.
    expect(pathToView("/inbox")).toBe("inbox");
    expect(inboxIdFromPath("/inbox")).toBeNull();
  });

  it("extracts an id only from an id-bearing inbox path", () => {
    expect(inboxIdFromPath("/inbox/detail/9f8e")).toBe("9f8e");
    expect(inboxIdFromPath("/inbox/detail/9f8e/")).toBe("9f8e");
    // The bare form is the id-less address, not an id of "".
    expect(inboxIdFromPath("/inbox/detail")).toBeNull();
    expect(inboxIdFromPath("/memories/detail")).toBeNull();
  });

  it("degrades to no-id rather than throwing on a malformed path", () => {
    expect(inboxIdFromPath("/inbox/detail/")).toBeNull();
    expect(inboxIdFromPath("/inbox/detail/a/b")).toBeNull();
  });

  it("treats an id-bearing path as known", () => {
    expect(isKnownPath("/inbox/detail/abc")).toBe(true);
  });

  it("does not rescue a malformed id-bearing path", () => {
    expect(isKnownPath("/inbox/detail/a/b")).toBe(false);
  });

  it("falls back to the inbox list, not to the id-less form", () => {
    // /inbox/detail is unrenderable cold and would redirect again.
    expect(parentPath("/inbox/detail/abc")).toBe("/inbox");
    expect(isKnownPath(parentPath("/inbox/detail/abc"))).toBe(true);
  });
});

describe("intention detail sub-route (Reminders)", () => {
  it("round-trips an intention id", () => {
    expect(intentionIdFromPath(intentionDetailPath("m7q2x1a9k3f8d0"))).toBe("m7q2x1a9k3f8d0");
    expect(intentionDetailPath("a b")).toBe("/intentions/detail/a%20b");
  });

  it("resolves both forms to the intention-detail view", () => {
    expect(pathToView("/intentions/detail/abc")).toBe("intention-detail");
    expect(pathToView("/intentions/detail")).toBe("intention-detail");
    expect(viewToPath("intention-detail")).toBe("/intentions/detail");
  });

  it("leaves the list and the add page alone", () => {
    expect(pathToView("/intentions")).toBe("intentions");
    expect(intentionIdFromPath("/intentions")).toBeNull();
    expect(intentionIdFromPath("/intentions/new/item/x")).toBeNull();
  });

  it("degrades to no-id on a malformed path", () => {
    expect(intentionIdFromPath("/intentions/detail")).toBeNull();
    expect(intentionIdFromPath("/intentions/detail/")).toBeNull();
    expect(intentionIdFromPath("/intentions/detail/a/b")).toBeNull();
    expect(isKnownPath("/intentions/detail/a/b")).toBe(false);
  });

  it("is known and falls back to the intentions list", () => {
    expect(isKnownPath("/intentions/detail/abc")).toBe(true);
    expect(parentPath("/intentions/detail/abc")).toBe("/intentions");
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

describe("record links (/<id>)", () => {
  const UUID = "5f387912-05b3-45c6-90f3-a162c3d8732e";
  const APP_ID = "mm0s2dcabze16uiowwe";

  it("recognises both id shapes", () => {
    for (const id of [UUID, UUID.toUpperCase(), APP_ID, uid(), "a1".repeat(8).slice(0, 15)]) {
      expect(isRecordId(id)).toBe(true);
      expect(recordIdFromPath(recordPath(id))).toBe(id);
      expect(pathToView(`/${id}`)).toBe(RECORD_VIEW);
      expect(isKnownPath(`/${id}`)).toBe(true);
    }
    expect(recordIdFromPath(`/${APP_ID}/`)).toBe(APP_ID);
  });

  it("rejects near misses", () => {
    for (const id of ["abcdefghijklmnopq", "a1b2c3d4e5f6g7", "a1".repeat(13), "Mm0s2dcabze16uiowwe", "mm0s2dcabze16uio-we"]) {
      expect(isRecordId(id)).toBe(false);
    }
    expect(recordIdFromPath(`/inbox/${UUID}`)).toBeNull();
  });

  it("no word path matches", () => {
    const segments = new Set(
      Object.values(VIEW_TO_PATH).flatMap((p) => p.split("/")).filter(Boolean)
    );
    segments.add("stats").add("songs").add("execution").add("oauth").add("consent");
    for (const s of segments) {
      expect(isRecordId(s)).toBe(false);
    }
    for (const p of Object.values(VIEW_TO_PATH)) {
      expect(pathToView(p)).not.toBe(RECORD_VIEW);
    }
  });
});

describe("money sub-routes", () => {
  it("resolves every Money screen to the money view", () => {
    expect(moneyRouteFromPath("/money")).toEqual({ tab: "overview", accountId: null, adding: false });
    expect(moneyRouteFromPath("/money/net-worth/")).toEqual({ tab: "net-worth", accountId: null, adding: false });
    expect(moneyRouteFromPath("/money/accounts/new").adding).toBe(true);
    expect(moneyRouteFromPath(moneyAccountPath("abc-1"))).toEqual({ tab: "accounts", accountId: "abc-1", adding: false });
    for (const p of ["/money", "/money/accounts", "/money/accounts/abc-1", "/money/net-worth"]) {
      expect(pathToView(p)).toBe("money");
      expect(isKnownPath(p)).toBe(true);
    }
  });

  it("rejects malformed Money paths", () => {
    for (const p of ["/money/x", "/money/accounts/a/b", "/moneybags"]) {
      expect(moneyRouteFromPath(p)).toBeNull();
      expect(isKnownPath(p)).toBe(false);
    }
  });
});
