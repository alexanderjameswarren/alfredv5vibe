import {
  TERMINAL_STATES,
  RESTORABLE_STATES,
  NO_SUBSCRIPTION,
  planRevertToChain,
  planRestore,
  ownsNotificationRow,
  isTickableElement,
  precedingTickableIndex,
  expandNotificationSteps,
  planCompletion,
  planCancellation,
  planResume,
  addMinutes,
} from "./notificationSteps";

const T0 = "2026-09-04T10:00:00.000Z";

const step = (name, offsetMinutes) => ({
  name,
  displayType: "step",
  ...(offsetMinutes === undefined ? {} : { offsetMinutes }),
});
const header = (name) => ({ name, displayType: "header" });
const bullet = (name, offsetMinutes) => ({
  name,
  displayType: "bullet",
  ...(offsetMinutes === undefined ? {} : { offsetMinutes }),
});

// The case the whole semantic change exists for.
const RECIPE = [
  step("Chop onions"),
  step("Saute onions"),
  step("Marinate 30 minutes", 30),
];

describe("ownsNotificationRow", () => {
  it("is true for a step with an offset", () => {
    expect(ownsNotificationRow(step("s", 30))).toBe(true);
  });

  it("is true for a zero offset", () => {
    expect(ownsNotificationRow(step("s", 0))).toBe(true);
  });

  it("is false for a step with no offset", () => {
    expect(ownsNotificationRow(step("s"))).toBe(false);
  });

  it("is false for a bullet even if one somehow carries an offset", () => {
    // Phase 2 prevents authoring this. Enforced here anyway: a bullet has no
    // checkbox in an execution, so a bullet row could never be ticked and
    // would stall the chain permanently.
    expect(ownsNotificationRow(bullet("b", 30))).toBe(false);
  });

  it("is false for a header with an offset", () => {
    expect(ownsNotificationRow({ name: "h", displayType: "header", offsetMinutes: 30 })).toBe(false);
  });

  it("reads the disk spelling", () => {
    expect(ownsNotificationRow({ name: "s", display_type: "step", offset_minutes: 30 })).toBe(true);
  });

  it("is false for a missing or circular step, which has no checkbox", () => {
    // A row owned by an untickable element fires and then stalls the chain
    // forever. Excluded so the chain loses one notification instead.
    expect(ownsNotificationRow({ ...step("s", 30), missing: true })).toBe(false);
    expect(ownsNotificationRow({ ...step("s", 30), circular: true })).toBe(false);
  });

  it("is exactly 'tickable and carrying an offset'", () => {
    // Pinned so the two predicates cannot drift apart: every element that owns
    // a row must be one the UI can actually tick.
    const cases = [
      step("a", 30),
      step("b"),
      bullet("c", 30),
      header("d"),
      { ...step("e", 30), missing: true },
      { ...step("f", 30), circular: true },
      { name: "g", displayType: "note", offsetMinutes: 5 },
    ];
    for (const el of cases) {
      expect(ownsNotificationRow(el)).toBe(
        isTickableElement(el) && el.offsetMinutes !== undefined
      );
    }
  });
});

describe("isTickableElement", () => {
  it("is true for a step", () => {
    expect(isTickableElement(step("s"))).toBe(true);
  });

  it("is false for a header and for a bullet", () => {
    // Checked against ExecutionDetailView: neither renders a checkbox.
    expect(isTickableElement(header("h"))).toBe(false);
    expect(isTickableElement(bullet("b"))).toBe(false);
  });

  it("is true for an unrecognised type, which renders as a step", () => {
    expect(isTickableElement({ name: "x", displayType: "note" })).toBe(true);
  });

  it("is false for missing or circular, whatever the type", () => {
    expect(isTickableElement({ ...step("s"), missing: true })).toBe(false);
    expect(isTickableElement({ ...step("s"), circular: true })).toBe(false);
  });
});

