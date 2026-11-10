// Invented data only. The fake client logs each query and answers it through mockRespond(table, ops).
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
        if (k === "maybeSingle") return () => { ops.push([k]); return finish(); };
        return (...a) => { ops.push([k, ...a]); return b; };
      },
    });
    return b;
  };
  const rpc = (fn, params) => {
    mockLog.push({ table: `rpc:${fn}`, ops: [["params", params]] });
    return Promise.resolve(mockRespond(`rpc:${fn}`, []));
  };
  return { supabase: { from, rpc } };
});

const api = require("./homerApi");
const has = (q, ...op) => q.ops.some((o) => JSON.stringify(o) === JSON.stringify(op));

beforeEach(() => {
  mockLog = [];
  mockRespond = () => ({ data: [], error: null });
  jest.spyOn(console, "warn").mockImplementation(() => {});
});

test("queue: alex's live items in position order", async () => {
  mockRespond = (t) => (t === "homer_readers" ? { data: { id: "r1" }, error: null } : { data: [{ id: "q1" }], error: null });
  expect(await api.getQueue()).toEqual([{ id: "q1" }]);
  const [reader, queue] = mockLog;
  expect(has(reader, "eq", "key", "alex")).toBe(true);
  expect(has(queue, "eq", "reader_id", "r1")).toBe(true);
  expect(has(queue, "is", "archived_at", null)).toBe(true);
  expect(has(queue, "order", "position", { ascending: true })).toBe(true);
});

test("queue: no reader row means an empty queue", async () => {
  mockRespond = () => ({ data: null, error: null });
  expect(await api.getQueue()).toEqual([]);
  expect(mockLog).toHaveLength(1);
});

test("quiet series calls the rpc for alex; errors become a plain message", async () => {
  await api.getQuietSeries();
  expect(mockLog[0]).toEqual({ table: "rpc:homer_quiet_series", ops: [["params", { p_reader_key: "alex" }]] });
  mockRespond = () => ({ data: null, error: { message: "boom" } });
  await expect(api.getQuietSeries()).rejects.toThrow("Could not load the series gone quiet. Please try again.");
});

test("active plan: null before calibration", async () => {
  mockRespond = () => ({ data: null, error: null });
  expect(await api.getActivePlan()).toBeNull();
  expect(has(mockLog[0], "eq", "status", "active")).toBe(true);
});
