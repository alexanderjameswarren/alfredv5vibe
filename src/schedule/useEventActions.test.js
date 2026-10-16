import { useEventActions } from "./useEventActions";
import { storage } from "../utils/storage";
import { getTodayDate } from "../utils/eventDates";

jest.mock("../utils/storage", () => ({
  storage: { set: jest.fn(), get: jest.fn(), delete: jest.fn() },
  writeError: (what) => new Error(what),
}));

const today = getTodayDate();
const daysFrom = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function setup(intent, events = []) {
  storage.get.mockResolvedValue(intent);
  storage.set.mockImplementation(async (_, v) => v);
  return useEventActions({
    user: { id: "u" },
    events,
    setEvents: jest.fn(),
    intents: [intent],
    withLoading: (_, fn) => fn(),
    offerUndoFor: jest.fn(),
  });
}

const daily = { id: "i", status: "active", recurrenceConfig: { type: "fixed", frequency: "daily", interval: 1 } };

beforeEach(() => jest.clearAllMocks());

test("a daily run whose event was yesterday makes today's event, not tomorrow's", async () => {
  const yesterday = { id: "e", intentId: "i", time: daysFrom(-1), archived: true };
  const next = await setup(daily, [yesterday]).triggerRecurrence("i", yesterday);
  expect(next.time).toBe(today);
});

test("a date passed in is used as given", async () => {
  const event = { id: "e", intentId: "i", time: today, archived: true };
  const next = await setup(daily, [event]).triggerRecurrence("i", event, { nextDate: daysFrom(5) });
  expect(next.time).toBe(daysFrom(5));
});

test("nothing past the end date", async () => {
  const event = { id: "e", intentId: "i", time: today, archived: true };
  const next = await setup({ ...daily, endDate: today }, [event]).triggerRecurrence("i", event);
  expect(next).toBeNull();
});

test("skipping an interval repeat counts from the skipped date", async () => {
  const interval = { id: "i", status: "active", recurrenceConfig: { type: "interval", every: 3, unit: "days" } };
  const event = { id: "e", intentId: "i", time: daysFrom(-1), archived: true };
  const next = await setup(interval, [event]).triggerRecurrence("i", event, { skipped: true });
  expect(next.time).toBe(daysFrom(2));
});