describe("precedingTickableIndex", () => {
  it("finds the nearest earlier step", () => {
    expect(precedingTickableIndex(RECIPE, 2)).toBe(1);
  });

  it("returns -1 at the head of the list", () => {
    expect(precedingTickableIndex(RECIPE, 0)).toBe(-1);
  });

  it("skips headers and bullets", () => {
    const els = [step("a"), header("H"), bullet("b"), step("c", 10)];
    expect(precedingTickableIndex(els, 3)).toBe(0);
  });

  it("returns -1 when only headers and bullets precede", () => {
    const els = [header("H"), bullet("b"), step("c", 10)];
    expect(precedingTickableIndex(els, 2)).toBe(-1);
  });
});

describe("expandNotificationSteps", () => {
  it("creates one row per element with an offset, and none for the rest", () => {
    const rows = expandNotificationSteps(RECIPE, T0);
    expect(rows).toHaveLength(1);
    expect(rows[0].text).toBe("Marinate 30 minutes");
  });

  it("numbers seq by ELEMENT position, leaving gaps", () => {
    // The heart of it: "Marinate" is element 3, not notification 1.
    const rows = expandNotificationSteps(RECIPE, T0);
    expect(rows[0].seq).toBe(3);
  });

  it("does NOT schedule a row that has a preceding step", () => {
    // The superseded reading would have fired this at execution start, 30
    // minutes before the onions were chopped.
    const rows = expandNotificationSteps(RECIPE, T0);
    expect(rows[0].state).toBe("waiting");
    expect(rows[0].due_at).toBeNull();
  });

  it("schedules a row with nothing completable before it", () => {
    const els = [step("Take dose 1", 360), step("Take dose 2", 360)];
    const rows = expandNotificationSteps(els, T0);
    expect(rows[0]).toMatchObject({ seq: 1, state: "scheduled", due_at: T0 });
    expect(rows[1]).toMatchObject({ seq: 2, state: "waiting", due_at: null });
  });

  it("treats a step below only headers and bullets as the head", () => {
    const els = [header("Prep"), bullet("200g flour"), step("Rest dough", 45)];
    const rows = expandNotificationSteps(els, T0);
    expect(rows[0]).toMatchObject({ seq: 3, state: "scheduled", due_at: T0 });
  });

  it("writes rows in the database's spelling", () => {
    const rows = expandNotificationSteps([step("a", 15)], T0);
    expect(Object.keys(rows[0]).sort()).toEqual(
      ["due_at", "offset_minutes", "seq", "state", "text"].sort()
    );
  });

  it("preserves a zero offset", () => {
    const rows = expandNotificationSteps([step("a"), step("b", 0)], T0);
    expect(rows[0].offset_minutes).toBe(0);
  });

  it("returns nothing for an item with no offsets at all", () => {
    expect(expandNotificationSteps([step("a"), step("b")], T0)).toEqual([]);
  });

  it("tolerates junk", () => {
    expect(expandNotificationSteps(null, T0)).toEqual([]);
    expect(expandNotificationSteps(undefined, T0)).toEqual([]);
  });
});

