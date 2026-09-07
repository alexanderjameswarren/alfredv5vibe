import {
  OFFSET_UNITS,
  toMinutes,
  splitMinutes,
  hasNumbering,
  stripNumbering,
  describeBlock,
  repeatBlock,
} from "./blockRepeat";

const step = (name, offsetMinutes) => ({
  name,
  displayType: "step",
  quantity: "",
  description: "",
  ...(offsetMinutes === undefined ? {} : { offsetMinutes }),
});
const header = (name) => ({ name, displayType: "header", quantity: "", description: "" });
const bullet = (name) => ({ name, displayType: "bullet", quantity: "", description: "" });

describe("units — nobody should have to know an hour is 60", () => {
  it("converts each unit to minutes", () => {
    expect(toMinutes(6, "hours")).toBe(360);
    expect(toMinutes(90, "minutes")).toBe(90);
    expect(toMinutes(1, "days")).toBe(1440);
  });

  it("shows 360 minutes as 6 hours", () => {
    expect(splitMinutes(360)).toEqual({ value: 6, unitId: "hours" });
  });

  it("leaves 90 minutes as minutes rather than 1.5 hours", () => {
    // The input takes whole numbers; "1.5 hours" is not a thing it accepts.
    expect(splitMinutes(90)).toEqual({ value: 90, unitId: "minutes" });
  });

  it("prefers the largest exact unit", () => {
    expect(splitMinutes(1440)).toEqual({ value: 1, unitId: "days" });
    expect(splitMinutes(120)).toEqual({ value: 2, unitId: "hours" });
  });

  it("keeps zero, which is a legitimate offset", () => {
    expect(splitMinutes(0)).toEqual({ value: 0, unitId: "minutes" });
    expect(toMinutes(0, "hours")).toBe(0);
  });

  it("tolerates junk", () => {
    expect(toMinutes("", "hours")).toBe(0);
    expect(toMinutes(-5, "hours")).toBe(0);
    expect(splitMinutes(undefined).unitId).toBe("minutes");
  });

  it("offers minutes, hours and days", () => {
    expect(OFFSET_UNITS.map((u) => u.id)).toEqual(["minutes", "hours", "days"]);
  });
});

describe("numbering", () => {
  it("recognises generated numbering at the end of a name", () => {
    expect(hasNumbering("Take dose 7 of 20")).toBe(true);
    expect(hasNumbering("Pull 1 of 3")).toBe(true);
  });

  it("does not mistake numbers in the middle of a name", () => {
    // "Take 2 of 3 tablets" is a sentence, not generated numbering.
    expect(hasNumbering("Take 2 of 3 tablets")).toBe(false);
    expect(hasNumbering("Chop onions")).toBe(false);
  });

  it("strips numbering back to the base name", () => {
    expect(stripNumbering("Take dose 7 of 20")).toBe("Take dose");
  });

  it("leaves an unnumbered name alone", () => {
    expect(stripNumbering("Chop onions")).toBe("Chop onions");
  });

  it("tolerates junk", () => {
    expect(stripNumbering(null)).toBe("");
    expect(hasNumbering(null)).toBe(false);
  });
});

describe("the antibiotic: a block of one, twenty times", () => {
  const elements = [step("Take dose", 360)];

  it("produces twenty rows, not twenty-one", () => {
    // `times` is the TOTAL, so the source block is occurrence one.
    const out = repeatBlock({
      elements,
      startIndex: 0,
      blockLength: 1,
      times: 20,
      offsetMinutes: 360,
      autoNumber: true,
    });
    expect(out).toHaveLength(20);
  });

  it("numbers them 1 of 20 through 20 of 20", () => {
    const out = repeatBlock({
      elements,
      startIndex: 0,
      blockLength: 1,
      times: 20,
      offsetMinutes: 360,
      autoNumber: true,
    });
    expect(out[0].name).toBe("Take dose 1 of 20");
    expect(out[6].name).toBe("Take dose 7 of 20");
    expect(out[19].name).toBe("Take dose 20 of 20");
  });

  it("writes the offset on EVERY element, including the first", () => {
    // The first one's offset is ignored at position one but becomes live if it
    // is ever dragged down — Phase 2's rule.
    const out = repeatBlock({
      elements,
      startIndex: 0,
      blockLength: 1,
      times: 20,
      offsetMinutes: 360,
      autoNumber: true,
    });
    expect(out.every((el) => el.offsetMinutes === 360)).toBe(true);
  });
});

describe("the daily plan: a block of four, three times", () => {
  const block = [step("Pull"), step("Legs"), step("Push"), step("Core")];

  it("produces twelve rows in block order", () => {
    const out = repeatBlock({
      elements: block,
      startIndex: 0,
      blockLength: 4,
      times: 3,
      offsetMinutes: 60,
    });
    expect(out).toHaveLength(12);
    expect(out.map((e) => e.name)).toEqual([
      "Pull", "Legs", "Push", "Core",
      "Pull", "Legs", "Push", "Core",
      "Pull", "Legs", "Push", "Core",
    ]);
  });

  it("numbers by PASS, not 1..12", () => {
    // "Pull 2 of 3" is the useful label. "Pull 5 of 12" is not.
    const out = repeatBlock({
      elements: block,
      startIndex: 0,
      blockLength: 4,
      times: 3,
      offsetMinutes: 60,
      autoNumber: true,
    });
    expect(out.map((e) => e.name)).toEqual([
      "Pull 1 of 3", "Legs 1 of 3", "Push 1 of 3", "Core 1 of 3",
      "Pull 2 of 3", "Legs 2 of 3", "Push 2 of 3", "Core 2 of 3",
      "Pull 3 of 3", "Legs 3 of 3", "Push 3 of 3", "Core 3 of 3",
    ]);
  });

  it("leaves rows outside the block untouched", () => {
    const elements = [header("Warm up"), ...block, step("Carry", 15)];
    const out = repeatBlock({
      elements,
      startIndex: 1,
      blockLength: 4,
      times: 3,
      offsetMinutes: 60,
    });
    expect(out[0]).toEqual(header("Warm up"));
    expect(out[out.length - 1]).toEqual(step("Carry", 15));
    expect(out).toHaveLength(1 + 12 + 1);
  });
});

