import { nextOccurrence } from "./recurrence";

const daily = { type: "fixed", frequency: "daily", interval: 1 };
const everyThreeDays = { type: "fixed", frequency: "daily", interval: 3 };
const tuesdays = { type: "fixed", frequency: "weekly", interval: 1, daysOfWeek: [2] };
const monthly14 = { type: "fixed", frequency: "monthly", interval: 1, dayOfMonth: 14 };
const threeWeeksAfter = { type: "interval", every: 3, unit: "weeks" };

// 2026-10-12 is a Monday, 2026-10-13 a Tuesday.
describe("nextOccurrence: fixed schedules count from the event's date, never before today", () => {
  test("Micro Workout: daily, started Monday, closed Tuesday morning -> Tuesday", () => {
    expect(nextOccurrence(daily, { eventDate: "2026-10-12", completedOn: "2026-10-13", today: "2026-10-13" })).toBe(
      "2026-10-13",
    );
  });

  test("daily, closed the same day -> tomorrow", () => {
    expect(nextOccurrence(daily, { eventDate: "2026-10-13", today: "2026-10-13" })).toBe("2026-10-14");
  });

  test("an event long overdue steps forward to today, not into the past", () => {
    expect(nextOccurrence(daily, { eventDate: "2026-10-01", today: "2026-10-13" })).toBe("2026-10-13");
  });

  test("every 3 days keeps its cadence from the event's date", () => {
    // 10-01, 10-04, 10-07, 10-10, 10-13
    expect(nextOccurrence(everyThreeDays, { eventDate: "2026-10-01", today: "2026-10-12" })).toBe("2026-10-13");
  });

  test("weekly on Tuesday, Tuesday's run closed on Wednesday -> next Tuesday", () => {
    expect(nextOccurrence(tuesdays, { eventDate: "2026-10-13", today: "2026-10-14" })).toBe("2026-10-20");
  });

  test("monthly on the 14th", () => {
    expect(nextOccurrence(monthly14, { eventDate: "2026-10-14", today: "2026-10-14" })).toBe("2026-11-14");
  });

  test("no event date: the first occurrence on or after today", () => {
    expect(nextOccurrence(daily, { today: "2026-10-13" })).toBe("2026-10-13");
  });
});

describe("nextOccurrence: rule A, the earlier of scheduled and completed", () => {
  test("scheduled Mon Oct 19, completed early Sat Oct 17, daily -> Sun Oct 18", () => {
    expect(nextOccurrence(daily, { eventDate: "2026-10-19", completedOn: "2026-10-17", today: "2026-10-17" })).toBe(
      "2026-10-18",
    );
  });

  test("scheduled Oct 7, backfilled as completed Oct 7, daily -> today", () => {
    expect(nextOccurrence(daily, { eventDate: "2026-10-07", completedOn: "2026-10-07", today: "2026-10-17" })).toBe(
      "2026-10-17",
    );
  });

  test("weekly on Tuesday, scheduled Tue Oct 20, completed Sat Oct 17 -> Tue Oct 20", () => {
    expect(nextOccurrence(tuesdays, { eventDate: "2026-10-20", completedOn: "2026-10-17", today: "2026-10-17" })).toBe(
      "2026-10-20",
    );
  });

  test("a skip counts from the skipped date, not from today", () => {
    expect(nextOccurrence(daily, { eventDate: "2026-10-20", completedOn: "2026-10-17", today: "2026-10-17", skipped: true })).toBe(
      "2026-10-21",
    );
  });
});

describe("nextOccurrence: interval from completion", () => {
  test("counts from the completion, not the event", () => {
    expect(
      nextOccurrence(threeWeeksAfter, { eventDate: "2026-10-01", completedOn: "2026-10-13", today: "2026-10-13" }),
    ).toBe("2026-11-03");
  });

  test("skipped: the skipped date plus one interval", () => {
    expect(
      nextOccurrence(threeWeeksAfter, { eventDate: "2026-10-10", today: "2026-10-13", skipped: true }),
    ).toBe("2026-10-31");
  });

  test("skipped long ago: clamped to today", () => {
    expect(
      nextOccurrence(threeWeeksAfter, { eventDate: "2026-08-01", today: "2026-10-13", skipped: true }),
    ).toBe("2026-10-13");
  });
});

test("once and null never recur", () => {
  expect(nextOccurrence({ type: "once" }, { today: "2026-10-13" })).toBeNull();
  expect(nextOccurrence(null, { today: "2026-10-13" })).toBeNull();
});
