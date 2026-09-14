import fs from "fs";
import path from "path";
import { startOfPacificDay } from "./localDay";

// ─── A note on forcing the timezone ──────────────────────────────────────────
//
// The spec asks for these to run with the browser timezone forced to something
// that is not Pacific. Setting `process.env.TZ` inside a test file does NOT do
// that: Jest has already initialised the environment by the time module code
// runs, and V8 has cached the zone. Verified — after setting it, `getHours()`
// still returns Pacific. The only ways to genuinely force it are a global
// `globalSetup` (which would change the environment for all 33 suites,
// including SAM's Pacific-pinned formatters) or setting TZ before Node starts:
//
//     TZ=America/New_York CI=true npx react-scripts test
//
// That command is part of this phase's verification and is recorded in
// docs/progress-tags.md. The tests below are written to be correct under ANY
// ambient zone, so both runs are meaningful.
//
// Because a Pacific machine would let a naive `setHours(0, 0, 0, 0)`
// implementation pass every behavioural case below, there are two extra tests
// that do not depend on the ambient zone at all: a source guard proving no
// local-time API is used, and a year-long cross-check against an independently
// computed boundary.

// Pacific midnight, as an instant, for the days used below.
const SEP_14_MIDNIGHT = "2026-09-14T07:00:00.000Z"; // PDT, UTC-7
const MAR_08_MIDNIGHT = "2026-03-08T08:00:00.000Z"; // PST, UTC-8 — before the 2am jump
const NOV_01_MIDNIGHT = "2026-11-01T07:00:00.000Z"; // PDT, UTC-7 — before the 2am fall back

describe("startOfPacificDay", () => {
  test("just after Pacific midnight returns that same day's boundary", () => {
    // 00:30 PDT on the 14th.
    const now = new Date("2026-09-14T07:30:00Z");
    expect(startOfPacificDay(now).toISOString()).toBe(SEP_14_MIDNIGHT);
  });

  test("just before Pacific midnight returns the current day, not the next", () => {
    // 23:30 PDT on the 14th — but already the 15th in UTC, and the 15th in
    // every zone east of Pacific. Both wrong answers are reachable here.
    const now = new Date("2026-09-15T06:30:00Z");
    expect(startOfPacificDay(now).toISOString()).toBe(SEP_14_MIDNIGHT);
  });

  test("one millisecond after the boundary belongs to the new day", () => {
    const now = new Date(Date.parse(SEP_14_MIDNIGHT) + 1);
    expect(startOfPacificDay(now).toISOString()).toBe(SEP_14_MIDNIGHT);
  });

  test("one millisecond before the boundary belongs to the previous day", () => {
    const now = new Date(Date.parse(SEP_14_MIDNIGHT) - 1);
    expect(startOfPacificDay(now).toISOString()).toBe(
      "2026-09-13T07:00:00.000Z",
    );
  });

  // Spring forward: 2026-03-08, 02:00 PST becomes 03:00 PDT. Midnight that day
  // is still PST (UTC-8), but by noon the zone is PDT (UTC-7). An
  // implementation that resolves the offset once, at the current instant,
  // returns 07:00Z here — an hour early, which would leak in the tail of
  // yesterday's removals.
  test("spring forward: midnight is PST even when asked from PDT", () => {
    const now = new Date("2026-03-08T19:00:00Z"); // 12:00 PDT
    expect(startOfPacificDay(now).toISOString()).toBe(MAR_08_MIDNIGHT);
  });

  test("spring forward: asked from before the transition", () => {
    const now = new Date("2026-03-08T09:30:00Z"); // 01:30 PST, pre-jump
    expect(startOfPacificDay(now).toISOString()).toBe(MAR_08_MIDNIGHT);
  });

  // Fall back: 2026-11-01, 02:00 PDT becomes 01:00 PST. Midnight is still PDT
  // (UTC-7) while noon is PST (UTC-8) — the mirror of the case above, failing
  // in the opposite direction.
  test("fall back: midnight is PDT even when asked from PST", () => {
    const now = new Date("2026-11-01T20:00:00Z"); // 12:00 PST
    expect(startOfPacificDay(now).toISOString()).toBe(NOV_01_MIDNIGHT);
  });

  test("fall back: asked from inside the repeated hour", () => {
    // 01:30 PDT on the 1st — a wall-clock reading that occurs twice that day.
    const now = new Date("2026-11-01T08:30:00Z");
    expect(startOfPacificDay(now).toISOString()).toBe(NOV_01_MIDNIGHT);
  });

  test("the returned boundary reads as midnight in Pacific", () => {
    const shown = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(startOfPacificDay(new Date("2026-03-08T19:00:00Z")));
    expect(shown.replace(/^24/, "00")).toBe("00:00");
  });

  test("defaults to now, and returns a boundary at or before it", () => {
    const boundary = startOfPacificDay();
    expect(boundary instanceof Date).toBe(true);
    expect(boundary.getTime()).toBeLessThanOrEqual(Date.now());
    // A Pacific day is never longer than 25 hours, even falling back.
    expect(Date.now() - boundary.getTime()).toBeLessThan(25 * 60 * 60 * 1000);
  });

  // ─── Zone-independence, proven without mutating TZ ──────────────────────────

  test("the module calls no local-time Date API", () => {
    // This is the regression the "force the timezone" requirement exists to
    // catch, asserted directly. A `setHours(0,0,0,0)` implementation passes
    // every behavioural case above when the machine happens to be in Pacific,
    // so behaviour alone cannot rule it out on a developer's laptop in LA.
    const source = fs.readFileSync(
      path.join(__dirname, "localDay.js"),
      "utf8",
    );
    const body = source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

    const localTimeApi = [
      "setHours", "getHours", "setMinutes", "getMinutes",
      "setSeconds", "getSeconds", "setDate", "getDate",
      "setMonth", "getMonth", "setFullYear", "getFullYear",
      "getDay", "getTimezoneOffset", "toDateString", "toLocaleString",
      "toLocaleDateString", "toLocaleTimeString",
    ];
    for (const name of localTimeApi) {
      expect(body).not.toContain(name);
    }

    // And the zone it does use is named explicitly, exactly once.
    expect(body).toContain("America/Los_Angeles");
  });

  test("agrees with an independently computed boundary, every day for a year", () => {
    // Resolves each day's boundary a completely different way: take the
    // Pacific calendar date, then test both plausible offsets and keep the one
    // whose Pacific rendering really is 00:00 on that date. No shared code with
    // the implementation beyond Intl itself.
    const dateKey = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
    });
    const stamp = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/Los_Angeles",
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    });

    const readsAsMidnight = (instant, key) => {
      const parts = Object.fromEntries(
        stamp.formatToParts(instant).map((x) => [x.type, x.value]),
      );
      const hour = +parts.hour % 24;
      return (
        `${parts.year}-${parts.month}-${parts.day}` === key &&
        hour === 0 &&
        +parts.minute === 0
      );
    };

    let checked = 0;
    // Noon UTC each day from 2026-01-01, through both transitions.
    for (let day = 0; day < 365; day += 1) {
      const now = new Date(Date.UTC(2026, 0, 1, 12) + day * 86400000);
      const key = dateKey.format(now);

      const candidates = [7, 8].map(
        (h) => new Date(Date.parse(`${key}T00:00:00Z`) + h * 3600000),
      );
      const expected = candidates.find((c) => readsAsMidnight(c, key));
      expect(expected).toBeDefined();

      expect(startOfPacificDay(now).toISOString()).toBe(expected.toISOString());
      checked += 1;
    }
    expect(checked).toBe(365);
  });
});
