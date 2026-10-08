import { scheduledText } from "./ScheduledLine";

const day = (offset) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

test("no event", () => {
  expect(scheduledText({ live: null, open: null })).toBe("Not scheduled");
});

test("future date reads Scheduled, past date reads Overdue", () => {
  expect(scheduledText({ live: { time: day(3) }, open: null })).toMatch(/^Scheduled · /);
  expect(scheduledText({ live: { time: day(-2) }, open: null })).toMatch(/^Overdue · /);
});

test("an open execution reads In progress or Paused", () => {
  expect(scheduledText({ live: { time: day(0) }, open: { status: "active" } })).toMatch(/^In progress · Today/);
  expect(scheduledText({ live: { time: day(0) }, open: { status: "paused" } })).toMatch(/^Paused · /);
});
