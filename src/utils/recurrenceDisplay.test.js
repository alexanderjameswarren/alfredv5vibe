import { describeRepeat, repeatPattern, repeats, longDate, getRecurrenceDisplayString } from "./recurrenceDisplay";

const today = "2026-10-14";
const fixed = (frequency, extra = {}) => ({ type: "fixed", frequency, interval: 1, ...extra });

describe("repeatPattern: every shape", () => {
  test.each([
    [{ type: "once" }, "Does not repeat"],
    [null, "Does not repeat"],
    [{ type: "chain" }, "Does not repeat"],
    [{ frequency: "daily", interval: 1 }, "Does not repeat"],
    [fixed("daily"), "Every day"],
    [fixed("daily", { interval: 3 }), "Every 3 days"],
    [fixed("weekly", { daysOfWeek: [2] }), "Every week on Tuesday"],
    [fixed("weekly", { daysOfWeek: [5, 1, 3] }), "Every week on Monday, Wednesday and Friday"],
    [fixed("weekly", { daysOfWeek: [1, 2, 3, 4, 5] }), "Every weekday, Monday to Friday"],
    [fixed("weekly", { interval: 2, daysOfWeek: [2] }), "Every 2 weeks on Tuesday"],
    [fixed("weekly", { daysOfWeek: [] }), "Every week, with no day chosen"],
    [fixed("monthly", { dayOfMonth: 14 }), "Every month on the 14th"],
    [fixed("monthly", { interval: 3, dayOfMonth: 1 }), "Every 3 months on the 1st"],
    [fixed("monthly", { ordinal: "first", dayOfWeek: 1 }), "Every month on the first Monday"],
    [fixed("monthly", { ordinal: "last", dayOfWeek: "weekday" }), "Every month on the last weekday"],
    [fixed("monthly"), "Every month, with no day chosen"],
    [{ type: "interval", every: 3, unit: "weeks" }, "3 weeks after you last did it"],
    [{ type: "interval", every: 1, unit: "days" }, "1 day after you last did it"],
    [{ type: "interval", every: 6, unit: "months" }, "6 months after you last did it"],
  ])("%j", (config, text) => {
    expect(repeatPattern(config)).toBe(text);
  });

  test("once, null and unknown shapes do not repeat", () => {
    expect([{ type: "once" }, null, { type: "chain" }].map(repeats)).toEqual([false, false, false]);
  });
});

describe("describeRepeat", () => {
  test("adds the next occurrence with its day name", () => {
    expect(describeRepeat({ config: fixed("daily"), nextDate: "2026-10-15", today })).toBe(
      "Every day · next Thursday, October 15",
    );
  });

  test("names the year when it is not this year's", () => {
    expect(longDate("2027-01-05", today)).toBe("Tuesday, January 5, 2027");
  });

  test("an overdue live event is not called next", () => {
    expect(describeRepeat({ config: fixed("daily"), nextDate: "2026-10-07", today })).toBe("Every day");
    expect(describeRepeat({ config: fixed("daily"), nextDate: today, today })).toBe(
      "Every day · next Wednesday, October 14",
    );
  });

  test("no next without a live event, and none where the row already shows it", () => {
    expect(describeRepeat({ config: fixed("daily"), today })).toBe("Every day");
    expect(describeRepeat({ config: fixed("daily"), nextDate: "2026-10-15", today, showNext: false })).toBe("Every day");
  });

  test("an end date ahead reads until, and a next past it is not shown", () => {
    expect(
      describeRepeat({ config: fixed("daily"), endDate: "2026-10-20", nextDate: "2026-10-21", today }),
    ).toBe("Every day · until October 20");
  });

  test("an end date today or before reads Ended", () => {
    expect(describeRepeat({ config: fixed("daily"), endDate: today, today })).toBe("Ended October 14");
    expect(describeRepeat({ config: fixed("daily"), endDate: "2025-12-01", today })).toBe("Ended December 1, 2025");
  });

  test("once never shows an end or a next", () => {
    expect(describeRepeat({ config: { type: "once" }, endDate: "2025-01-01", nextDate: today, today })).toBe(
      "Does not repeat",
    );
  });
});

test("picker label keeps the until", () => {
  expect(getRecurrenceDisplayString(fixed("daily"), "2026-10-20", today)).toBe("Every day · until October 20");
});