describe("planCompletion", () => {
  const rowsFor = (elements) =>
    expandNotificationSteps(elements, T0).map((r, i) => ({ ...r, id: `row-${i}` }));

  it("schedules the recipe's notification when the PRECEDING step is ticked", () => {
    const rows = rowsFor(RECIPE);
    // Tick "Saute onions" — element index 1, which owns no row itself.
    const plan = planCompletion(RECIPE, rows, 1, T0);
    expect(plan.complete).toEqual([]);
    expect(plan.schedule).toEqual([
      { id: "row-0", state: "scheduled", due_at: "2026-09-04T10:30:00.000Z" },
    ]);
  });

  it("does nothing when an unrelated element is ticked", () => {
    const rows = rowsFor(RECIPE);
    const plan = planCompletion(RECIPE, rows, 0, T0); // "Chop onions"
    expect(plan.complete).toEqual([]);
    expect(plan.schedule).toEqual([]);
  });

  it("closes a row when the element owning it is ticked", () => {
    const els = [step("dose 1", 360), step("dose 2", 360)];
    const rows = rowsFor(els);
    const plan = planCompletion(els, rows, 0, T0);
    expect(plan.complete).toEqual([
      { id: "row-0", state: "done", completed_at: T0 },
    ]);
  });

  it("closes one row and starts the next in the same tick", () => {
    const els = [step("dose 1", 360), step("dose 2", 360)];
    const rows = rowsFor(els);
    const plan = planCompletion(els, rows, 0, T0);
    expect(plan.complete).toHaveLength(1);
    expect(plan.schedule).toEqual([
      { id: "row-1", state: "scheduled", due_at: "2026-09-04T16:00:00.000Z" },
    ]);
  });

  it("drifts: the next due time is measured from the actual completion", () => {
    const els = [step("dose 1", 360), step("dose 2", 360)];
    const rows = rowsFor(els);
    const late = "2026-09-04T10:35:00.000Z"; // 35 minutes late
    const plan = planCompletion(els, rows, 0, late);
    expect(plan.schedule[0].due_at).toBe("2026-09-04T16:35:00.000Z");
  });

  it("does not reschedule a row that is already scheduled", () => {
    // Un-ticking and re-ticking must not push a live due time further out.
    const els = [step("a", 10), step("b", 10)];
    const rows = rowsFor(els).map((r) =>
      r.seq === 2 ? { ...r, state: "scheduled", due_at: T0 } : r
    );
    const plan = planCompletion(els, rows, 0, T0);
    expect(plan.schedule).toEqual([]);
  });

  it("does not reopen a terminal row", () => {
    const els = [step("a", 10)];
    const rows = rowsFor(els).map((r) => ({ ...r, state: "cancelled" }));
    expect(planCompletion(els, rows, 0, T0).complete).toEqual([]);
  });

  it("handles a zero offset as immediately due", () => {
    const els = [step("a"), step("b", 0)];
    const rows = rowsFor(els);
    const plan = planCompletion(els, rows, 0, T0);
    expect(plan.schedule[0].due_at).toBe(T0);
  });

  it("skips over a bullet between two steps", () => {
    // The case that would have stalled if bullets counted as clock-starters.
    const els = [step("Prep"), bullet("200g flour"), step("Rest", 45)];
    const rows = rowsFor(els);
    const plan = planCompletion(els, rows, 0, T0);
    expect(plan.schedule).toHaveLength(1);
    expect(plan.schedule[0].due_at).toBe("2026-09-04T10:45:00.000Z");
  });
});

describe("a broken step degrades the chain instead of stalling it", () => {
  // `missing` (deleted child item) and `circular` (reference loop) are set by
  // flattenElements when the execution snapshot is taken, so they are known at
  // expansion time. Previously such a step could own a row, fire, and never be
  // tickable — the chain stopped there permanently.
  const broken = (name, offsetMinutes, flag) => ({
    ...step(name, offsetMinutes),
    [flag]: true,
  });

  it.each([["missing"], ["circular"]])("owns no row when %s", (flag) => {
    const els = [step("a", 10), broken("b", 20, flag), step("c", 30)];
    const rows = expandNotificationSteps(els, T0);
    expect(rows.map((r) => r.seq)).toEqual([1, 3]);
  });

  it("looks back past the broken step to the last real one", () => {
    const els = [step("a", 10), broken("b", 20, "missing"), step("c", 30)];
    // Element 2's clock is started by element 0, not by the unusable element 1.
    expect(precedingTickableIndex(els, 2)).toBe(0);

    const rows = expandNotificationSteps(els, T0).map((r, i) => ({ ...r, id: `row-${i}` }));
    const plan = planCompletion(els, rows, 0, T0);
    expect(plan.schedule).toEqual([
      { id: "row-1", state: "scheduled", due_at: "2026-09-04T10:30:00.000Z" },
    ]);
  });

  it("loses exactly one notification, not the rest of the chain", () => {
    const els = [step("a", 10), broken("b", 20, "circular"), step("c", 30)];
    const rows = expandNotificationSteps(els, T0);
    expect(rows).toHaveLength(2); // "b" lost; "a" and "c" survive
    expect(rows.map((r) => r.text)).toEqual(["a", "c"]);
  });

  it("still schedules the head when the broken step is first", () => {
    const els = [broken("a", 10, "missing"), step("b", 20)];
    const rows = expandNotificationSteps(els, T0);
    // "b" now has nothing tickable before it, so it becomes the head.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ seq: 2, state: "scheduled", due_at: T0 });
  });
});

