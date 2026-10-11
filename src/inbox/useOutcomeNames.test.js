import { fetchOutcomeNames, outcomeIdsByTable } from "./useOutcomeNames";
import { supabase } from "../supabaseClient";

jest.mock("../supabaseClient", () => ({ supabase: { from: jest.fn() } }));

const DB = {
  items: [{ id: "i1", name: "Acme item" }],
  intents: [{ id: "n1", text: "Apply to Acme" }],
  job_applications: [{ id: "j1", org: "Acme", role: "Engineer" }],
};

beforeEach(() => {
  supabase.from.mockReset();
  supabase.from.mockImplementation((table) => ({
    select: () => ({
      in: async (_col, ids) => ({ data: DB[table].filter((r) => ids.includes(r.id)), error: null }),
    }),
  }));
});

const ROWS = [
  { outcome: [{ table: "items", id: "i1" }, { table: "intents", id: "n1" }] },
  { outcome: [{ table: "items", id: "i1" }, { table: "items", id: "gone" }] },
  { outcome: [{ table: "job_applications", id: "j1" }, { table: "mystery", id: "x" }] },
  { outcome: [] },
];

describe("outcomeIdsByTable", () => {
  it("dedupes and skips unknown tables", () => {
    expect(outcomeIdsByTable(ROWS)).toEqual({ items: ["gone", "i1"], intents: ["n1"], job_applications: ["j1"] });
  });
});

describe("fetchOutcomeNames", () => {
  it("queries each table once", async () => {
    await fetchOutcomeNames(ROWS);
    expect(supabase.from.mock.calls.map((c) => c[0]).sort()).toEqual(["intents", "items", "job_applications"]);
  });

  it("names found rows and nulls missing ones", async () => {
    const names = await fetchOutcomeNames(ROWS);
    expect(names).toEqual({
      "items:i1": "Acme item",
      "items:gone": null,
      "intents:n1": "Apply to Acme",
      "job_applications:j1": "Engineer at Acme",
    });
  });
});