describe("repeating a block that ALREADY contains numbering", () => {
  // The decision: warn, do not refuse — and when auto-numbering is on,
  // renumber from the base name so it cannot compound.
  const numbered = [step("Take dose 7 of 20", 360)];

  it("is detected so the dialog can warn", () => {
    expect(describeBlock(numbered, 0, 1).numberedNames).toEqual(["Take dose 7 of 20"]);
  });

  it("renumbers from the base name rather than compounding", () => {
    // Not "Take dose 7 of 20 2 of 3".
    const out = repeatBlock({
      elements: numbered,
      startIndex: 0,
      blockLength: 1,
      times: 3,
      autoNumber: true,
    });
    expect(out.map((e) => e.name)).toEqual([
      "Take dose 1 of 3",
      "Take dose 2 of 3",
      "Take dose 3 of 3",
    ]);
  });

  it("duplicates it verbatim when auto-numbering is OFF", () => {
    // Allowed, because refusing would be paternalistic — but this is exactly
    // the unreadable result the warning is about.
    const out = repeatBlock({
      elements: numbered,
      startIndex: 0,
      blockLength: 1,
      times: 3,
      autoNumber: false,
    });
    expect(out.map((e) => e.name)).toEqual([
      "Take dose 7 of 20",
      "Take dose 7 of 20",
      "Take dose 7 of 20",
    ]);
  });
});

describe("what generation must NOT do", () => {
  it("adds no marker key to a generated element", () => {
    // Generated elements are ordinary elements. A marker would be a new storage
    // shape, and the normalisers would strip it on the next save anyway.
    const out = repeatBlock({
      elements: [step("a", 10)],
      startIndex: 0,
      blockLength: 1,
      times: 2,
      offsetMinutes: 10,
      autoNumber: true,
    });
    expect(Object.keys(out[0]).sort()).toEqual(
      ["description", "displayType", "name", "offsetMinutes", "quantity"].sort()
    );
  });

  it("never puts an offset on a header or a bullet", () => {
    // Phase 2's steps-only invariant is load-bearing: a bullet with an offset
    // would own a notification row nothing can ever tick.
    const out = repeatBlock({
      elements: [header("H"), bullet("b"), step("s")],
      startIndex: 0,
      blockLength: 3,
      times: 2,
      offsetMinutes: 30,
    });
    expect(out.filter((e) => e.displayType === "header")[0].offsetMinutes).toBeUndefined();
    expect(out.filter((e) => e.displayType === "bullet")[0].offsetMinutes).toBeUndefined();
    expect(out.filter((e) => e.displayType === "step")[0].offsetMinutes).toBe(30);
  });

  it("never numbers a header or a bullet", () => {
    const out = repeatBlock({
      elements: [header("Round"), step("Pull")],
      startIndex: 0,
      blockLength: 2,
      times: 2,
      autoNumber: true,
    });
    expect(out[0].name).toBe("Round");
    expect(out[1].name).toBe("Pull 1 of 2");
  });

  it("copies rather than aliases, so editing one pass leaves the others alone", () => {
    const out = repeatBlock({
      elements: [step("Legs", 60)],
      startIndex: 0,
      blockLength: 1,
      times: 3,
      offsetMinutes: 60,
    });
    out[1].name = "Legs (heavier)";
    expect(out[0].name).toBe("Legs");
    expect(out[2].name).toBe("Legs");
  });

  it("does not mutate the array it was given", () => {
    const elements = [step("a", 10)];
    repeatBlock({ elements, startIndex: 0, blockLength: 1, times: 5 });
    expect(elements).toHaveLength(1);
  });
});

describe("describeBlock, which makes the chosen range unambiguous", () => {
  const elements = [step("Pull"), step("Legs"), header("Rest"), step("Push")];

  it("names every row in the block", () => {
    expect(describeBlock(elements, 0, 3).rows.map((r) => r.name)).toEqual([
      "Pull",
      "Legs",
      "Rest",
    ]);
  });

  it("counts the steps, which is what gets offsets and numbering", () => {
    expect(describeBlock(elements, 0, 3).stepCount).toBe(2);
  });

  it("flags a block that runs past the end of the list", () => {
    expect(describeBlock(elements, 2, 5).truncated).toBe(true);
    expect(describeBlock(elements, 0, 4).truncated).toBe(false);
  });
});

describe("guards", () => {
  it("clamps a block that overruns the list", () => {
    const out = repeatBlock({
      elements: [step("a"), step("b")],
      startIndex: 1,
      blockLength: 99,
      times: 2,
    });
    expect(out.map((e) => e.name)).toEqual(["a", "b", "b"]);
  });

  it("treats times below one as one", () => {
    const out = repeatBlock({
      elements: [step("a"), step("b")],
      startIndex: 0,
      blockLength: 1,
      times: 0,
    });
    expect(out).toHaveLength(2);
  });

  it("tolerates junk", () => {
    expect(repeatBlock({ elements: null, startIndex: 0, blockLength: 1, times: 3 })).toEqual([]);
    expect(
      repeatBlock({ elements: [], startIndex: 0, blockLength: 1, times: 3 })
    ).toEqual([]);
  });
});
