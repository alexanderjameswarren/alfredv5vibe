// Invented data only. The fake client logs each query and answers it through
// mockRespond(table, ops).
let mockLog = [];
let mockRespond = () => ({ data: [], error: null });

jest.mock("../supabaseClient", () => {
  const from = (table) => {
    const ops = [];
    mockLog.push({ table, ops });
    const finish = () => Promise.resolve(mockRespond(table, ops));
    const b = new Proxy({}, {
      get: (_t, k) => {
        if (k === "then") return (res, rej) => finish().then(res, rej);
        if (k === "maybeSingle" || k === "single") return () => { ops.push([k]); return finish(); };
        return (...a) => { ops.push([k, ...a]); return b; };
      },
    });
    return b;
  };
  return { supabase: { from } };
});

const api = require("./moneyApi");
const has = (ops, k) => ops.some((o) => o[0] === k);
const op = (table, k) => mockLog.filter((q) => q.table === table).flatMap((q) => q.ops).filter((o) => o[0] === k);
const writes = () => mockLog.filter((q) => has(q.ops, "insert") || has(q.ops, "update"));

beforeEach(() => {
  mockLog = [];
  mockRespond = () => ({ data: [], error: null });
});

describe("updateAccount", () => {
  it("refuses sync-owned fields and writes nothing", async () => {
    await expect(api.updateAccount("a1", { name: "x", notes: "n" })).rejects.toThrow(/cannot be edited here: name/);
    expect(mockLog).toHaveLength(0);
  });

  it("writes human columns with the Money context", async () => {
    mockRespond = () => ({ data: [{ id: "a1" }], error: null });
    await api.updateAccount("a1", { role: "retirement", owner: "joint" });
    expect(op("wb_accounts", "update")[0][1]).toEqual({ role: "retirement", owner: "joint", context_id: api.MONEY_CONTEXT_ID });
  });
});

describe("createManualAccount", () => {
  it("refuses a duplicate name", async () => {
    mockRespond = () => ({ data: [{ id: "old" }], error: null });
    await expect(api.createManualAccount({ name: "Test Fund" })).rejects.toThrow(/already exists/);
    expect(writes()).toHaveLength(0);
  });

  it("inserts a manual row in the Money context", async () => {
    mockRespond = (t, ops) => (has(ops, "insert") ? { data: [{ id: "new" }], error: null } : { data: [], error: null });
    const out = await api.createManualAccount({ name: " Test Fund ", role: "retirement", notes: null });
    expect(out).toEqual({ id: "new" });
    const row = op("wb_accounts", "insert")[0][1];
    expect(row).toMatchObject({ name: "Test Fund", role: "retirement", source: "manual", external_id: null, context_id: api.MONEY_CONTEXT_ID });
  });
});

describe("recordBalance", () => {
  const MANUAL = { id: "m1", source: "manual" };

  it("refuses a synced account", async () => {
    await expect(api.recordBalance({ id: "s1", source: "simplefin" }, { asOf: "2026-01-02", balance: 1 }))
      .rejects.toThrow(/come from the sync/);
    expect(mockLog).toHaveLength(0);
  });

  it("refuses to replace a sync row", async () => {
    mockRespond = () => ({ data: { id: "x", source: "sync" }, error: null });
    await expect(api.recordBalance(MANUAL, { asOf: "2026-01-02", balance: 1 })).rejects.toThrow(/came from the sync/);
    expect(writes()).toHaveLength(0);
  });

  it("inserts a new date, and replaces a manual one", async () => {
    mockRespond = (t, ops) => (has(ops, "insert") ? { data: [{ id: "n" }], error: null } : { data: null, error: null });
    expect(await api.recordBalance(MANUAL, { asOf: "2026-01-02", balance: 10 })).toEqual({ replaced: null });
    expect(op("wb_balance_snapshots", "insert")[0][1]).toMatchObject({
      account_id: "m1", as_of: "2026-01-02", balance: 10, source: "manual", context_id: api.MONEY_CONTEXT_ID,
    });

    mockLog = [];
    mockRespond = (t, ops) => (has(ops, "update") ? { data: [{ id: "x" }], error: null } : { data: { id: "x", source: "import" }, error: null });
    expect(await api.recordBalance(MANUAL, { asOf: "2026-01-02", balance: 12 })).toEqual({ replaced: "import" });
  });

  it("refuses a future date", async () => {
    await expect(api.recordBalance(MANUAL, { asOf: "2999-01-01", balance: 1 })).rejects.toThrow(/future/);
  });
});

describe("reads", () => {
  it("never selects raw transactions", async () => {
    await api.getTransactions("a1");
    expect(op("wb_transactions", "select")[0][1]).not.toMatch(/\braw\b/);
  });

  it("returns null for the sync run when platform_runs is not readable", async () => {
    mockRespond = () => ({ data: null, error: { message: "permission denied" } });
    expect(await api.getLatestSyncRun()).toBeNull();
  });
});