describe("the chain advances past a step that has already been SENT", () => {
  // The state machine was written when states were waiting -> scheduled ->
  // done. The dispatcher added `sent` as an intermediate. If any switch had
  // been left comparing against `scheduled`, a chain could never advance past
  // a notification that actually fired — which is every real use of this
  // feature. Phase 4's tests could not catch it because nothing sent anything.
  const els = [
    step("Chop"),
    step("Saute", 10),
    step("Marinate", 30),
    step("Add stock", 5),
  ];
  const sentChain = () => [
    { id: "r2", seq: 2, state: "done", offset_minutes: 10 },
    { id: "r3", seq: 3, state: "sent", offset_minutes: 30, sent_at: T0 },
    { id: "r4", seq: 4, state: "waiting", offset_minutes: 5 },
  ];

  it("marks a sent row done when its element is ticked", () => {
    const plan = planCompletion(els, sentChain(), 2, T0);
    expect(plan.complete).toEqual([
      { id: "r3", state: "done", completed_at: T0 },
    ]);
  });

  it("still schedules the NEXT row off that same tick", () => {
    // Both effects hang off one completion, so a guard that dropped the first
    // would take the second with it.
    const plan = planCompletion(els, sentChain(), 2, T0);
    expect(plan.schedule).toEqual([
      { id: "r4", state: "scheduled", due_at: "2026-09-04T10:05:00.000Z" },
    ]);
  });

  it("cancels a sent row on close — sent is not terminal", () => {
    expect(planCancellation(sentChain()).map((p) => p.id)).toEqual(["r3", "r4"]);
  });

  it("does not re-time a sent row on resume", () => {
    // It has already fired; there is nothing to move.
    const rows = [{ id: "r3", state: "sent", due_at: "2020-01-01T00:00:00.000Z" }];
    expect(planResume(rows, T0)).toEqual([]);
  });
});

describe("no_subscription behaves exactly like sent", () => {
  // Set when a step comes due and the user has no push_subscriptions row.
  // Out of the send queue, but NOT terminal: undeliverable is not undoable.
  const els = [step("a", 10), step("b", 20)];
  const rows = () => [
    { id: "r1", seq: 1, state: NO_SUBSCRIPTION, offset_minutes: 10 },
    { id: "r2", seq: 2, state: "waiting", offset_minutes: 20 },
  ];

  it("is not a terminal state", () => {
    expect(TERMINAL_STATES.has(NO_SUBSCRIPTION)).toBe(false);
  });

  it("still marks done when ticked, so the chain is not stuck", () => {
    const plan = planCompletion(els, rows(), 0, T0);
    expect(plan.complete).toEqual([
      { id: "r1", state: "done", completed_at: T0 },
    ]);
  });

  it("still advances the next row", () => {
    const plan = planCompletion(els, rows(), 0, T0);
    expect(plan.schedule).toEqual([
      { id: "r2", state: "scheduled", due_at: "2026-09-04T10:20:00.000Z" },
    ]);
  });

  it("is cancelled on close like any other non-terminal row", () => {
    expect(planCancellation(rows()).map((p) => p.id)).toEqual(["r1", "r2"]);
  });

  it("is not re-timed on resume", () => {
    const stale = [{ id: "r1", state: NO_SUBSCRIPTION, due_at: "2020-01-01T00:00:00.000Z" }];
    expect(planResume(stale, T0)).toEqual([]);
  });
});

