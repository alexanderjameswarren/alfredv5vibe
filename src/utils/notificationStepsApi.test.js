/**
 * notificationStepsApi — the READ + WRITE pipeline, not the planner.
 *
 * The planner tests call planCompletion with rows already in hand, which
 * bypasses exactly the layer that failed in production: if the fetch never
 * loads a `sent` row, the planner correctly decides there is nothing to do and
 * no write is attempted. That looks identical to "the chain is finished".
 *
 * These tests drive the whole path — fetch, plan, apply — against a mocked
 * PostgREST, so a state filter reintroduced into any read is caught here.
 */

jest.mock("../supabaseClient", () => {
  const state = {
    rows: [],
    updates: [],
    selectFilters: [],
    failUpdateFor: null,
    hideFromSelect: () => false,
    hideFromUpdate: () => false,
  };

  const result = (data, error = null) => Promise.resolve({ data, error });

  function from(table) {
    if (table !== "notification_steps") {
      return { select: () => ({ eq: () => result([]) }) };
    }
    return {
      select: (columns) => {
        // Record every filter applied to a read, so a `.eq("state", …)` or
        // `.in("state", […])` sneaking back in is visible to assertions.
        const filters = { columns, eq: {}, in: {} };
        state.selectFilters.push(filters);
        const chain = {
          eq: (col, val) => {
            filters.eq[col] = val;
            return chain;
          },
          in: (col, vals) => {
            filters.in[col] = vals;
            return chain;
          },
          order: () =>
            result(
              state.rows
                .filter((r) => !state.hideFromSelect(r))
                .filter((r) =>
                  Object.entries(filters.eq).every(([k, v]) => r[k] === v)
                )
                .sort((a, b) => a.seq - b.seq)
            ),
        };
        return chain;
      },
      update: (fields) => ({
        eq: (col, val) => {
          const applied = { fields, [col]: val };
          const chain = {
            eq: (col2, val2) => {
              applied[col2] = val2;
              return chain;
            },
            select: () => {
              if (state.failUpdateFor === applied.id) {
                return result(null, { message: "simulated write failure" });
              }
              const row = state.rows.find((r) => r.id === applied.id);
              // RLS filtering an UPDATE returns zero rows and NO error.
              if (!row || state.hideFromUpdate(row)) return result([], null);
              // Honour a state guard if the caller applied one.
              if (applied.state !== undefined && row.state !== applied.state) {
                return result([], null);
              }
              Object.assign(row, fields);
              state.updates.push({ id: applied.id, ...fields });
              return result([{ id: applied.id }], null);
            },
          };
          return chain;
        },
      }),
      insert: (rows) => ({
        select: () => {
          const inserted = rows.map((r, i) => ({ id: `new-${i}`, ...r }));
          state.rows.push(...inserted);
          return result(inserted, null);
        },
      }),
    };
  }

  return { supabase: { from }, __state: state };
});

const { __state: state } = require("../supabaseClient");
const {
  getNotificationSteps,
  completeNotificationStep,
  cancelNotificationSteps,
  resumeNotificationSteps,
} = require("./notificationStepsApi");

const EXEC = "exec-1";
const T0 = new Date("2026-09-04T21:20:00.000Z");

const step = (name, offsetMinutes) => ({
  name,
  displayType: "step",
  ...(offsetMinutes === undefined ? {} : { offsetMinutes }),
});

// The production case: Chop / Saute / Marinate / Add stock, with Marinate
// already sent by the dispatcher.
const RECIPE = [step("Chop"), step("Saute", 10), step("Marinate", 30), step("Add stock", 5)];

const sentChainRows = () => [
  { id: "r2", execution_id: EXEC, seq: 2, text: "Saute", offset_minutes: 10, state: "done", due_at: null, sent_at: null, completed_at: T0.toISOString() },
  { id: "r3", execution_id: EXEC, seq: 3, text: "Marinate", offset_minutes: 30, state: "sent", due_at: "2026-09-04T21:00:27.000Z", sent_at: "2026-09-04T21:16:03.000Z", completed_at: null },
  { id: "r4", execution_id: EXEC, seq: 4, text: "Add stock", offset_minutes: 5, state: "waiting", due_at: null, sent_at: null, completed_at: null },
];

beforeEach(() => {
  state.rows = sentChainRows();
  state.updates = [];
  state.selectFilters = [];
  state.failUpdateFor = null;
  state.hideFromSelect = () => false;
  state.hideFromUpdate = () => false;
});

describe("getNotificationSteps loads rows in EVERY state", () => {
  it("returns a sent row, not just waiting and scheduled ones", async () => {
    // The reported failure would happen here: a read that filtered to
    // ['waiting','scheduled'] would drop r3, the planner would see nothing to
    // do, and no write would be attempted — indistinguishable from a finished
    // chain.
    const rows = await getNotificationSteps(EXEC);
    expect(rows.map((r) => r.state)).toEqual(["done", "sent", "waiting"]);
  });

  it("applies NO state filter at all", async () => {
    await getNotificationSteps(EXEC);
    const read = state.selectFilters[0];
    expect(read.eq.state).toBeUndefined();
    expect(read.in.state).toBeUndefined();
    expect(read.eq.execution_id).toBe(EXEC);
  });

  it("selects the state column, which the planner needs", async () => {
    await getNotificationSteps(EXEC);
    expect(state.selectFilters[0].columns).toContain("state");
  });
});

