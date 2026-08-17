// Display formatters for the SAM landing page.
//
// Every formatter here is pinned to America/Los_Angeles, so these assertions
// hold regardless of the machine's timezone. Cases that depend on "the current
// year" derive it rather than hard-coding one, or they would start failing on
// January 1st.

import {
  formatDuration,
  formatLastPracticed,
  formatCreated,
} from "./samFormat";

const currentPtYear = () =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
  }).format(new Date());

describe("formatDuration", () => {
  test("no practice reads as never played, not as zero", () => {
    expect(formatDuration(0)).toBe("never played");
    expect(formatDuration(null)).toBe("never played");
    expect(formatDuration(undefined)).toBe("never played");
  });

  test("under an hour is whole minutes, and a few seconds still counts as one", () => {
    expect(formatDuration(2700)).toBe("45 min");
    expect(formatDuration(30)).toBe("1 min");
  });

  test("one to ten hours keeps one decimal, even when it is .0", () => {
    expect(formatDuration(3600)).toBe("1.0 hours");
    expect(formatDuration(12600)).toBe("3.5 hours");
  });

  test("ten hours and over drops to whole hours", () => {
    expect(formatDuration(36000)).toBe("10 hours");
    expect(formatDuration(151200)).toBe("42 hours");
  });
});

describe("formatLastPracticed", () => {
  test("null input returns null so callers can say never played", () => {
    expect(formatLastPracticed(null)).toBeNull();
    expect(formatLastPracticed(undefined)).toBeNull();
  });

  test("a long-past date in another year carries the year", () => {
    expect(formatLastPracticed("2019-03-03T22:14:00Z")).toBe("Mar 3, 2019");
  });

  test("today reads as today", () => {
    expect(formatLastPracticed(new Date().toISOString())).toBe("today");
  });
});

describe("formatCreated", () => {
  test("null input returns null so the caption is omitted entirely", () => {
    expect(formatCreated(null)).toBeNull();
    expect(formatCreated(undefined)).toBeNull();
    expect(formatCreated("")).toBeNull();
  });

  test("an unparseable timestamp returns null rather than 'added Invalid Date'", () => {
    expect(formatCreated("not a date")).toBeNull();
  });

  // The point of the change: a date alone cannot separate two variants
  // generated in the same sitting.
  test("the caption carries a clock time, not just a date", () => {
    // 22:14 UTC on Mar 3 is 14:14 PST — the date must not roll forward.
    expect(formatCreated("2019-03-03T22:14:00Z")).toBe("added Mar 3, 2019, 2:14 PM");
  });

  test("morning times render as AM with a padded minute", () => {
    expect(formatCreated("2019-03-03T19:05:00Z")).toBe("added Mar 3, 2019, 11:05 AM");
  });

  test("two songs created minutes apart are distinguishable", () => {
    const a = formatCreated("2019-03-03T22:14:00Z");
    const b = formatCreated("2019-03-03T22:41:00Z");
    expect(a).not.toBe(b);
    expect(a).toContain("Mar 3");
    expect(b).toContain("Mar 3");
  });

  test("the year is omitted in the current year and present otherwise", () => {
    const thisYear = currentPtYear();
    const sameYear = formatCreated(`${thisYear}-03-03T22:14:00Z`);
    expect(sameYear).toBe("added Mar 3, 2:14 PM");
    expect(sameYear).not.toContain(thisYear);

    expect(formatCreated("2019-03-03T22:14:00Z")).toContain("2019");
  });

  test("a UTC timestamp late in the day still reports the Pacific date", () => {
    // 2019-03-04T04:30:00Z is 20:30 PST on Mar 3, NOT Mar 4.
    expect(formatCreated("2019-03-04T04:30:00Z")).toBe("added Mar 3, 2019, 8:30 PM");
  });

  test("no narrow no-break space survives into the caption", () => {
    // ICU version differences here would otherwise make the rendered string
    // depend on the Node build.
    expect(formatCreated("2019-03-03T22:14:00Z")).not.toMatch(/ /);
  });
});