describe("a manual time is an override, not a mode change", () => {
  // Steps 1-4, all steps, offsets on 2/3/4.
  const els = [
    step("one", 10),
    step("two", 10),
    step("three", 20),
    step("four", 30),
  ];
  const done = (list, i) =>
    list.map((el, n) => (n === i ? { ...el, isCompleted: true } : el));

  const rows = (overrides = {}) =>
    [
      { id: "r1", seq: 1, offset_minutes: 10, state: "done" },
      { id: "r2", seq: 2, offset_minutes: 10, state: "scheduled" },
      { id: "r3", seq: 3, offset_minutes: 20, state: "waiting" },
      { id: "r4", seq: 4, offset_minutes: 30, state: "waiting" },
    ].map((r) => ({ ...r, ...(overrides[r.id] || {}) }));

  it("THE RULE: a manual time wins over the chain", () => {
    // Step 4 manually scheduled for 2pm; step 3 completed at 1:30. The manual
    // time must survive — a deliberate override outranks an unrelated
    // completion.
    const TWO_PM = "2026-09-06T14:00:00.000Z";
    const ONE_THIRTY = "2026-09-06T13:30:00.000Z";
    const withManual = rows({ r4: { state: "scheduled", due_at: TWO_PM } });

    const plan = planCompletion(els, withManual, 2, ONE_THIRTY);

    // r4 is untouched: not rescheduled to 1:30 + 30min = 2:00 by coincidence,
    // but genuinely absent from the plan.
    expect(plan.schedule.map((p) => p.id)).not.toContain("r4");
    expect(withManual.find((r) => r.id === "r4").due_at).toBe(TWO_PM);
  });

  it("reverting a manual time hands the row back to the chain", () => {
    // Step 3 not yet completed, so step 4 goes dormant and waits for it.
    const row = { id: "r4", seq: 4, offset_minutes: 30, state: "scheduled", due_at: T0 };
    expect(planRevertToChain(els, row, T0)).toEqual({
      id: "r4",
      state: "waiting",
      due_at: null,
      sent_at: null,
    });
  });

  it("and completing the predecessor then arms it normally", () => {
    // The link was never severed: the whole point of the revert.
    const reverted = rows({ r4: { state: "waiting", due_at: null } });
    const plan = planCompletion(els, reverted, 2, T0);
    expect(plan.schedule).toContainEqual({
      id: "r4",
      state: "scheduled",
      due_at: "2026-09-04T10:30:00.000Z",
    });
  });

  it("reverting AFTER the predecessor finished re-arms immediately", () => {
    // Otherwise the row would wait for a completion that has already happened
    // and will never happen again — severed by a different route.
    const elsDone = done(els, 2);
    const row = { id: "r4", seq: 4, offset_minutes: 30, state: "scheduled", due_at: T0 };
    expect(planRevertToChain(elsDone, row, T0)).toEqual({
      id: "r4",
      state: "scheduled",
      due_at: "2026-09-04T10:30:00.000Z",
      sent_at: null,
    });
  });

  it("reverting the head of the chain schedules it now", () => {
    const row = { id: "r1", seq: 1, offset_minutes: 10, state: "cancelled" };
    expect(planRevertToChain(els, row, T0)).toEqual({
      id: "r1",
      state: "scheduled",
      due_at: T0,
      sent_at: null,
    });
  });

  it("clears sent_at on revert, so a resent step is not shown as notified", () => {
    const row = { id: "r4", seq: 4, offset_minutes: 30, state: "sent", sent_at: T0 };
    expect(planRevertToChain(els, row, T0).sent_at).toBeNull();
  });
});