describe("completing an element whose row was already SENT", () => {
  it("writes BOTH the done transition and the next row's schedule", async () => {
    // End to end through the fetch. This is the production failure.
    await completeNotificationStep(EXEC, RECIPE, 2, T0);

    expect(state.updates).toEqual([
      { id: "r3", state: "done", completed_at: T0.toISOString() },
      { id: "r4", state: "scheduled", due_at: "2026-09-04T21:25:00.000Z" },
    ]);
  });

  it("leaves the rows in the expected end state", async () => {
    await completeNotificationStep(EXEC, RECIPE, 2, T0);
    const byId = Object.fromEntries(state.rows.map((r) => [r.id, r]));
    expect(byId.r3.state).toBe("done");
    expect(byId.r4.state).toBe("scheduled");
    expect(byId.r4.due_at).toBe("2026-09-04T21:25:00.000Z");
  });

  it("is idempotent — re-completing writes nothing further", async () => {
    await completeNotificationStep(EXEC, RECIPE, 2, T0);
    state.updates = [];
    await completeNotificationStep(EXEC, RECIPE, 2, new Date("2026-09-04T22:00:00.000Z"));
    expect(state.updates).toEqual([]);
  });
});

describe("a silently denied write is no longer silent", () => {
  it("throws when an update matches no rows", async () => {
    // RLS filtering an UPDATE returns zero rows and no error. Before
    // `.select("id")` this was indistinguishable from success.
    state.hideFromUpdate = (r) => r.id === "r3";
    await expect(completeNotificationStep(EXEC, RECIPE, 2, T0)).rejects.toThrow(
      /matched no rows/
    );
  });

  it("still schedules the next row when RLS hides the sent row from the READ", async () => {
    // Rules a hypothesis OUT. If RLS hid only the sent row, the planner would
    // never see it and would write no `done` — but the NEXT row's schedule
    // depends on the elements snapshot, not on that row, so r4 would still
    // have advanced. In production r4 did not advance, so per-row read
    // filtering cannot be the explanation.
    state.hideFromSelect = (r) => r.id === "r3";
    await completeNotificationStep(EXEC, RECIPE, 2, T0);
    expect(state.updates.map((u) => u.id)).toEqual(["r4"]);
  });

  it("still applies the OTHER patch when one fails", async () => {
    // The fail-fast loop was why both effects vanished together. r4 must still
    // be scheduled even though r3's write failed.
    state.failUpdateFor = "r3";
    await expect(completeNotificationStep(EXEC, RECIPE, 2, T0)).rejects.toThrow();
    expect(state.updates.map((u) => u.id)).toEqual(["r4"]);
    expect(state.rows.find((r) => r.id === "r4").state).toBe("scheduled");
  });

  it("reports how many landed and how many failed", async () => {
    state.failUpdateFor = "r3";
    const err = await completeNotificationStep(EXEC, RECIPE, 2, T0).catch((e) => e);
    expect(err.applied).toBe(1);
    expect(err.failures).toHaveLength(1);
    expect(err.failures[0].id).toBe("r3");
  });
});

describe("cancel and resume also read every state", () => {
  it("cancel moves a sent row to cancelled", async () => {
    await cancelNotificationSteps(EXEC);
    const byId = Object.fromEntries(state.rows.map((r) => [r.id, r]));
    expect(byId.r3.state).toBe("cancelled"); // was sent
    expect(byId.r4.state).toBe("cancelled"); // was waiting
    expect(byId.r2.state).toBe("done"); // already terminal, untouched
  });

  it("cancel applies no state filter on its read", async () => {
    await cancelNotificationSteps(EXEC);
    expect(state.selectFilters[0].eq.state).toBeUndefined();
    expect(state.selectFilters[0].in.state).toBeUndefined();
  });

  it("resume re-times only an overdue scheduled row", async () => {
    state.rows = [
      { id: "a", execution_id: EXEC, seq: 1, state: "scheduled", due_at: "2020-01-01T00:00:00.000Z", offset_minutes: 5 },
      { id: "b", execution_id: EXEC, seq: 2, state: "sent", due_at: "2020-01-01T00:00:00.000Z", offset_minutes: 5 },
    ];
    await resumeNotificationSteps(EXEC, T0);
    expect(state.updates).toEqual([{ id: "a", due_at: T0.toISOString() }]);
  });

  it("resume applies no state filter on its read", async () => {
    await resumeNotificationSteps(EXEC, T0);
    expect(state.selectFilters[0].eq.state).toBeUndefined();
    expect(state.selectFilters[0].in.state).toBeUndefined();
  });
});

describe("rowsSeen distinguishes 'no chain' from 'cannot see the chain'", () => {
  it("reports how many rows the fetch actually returned", async () => {
    const r = await completeNotificationStep(EXEC, RECIPE, 2, T0);
    expect(r.rowsSeen).toBe(3);
  });

  it("reports zero when RLS hides every row, not silence", async () => {
    // Identical from the client to an item with no offsets — which is why the
    // count is surfaced rather than inferred.
    state.hideFromSelect = () => true;
    const r = await completeNotificationStep(EXEC, RECIPE, 2, T0);
    expect(r.rowsSeen).toBe(0);
    expect(state.updates).toEqual([]);
  });
});

describe("an execution with no chain", () => {
  it("writes nothing and does not throw", async () => {
    state.rows = [];
    await expect(completeNotificationStep(EXEC, RECIPE, 2, T0)).resolves.toEqual({
      complete: [],
      schedule: [],
      rowsSeen: 0,
    });
    expect(state.updates).toEqual([]);
  });
});
