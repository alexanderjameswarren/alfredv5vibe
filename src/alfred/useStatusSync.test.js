import { useStatusSync } from "./useStatusSync";
import { storage } from "../utils/storage";

let mockRows = {};
jest.mock("../supabaseClient", () => ({
  supabase: {
    from: (table) => ({ select: () => ({ in: async () => ({ data: mockRows[table] || [], error: null }) }) }),
  },
}));
jest.mock("../utils/storage", () => ({
  storage: { patch: jest.fn() },
  writeError: (what) => new Error(what),
}));

function setup() {
  const showNotice = jest.fn();
  const { watchStatus } = useStatusSync({ setIntents: jest.fn(), setItems: jest.fn(), showNotice });
  return { watchStatus, showNotice };
}

beforeEach(() => {
  jest.clearAllMocks();
  storage.patch.mockImplementation(async (key, fields) => ({ id: key.split(":")[1], ...fields }));
});

test("reports the flip without a notice, and its restore puts Background back", async () => {
  mockRows = { intents: [{ id: "a", status: "active" }], items: [{ id: "it", status: "active" }] };
  const { watchStatus, showNotice } = setup();
  const settle = watchStatus({ intents: [{ id: "a", status: "background" }], items: [{ id: "it", status: "someday" }] });
  const flip = await settle({ announce: false });
  expect(flip.moved).toBe(true);
  expect(showNotice).not.toHaveBeenCalled();
  await flip.restore();
  // Someday cannot come back (status_guard); Background can.
  expect(storage.patch).toHaveBeenCalledTimes(1);
  expect(storage.patch).toHaveBeenCalledWith("intent:a", { status: "background" });
});

test("restore stops at a failed write", async () => {
  mockRows = { intents: [{ id: "a", status: "active" }, { id: "b", status: "active" }] };
  const { watchStatus } = setup();
  const settle = watchStatus({ intents: [{ id: "a", status: "background" }, { id: "b", status: "background" }] });
  const flip = await settle({ announce: false });
  storage.patch.mockResolvedValueOnce(null);
  await expect(flip.restore()).rejects.toThrow("Restoring the status");
  expect(storage.patch).toHaveBeenCalledTimes(1);
});

test("announces by default, and nothing moved means no notice", async () => {
  mockRows = { intents: [{ id: "a", status: "active" }] };
  const { watchStatus, showNotice } = setup();
  expect((await watchStatus({ intents: [{ id: "a", status: "background" }] })()).moved).toBe(true);
  expect(showNotice).toHaveBeenCalledWith("Moved to Active");
  showNotice.mockClear();
  expect((await watchStatus({ intents: [{ id: "a", status: "active" }] })()).moved).toBe(false);
  expect(showNotice).not.toHaveBeenCalled();
});
