import { asOfLabel, skippedLabel, statusLine } from "./statusLine";

const NOW = new Date(2026, 9, 26, 7, 0);
const at = (h, m, day = 26) => new Date(2026, 9, day, h, m).toISOString();
const APPS = { warren_buffet: "Money" };

test("as of: a time today, a date and time otherwise", () => {
  expect(asOfLabel(at(4, 31), NOW)).toBe("4:31 AM");
  expect(asOfLabel(at(4, 31, 25), NOW)).toBe("Oct 25, 4:31 AM");
});

test("nothing skipped: everything scanned, whatever the status word", () => {
  for (const status of ["ok", "partial"]) {
    expect(statusLine({ nightly: { status, finished_at: at(4, 31), details: {} } }, NOW))
      .toEqual({ text: "Report as of 4:31 AM · everything scanned", warning: false });
  }
});

test("skipped parts: partially scanned, in plain words", () => {
  const nightly = { status: "partial", finished_at: at(4, 31),
    details: { skipped: [{ part: "pull:warren_buffet", error: "x" }, "count:fading", { part: "budget:fading" }] } };
  expect(statusLine({ nightly }, NOW, APPS)).toEqual({
    text: "Report as of 4:31 AM · partially scanned: Money not checked, Fading items not checked", warning: false,
  });
});

test("old string entries and the Money tab name", () => {
  expect(skippedLabel("pull:warren_buffet — recipe needs more than 2 calls", { warren_buffet: "Warren Buffet" }))
    .toBe("Money not checked");
  expect(skippedLabel("budget:fading — budget")).toBe("Fading items not checked");
});

test("skipped labels", () => {
  expect(skippedLabel("pull:drive_mix")).toBe("Drive mix not checked");
  expect(skippedLabel({ part: "inbox:Overwatch: fading — Oct 26" })).toBe("an Action Required item not raised");
  expect(skippedLabel("task_health")).toBe("Scheduled tasks not checked");
});

test("a failed run: one red wording, nothing else", () => {
  const out = statusLine({
    nightly: { status: "failed", finished_at: at(4, 22), details: { failure_kind: "note_write", skipped: ["count:fading"] } },
  }, NOW);
  expect(out).toEqual({ text: "Scan failed · see Action Required", warning: true });
});

test("this morning's weekly counts; last week's does not", () => {
  const nightly = { status: "ok", finished_at: at(4, 31), details: {} };
  const failed = { status: "failed", details: {} };
  expect(statusLine({ nightly, weekly: { ...failed, started_at: at(4, 35) } }, NOW).warning).toBe(true);
  expect(statusLine({ nightly, weekly: { ...failed, started_at: at(4, 35, 19) } }, NOW).warning).toBe(false);
});

test("no run yet", () => {
  expect(statusLine({ nightly: null, weekly: null }, NOW).text).toMatch(/No report yet/);
});
