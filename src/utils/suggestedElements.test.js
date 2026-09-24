import {
  normaliseSuggestedElement,
  normaliseSuggestedElements,
} from "./suggestedElements";

// This module exists because four hand-written copies of it had to stay
// byte-identical. These tests pin the two properties that mattered and that a
// fifth copy would eventually have broken: the OUTPUT SHAPE, and the fact that
// normalising twice changes nothing.

describe("normaliseSuggestedElement", () => {
  it("translates the enrichment's vocabulary into the app's", () => {
    expect(normaliseSuggestedElement({ text: "Chop the onion", type: "step" })).toEqual({
      name: "Chop the onion",
      displayType: "step",
      quantity: "",
      description: "",
    });
  });

  it("defaults a missing type to step", () => {
    expect(normaliseSuggestedElement({ text: "Something" }).displayType).toBe("step");
  });

  it("defaults missing text to an empty name rather than undefined", () => {
    // An element with no name still has to render in the editor; undefined would
    // make the input uncontrolled and React would warn on the first keystroke.
    expect(normaliseSuggestedElement({ type: "bullet" }).name).toBe("");
  });

  it("carries quantity and description through", () => {
    expect(
      normaliseSuggestedElement({
        text: "Onions",
        type: "bullet",
        quantity: "2",
        description: "yellow, not red",
      }),
    ).toEqual({
      name: "Onions",
      displayType: "bullet",
      quantity: "2",
      description: "yellow, not red",
    });
  });

  it("keeps `collectable` only when it is set", () => {
    expect(normaliseSuggestedElement({ text: "Onions", type: "bullet", collectable: true })).toHaveProperty(
      "collectable",
      true,
    );
    // Absent rather than false: the flag is a presence, and an explicit false
    // says nothing more than saying nothing.
    expect(normaliseSuggestedElement({ text: "Onions", type: "bullet" })).not.toHaveProperty("collectable");
    expect(
      normaliseSuggestedElement({ text: "Onions", type: "bullet", collectable: false }),
    ).not.toHaveProperty("collectable");
  });

  it("keeps an offset of 0, which truthiness would have dropped", () => {
    // 0 means "immediately after the previous step" and is a real answer.
    expect(normaliseSuggestedElement({ text: "Stir", type: "step", offsetMinutes: 0 })).toHaveProperty(
      "offsetMinutes",
      0,
    );
  });

  it("reads the snake_case spelling elements come back from the database in", () => {
    expect(
      normaliseSuggestedElement({ text: "Rest the dough", type: "step", offset_minutes: 30 }),
    ).toHaveProperty("offsetMinutes", 30);
  });

  it("returns an already-app-shaped element untouched, by identity", () => {
    // Identity, not equality: `name` is the signal that nothing is needed, and
    // returning a copy would make the dirty check see a change where the object
    // merely passed through.
    const already = { name: "Chop the onion", displayType: "step" };
    expect(normaliseSuggestedElement(already)).toBe(already);
  });

  it("is idempotent", () => {
    const once = normaliseSuggestedElement({ text: "Chop", type: "step", offsetMinutes: 5 });
    expect(normaliseSuggestedElement(once)).toEqual(once);
  });

  it("puts offsetMinutes last, so two normalised copies stringify identically", () => {
    // The old dirty check compared JSON.stringify of both sides, so key ORDER
    // was load-bearing: a form nobody had touched reported itself dirty when two
    // copies of the normaliser disagreed about it.
    const a = normaliseSuggestedElement({ text: "Stir", type: "step", offsetMinutes: 5 });
    const b = normaliseSuggestedElement({ text: "Stir", type: "step", offset_minutes: 5 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(Object.keys(a)).toEqual(["name", "displayType", "quantity", "description", "offsetMinutes"]);
  });

  it("survives a null element", () => {
    expect(normaliseSuggestedElement(null)).toEqual({
      name: "",
      displayType: "step",
      quantity: "",
      description: "",
    });
  });
});

describe("normaliseSuggestedElements", () => {
  it("normalises a whole list in order", () => {
    const out = normaliseSuggestedElements([
      { text: "Shopping", type: "header" },
      { text: "Onions", type: "bullet", collectable: true },
    ]);
    expect(out.map((el) => el.name)).toEqual(["Shopping", "Onions"]);
    expect(out[0].displayType).toBe("header");
  });

  it("treats a capture with no suggestions as an empty list", () => {
    // The common case by far: most captures are never enriched.
    expect(normaliseSuggestedElements(undefined)).toEqual([]);
    expect(normaliseSuggestedElements(null)).toEqual([]);
    expect(normaliseSuggestedElements("not an array")).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = [{ text: "Onions", type: "bullet" }];
    const snapshot = JSON.stringify(input);
    normaliseSuggestedElements(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
