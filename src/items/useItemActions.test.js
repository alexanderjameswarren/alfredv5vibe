import { useItemActions } from "./useItemActions";
import { storage } from "../utils/storage";

jest.mock("../utils/storage", () => ({
  storage: { patch: jest.fn(), set: jest.fn() },
  writeError: (what) => new Error(what),
}));

// setItems is called with an updater; run it against `state` the way React would.
function setup(items) {
  let state = items;
  let undo = null;
  const setItems = jest.fn((next) => {
    state = typeof next === "function" ? next(state) : next;
  });
  const actions = useItemActions({
    user: { id: "u" },
    items,
    setItems,
    contexts: [],
    withLoading: (_, fn) => fn(),
    offerUndoFor: jest.fn((message, restore) => (undo = { message, restore })),
  });
  return {
    actions,
    undo: () => undo,
    state: () => state,
    // A realtime update or another write landing after the hook captured `items`.
    land: (row) => (state = [...state.filter((i) => i.id !== row.id), row]),
  };
}

const item = { id: "a", name: "P5 undo test", status: "active", archived: false };
const other = { id: "b", name: "Other", status: "active" };

beforeEach(() => {
  jest.clearAllMocks();
  storage.set.mockImplementation(async (_, v) => v);
  storage.patch.mockImplementation(async (key, fields) => ({ id: key.split(":")[1], ...fields }));
});

describe("updateItem", () => {
  it("keeps a change that landed meanwhile", async () => {
    const t = setup([item, other]);
    t.land({ ...other, name: "Renamed elsewhere" });
    t.land({ id: "c", name: "New" });
    await t.actions.updateItem("a", { name: "Edited" });
    expect(t.state().find((i) => i.id === "a").name).toBe("Edited");
    expect(t.state().find((i) => i.id === "b").name).toBe("Renamed elsewhere");
    expect(t.state().map((i) => i.id)).toContain("c");
  });

  it("archive Undo restores the item and keeps other changes", async () => {
    const t = setup([item, other]);
    await t.actions.updateItem("a", { archived: true });
    expect(t.state().find((i) => i.id === "a").archived).toBe(true);
    t.land({ ...other, name: "Renamed elsewhere" });
    await t.undo().restore();
    expect(storage.set).toHaveBeenLastCalledWith("item:a", item, false);
    expect(t.state().find((i) => i.id === "a").archived).toBe(false);
    expect(t.state().find((i) => i.id === "b").name).toBe("Renamed elsewhere");
  });

  it("archive Undo throws on a failed write and leaves the list", async () => {
    const t = setup([item]);
    await t.actions.updateItem("a", { archived: true });
    storage.set.mockResolvedValueOnce(null);
    await expect(t.undo().restore()).rejects.toThrow("Restoring the item");
    expect(t.state()[0].archived).toBe(true);
  });

  it("offers no Undo for a plain edit", async () => {
    const t = setup([item]);
    await t.actions.updateItem("a", { name: "Edited" });
    expect(t.undo()).toBeNull();
  });
});

describe("setItemStatus", () => {
  it("Undo throws on a failed write", async () => {
    const t = setup([item]);
    await t.actions.setItemStatus("a", "background");
    storage.patch.mockResolvedValueOnce(null);
    await expect(t.undo().restore()).rejects.toThrow("Restoring the status");
    expect(t.state()[0].status).toBe("background");
  });

  it("Undo puts the status back", async () => {
    const t = setup([item]);
    await t.actions.setItemStatus("a", "background");
    await t.undo().restore();
    expect(storage.patch).toHaveBeenLastCalledWith("item:a", { status: "active", closedReason: null });
    expect(t.state()[0].status).toBe("active");
  });

  it("reopening a closed item clears its reason; Undo puts the reason and closed date back", async () => {
    const closed = { ...item, status: "closed", closedReason: "wont_do", statusChangedAt: "2026-10-20T12:00:00Z" };
    const t = setup([closed]);
    await t.actions.setItemStatus("a", "active");
    expect(storage.patch).toHaveBeenLastCalledWith("item:a", { status: "active", closedReason: null });
    await t.undo().restore();
    expect(storage.patch).toHaveBeenLastCalledWith("item:a", { status: "closed", closedReason: "wont_do", statusChangedAt: "2026-10-20T12:00:00Z" });
  });
});