describe("cancelled is restorable, not permanent", () => {
  const els = [step("one", 10), step("two", 20), step("three", 30)];

  it("is still terminal to the CHAIN", () => {
    // Nothing automatic resurrects it; only a user action does.
    expect(TERMINAL_STATES.has("cancelled")).toBe(true);
    expect(RESTORABLE_STATES.has("cancelled")).toBe(true);
  });

  it("restores every cancelled row and nothing else", () => {
    const rows = [
      { id: "a", seq: 1, offset_minutes: 10, state: "cancelled" },
      { id: "b", seq: 2, offset_minutes: 20, state: "cancelled" },
      { id: "c", seq: 3, offset_minutes: 30, state: "done" },
    ];
    const plan = planRestore(els, rows, T0);
    expect(plan.map((p) => p.id)).toEqual(["a", "b"]);
  });

  it("recomputes the due time from NOW, not the original", () => {
    // Reinstating a due_at from an hour ago would fire the instant it was
    // restored, for a moment that has passed.
    const elsDone = [{ ...els[0], isCompleted: true }, els[1], els[2]];
    const rows = [
      { id: "b", seq: 2, offset_minutes: 20, state: "cancelled", due_at: "2020-01-01T00:00:00.000Z" },
    ];
    const plan = planRestore(elsDone, rows, T0);
    expect(plan[0].due_at).toBe("2026-09-04T10:20:00.000Z");
  });

  it("restores a row whose predecessor is not done to waiting", () => {
    const rows = [{ id: "b", seq: 2, offset_minutes: 20, state: "cancelled" }];
    expect(planRestore(els, rows, T0)[0]).toMatchObject({
      state: "waiting",
      due_at: null,
    });
  });

  it("round-trips: cancel then restore leaves the chain workable", () => {
    const rows = [
      { id: "a", seq: 1, offset_minutes: 10, state: "scheduled" },
      { id: "b", seq: 2, offset_minutes: 20, state: "waiting" },
    ];
    const cancelled = planCancellation(rows).map((p) => {
      const r = rows.find((x) => x.id === p.id);
      return { ...r, ...p };
    });
    expect(cancelled.every((r) => r.state === "cancelled")).toBe(true);
    const restored = planRestore(els, cancelled, T0);
    expect(restored.map((p) => p.state)).toEqual(["scheduled", "waiting"]);
  });
});

describe("planCancellation", () => {
  it("cancels every non-terminal row", () => {
    const rows = [
      { id: "a", state: "waiting" },
      { id: "b", state: "scheduled" },
      { id: "c", state: "sent" },
    ];
    expect(planCancellation(rows).map((p) => p.id)).toEqual(["a", "b", "c"]);
    expect(planCancellation(rows).every((p) => p.state === "cancelled")).toBe(true);
  });

  it("leaves terminal rows alone", () => {
    const rows = [
      { id: "a", state: "done" },
      { id: "b", state: "skipped" },
      { id: "c", state: "cancelled" },
    ];
    expect(planCancellation(rows)).toEqual([]);
  });
});

describe("planResume", () => {
  const NOW = "2026-09-04T12:00:00.000Z";

  it("moves an overdue scheduled row to now", () => {
    const rows = [{ id: "a", state: "scheduled", due_at: "2026-09-04T11:00:00.000Z" }];
    expect(planResume(rows, NOW)).toEqual([{ id: "a", due_at: NOW }]);
  });

  it("leaves a future row untouched", () => {
    const rows = [{ id: "a", state: "scheduled", due_at: "2026-09-04T13:00:00.000Z" }];
    expect(planResume(rows, NOW)).toEqual([]);
  });

  it("ignores rows that are not scheduled", () => {
    const rows = [
      { id: "a", state: "waiting", due_at: null },
      { id: "b", state: "sent", due_at: "2026-09-04T11:00:00.000Z" },
      { id: "c", state: "done", due_at: "2026-09-04T11:00:00.000Z" },
    ];
    expect(planResume(rows, NOW)).toEqual([]);
  });
});

describe("addMinutes", () => {
  it("adds minutes", () => {
    expect(addMinutes(T0, 90)).toBe("2026-09-04T11:30:00.000Z");
  });

  it("treats zero as no delay rather than as absent", () => {
    expect(addMinutes(T0, 0)).toBe(T0);
  });

  it("falls back to no delay for a non-number", () => {
    expect(addMinutes(T0, undefined)).toBe(T0);
  });
});
