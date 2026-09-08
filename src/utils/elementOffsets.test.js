import fs from "fs";
import path from "path";
import {
  readOffsetMinutes,
  offsetPatch,
  isFirstStep,
} from "./elementOffsets";

describe("readOffsetMinutes", () => {
  it("reads the camelCase form held in React state", () => {
    expect(readOffsetMinutes({ offsetMinutes: 360 })).toBe(360);
  });

  it("reads the snake_case form held on disk", () => {
    // storage.toSnakeCase recurses into the jsonb elements array, so this is
    // the shape a row actually has in Postgres.
    expect(readOffsetMinutes({ offset_minutes: 360 })).toBe(360);
  });

  it("keeps zero, which is a real offset and not an absent one", () => {
    expect(readOffsetMinutes({ offsetMinutes: 0 })).toBe(0);
  });

  it("returns undefined for an element with no offset", () => {
    expect(readOffsetMinutes({ name: "step" })).toBeUndefined();
  });

  it("rejects values that are not finite numbers", () => {
    expect(readOffsetMinutes({ offsetMinutes: null })).toBeUndefined();
    expect(readOffsetMinutes({ offsetMinutes: "360" })).toBeUndefined();
    expect(readOffsetMinutes({ offsetMinutes: NaN })).toBeUndefined();
  });

  it("tolerates junk without throwing", () => {
    expect(readOffsetMinutes(null)).toBeUndefined();
    expect(readOffsetMinutes(undefined)).toBeUndefined();
    expect(readOffsetMinutes("a string")).toBeUndefined();
  });
});

describe("offsetPatch", () => {
  it("carries an offset through", () => {
    expect(offsetPatch({ offsetMinutes: 360 })).toEqual({ offsetMinutes: 360 });
  });

  it("carries a zero offset through", () => {
    // The bug this test exists for: the `collectable` idiom is a truthiness
    // test, and copying it here would drop 0.
    expect(offsetPatch({ offsetMinutes: 0 })).toEqual({ offsetMinutes: 0 });
  });

  it("normalises the disk spelling to the state spelling", () => {
    expect(offsetPatch({ offset_minutes: 90 })).toEqual({ offsetMinutes: 90 });
  });

  it("contributes nothing when there is no offset", () => {
    expect(offsetPatch({ name: "step" })).toEqual({});
    expect({ ...{ name: "s" }, ...offsetPatch({ name: "s" }) }).toEqual({ name: "s" });
  });
});

describe("offsetPatch survives an open-and-save cycle", () => {
  // The twin-site failure in miniature: normalise, stringify, normalise again,
  // and confirm the two agree. Key ORDER matters — the dirty check compares
  // JSON.stringify of both sides — so this asserts the exact string, not just
  // deep equality.
  const normalise = (el) => ({
    name: el.name || "",
    displayType: el.displayType || el.display_type || "step",
    quantity: el.quantity || "",
    description: el.description || "",
    ...(el.collectable ? { collectable: true } : {}),
    ...offsetPatch(el),
  });

  it("round-trips an offset unchanged", () => {
    const stored = { name: "Take dose 2 of 20", display_type: "step", offset_minutes: 360 };
    const once = normalise(stored);
    const twice = normalise(once);
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
    expect(twice.offsetMinutes).toBe(360);
  });

  it("round-trips a zero offset unchanged", () => {
    const stored = { name: "Immediately after", display_type: "step", offset_minutes: 0 };
    expect(normalise(normalise(stored)).offsetMinutes).toBe(0);
  });

  it("puts the offset last, so key order is stable across the cycle", () => {
    const el = { name: "s", display_type: "step", offset_minutes: 5 };
    expect(Object.keys(normalise(el)).pop()).toBe("offsetMinutes");
  });
});

describe("isFirstStep", () => {
  const step = (name) => ({ name, displayType: "step" });
  const header = (name) => ({ name, displayType: "header" });
  const bullet = (name) => ({ name, displayType: "bullet" });

  it("is true for the first step in a plain list", () => {
    const els = [step("a"), step("b"), step("c")];
    expect(isFirstStep(els, 0)).toBe(true);
    expect(isFirstStep(els, 1)).toBe(false);
    expect(isFirstStep(els, 2)).toBe(false);
  });

  it("skips headers and bullets above it", () => {
    // A step below a header is still step one — headers are never scheduled.
    const els = [header("Ingredients"), bullet("flour"), step("mix"), step("bake")];
    expect(isFirstStep(els, 2)).toBe(true);
    expect(isFirstStep(els, 3)).toBe(false);
  });

  it("is false for a row that is not a step", () => {
    const els = [header("h"), bullet("b"), step("s")];
    expect(isFirstStep(els, 0)).toBe(false);
    expect(isFirstStep(els, 1)).toBe(false);
  });

  it("treats a missing displayType as a step, matching the editor default", () => {
    const els = [{ name: "untyped" }, step("b")];
    expect(isFirstStep(els, 0)).toBe(true);
    expect(isFirstStep(els, 1)).toBe(false);
  });

  it("reads the disk spelling of the type too", () => {
    const els = [{ name: "h", display_type: "header" }, { name: "s", display_type: "step" }];
    expect(isFirstStep(els, 1)).toBe(true);
  });

  it("moves with the row when steps are reordered", () => {
    // Dragging a step to the top is what changes its meaning to "at start".
    const els = [step("a"), step("b")];
    expect(isFirstStep(els, 1)).toBe(false);
    const reordered = [els[1], els[0]];
    expect(isFirstStep(reordered, 0)).toBe(true);
  });

  it("tolerates junk without throwing", () => {
    expect(isFirstStep([], 0)).toBe(false);
    expect(isFirstStep(null, 0)).toBe(false);
    expect(isFirstStep([step("a")], 9)).toBe(false);
  });
});

describe("an offset authored at position one survives being dragged down", () => {
  // The case that the first "at start" treatment broke: hiding the input at
  // position one made the value unauthorable, so a step created at the top
  // arrived in the middle with a blank. The input now renders everywhere and
  // "at start" is only a note, so the authored value is what shows.

  // Mirrors handleDragOver in both editors: it splices the whole element
  // object, so anything on it travels untouched.
  const dragTo = (elements, from, to) => {
    const next = [...elements];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    return next;
  };

  it("shows the value it was authored with, not a blank", () => {
    const authored = [
      { name: "Take dose 1", displayType: "step", offsetMinutes: 360 },
      { name: "Take dose 2", displayType: "step", offsetMinutes: 360 },
      { name: "Take dose 3", displayType: "step", offsetMinutes: 360 },
    ];
    // Authored at the top, where the offset is real but unused.
    expect(isFirstStep(authored, 0)).toBe(true);
    expect(authored[0].offsetMinutes).toBe(360);

    const dragged = dragTo(authored, 0, 1);

    expect(dragged[1].name).toBe("Take dose 1");
    expect(dragged[1].offsetMinutes).toBe(360); // not undefined
    expect(isFirstStep(dragged, 1)).toBe(false); // now a real gap
    expect(isFirstStep(dragged, 0)).toBe(true); // and dose 2 became first
  });

  it("keeps the value when a step is dragged back to the top", () => {
    // Position never clears the value, so the round trip is lossless.
    const els = [
      { name: "a", displayType: "step", offsetMinutes: 15 },
      { name: "b", displayType: "step", offsetMinutes: 90 },
    ];
    const there = dragTo(els, 1, 0);
    expect(there[0].offsetMinutes).toBe(90);
    const back = dragTo(there, 0, 1);
    expect(back[1].offsetMinutes).toBe(90);
  });

  it("normalises the dragged element unchanged on the next save", () => {
    // The offset must also survive the open-and-save cycle in its new place.
    const dragged = dragTo(
      [
        { name: "first", displayType: "step", offsetMinutes: 45 },
        { name: "second", displayType: "step", offsetMinutes: 5 },
      ],
      0,
      1
    );
    const normalise = (el) => ({
      name: el.name || "",
      displayType: el.displayType || el.display_type || "step",
      quantity: el.quantity || "",
      description: el.description || "",
      ...offsetPatch(el),
    });
    expect(normalise(dragged[1]).offsetMinutes).toBe(45);
  });
});

describe("the enrich prompt and the triage normaliser agree", () => {
  // The AI emits {type, text, offsetMinutes} and the inbox triage normaliser
  // reads it with offsetPatch. If the prompt were changed to emit the disk
  // spelling, or a different key, offsets would be dropped between capture and
  // item with nothing failing anywhere — the same silent seam that has bitten
  // this project before.
  const enrich = fs.readFileSync(
    path.join(__dirname, "..", "..", "supabase", "functions", "ai-enrich", "index.ts"),
    "utf8"
  );

  it("tells the model to emit camelCase offsetMinutes", () => {
    expect(enrich).toContain("offsetMinutes");
  });

  it("forbids the snake_case form the model might otherwise copy from the DB", () => {
    expect(enrich).toMatch(/Never emit the snake_case\s+form/);
  });

  it("reads exactly the key the prompt emits", () => {
    // The contract, asserted rather than assumed.
    expect(offsetPatch({ offsetMinutes: 30 })).toEqual({ offsetMinutes: 30 });
  });

  it("restricts offsets to step elements, like the editor does", () => {
    // A bullet with an offset would own a notification row nothing can tick.
    expect(enrich).toMatch(/Only "step" elements may carry\s+offsetMinutes/);
  });

  it("tells the model to default to omitting it", () => {
    // The harder half: most captured steps are ordinary checklist items, and an
    // unwanted notification costs more than a missing one.
    expect(enrich).toMatch(/DEFAULT TO OMITTING IT/);
  });

  it("carries the mixed-item worked example", () => {
    expect(enrich).toMatch(/WORKED EXAMPLE/);
    expect(enrich).toMatch(/Marinate the beef/);
  });
});

describe("the notification row survives a 390px viewport", () => {
  // Reported from a Pixel 7 in portrait: the row laid out as one non-wrapping
  // line, the sentence was crushed into a four-word column, and the note and
  // the repeat link were pushed past the right edge where they could not be
  // reached. The page scrolled sideways.
  const source = fs.readFileSync(path.join(__dirname, "..", "Alfred.jsx"), "utf8");

  const countOf = (needle) => source.split(needle).length - 1;

  it("lets the row holding the type, quantity and gap WRAP", () => {
    // The container was `flex items-center gap-2` with no wrap, so its children
    // had nowhere to go but off-screen.
    expect(countOf('className="flex flex-wrap items-center gap-2"')).toBe(2);
  });

  it("gives the gap sentence its own full-width line", () => {
    // w-full in a wrapping flex container cannot share a line with anything,
    // so the sentence never competes for width with the select and quantity.
    expect(countOf('className="w-full text-sm text-muted-foreground"')).toBe(2);
  });

  it("keeps the input INLINE with the words, not stacked above them", () => {
    // The 6b wording decision: "notify [5] min after the step above is
    // checked" has to read as one sentence.
    expect(countOf("inline-block w-16 align-middle")).toBe(2);
  });

  it("has no nowrap left in the gap sentence or its note", () => {
    // Two nowrap spans were what actually pushed content off the edge.
    const labels = source.split('className="w-full text-sm text-muted-foreground"').slice(1);
    expect(labels).toHaveLength(2);
    for (const rest of labels) {
      const label = rest.slice(0, rest.indexOf("</label>"));
      expect(label).not.toContain("whitespace-nowrap");
    }
  });

  it("puts the at-start note on its own line", () => {
    expect(countOf('className="block mt-0.5 text-xs text-muted-foreground italic"')).toBe(2);
  });
});

describe("the twin-site rule", () => {
  // `collectable` was silently stripped on open-and-save cycles because one of
  // its normalisers was updated and its shadow copy in a dirty-check effect was
  // not. `offsetMinutes` has the same six sites and the same failure mode.
  //
  // This reads the source rather than behaviour, which is unusual, but it is
  // the only thing that actually catches a SEVENTH normaliser being added later
  // with `collectable` carried through and the offset forgotten. That is the
  // failure, and no behavioural test of the current code can see it coming.
  const source = fs.readFileSync(
    path.join(__dirname, "..", "Alfred.jsx"),
    "utf8"
  );

  const collectableSites = (source.match(/collectable: true \} : \{\}\)/g) || []).length;
  const offsetSites = (source.match(/\.\.\.offsetPatch\(el\)/g) || []).length;

  it("has the six known element normalisers", () => {
    expect(collectableSites).toBe(6);
  });

  it("carries an offset patch at every site that carries collectable", () => {
    expect(offsetSites).toBe(collectableSites);
  });

  it("labels the offset with what it is measured FROM, at both call sites", () => {
    // The old label was "after [N] min", which never said what the delay is
    // measured from — the non-obvious part of the whole feature.
    // The trailing period pins the RENDERED text. Without it this also counted
    // the phrase where it is quoted in a comment, and reported 4 sites.
    const notify = (source.match(/min after the step above is checked\./g) || []).length;
    const atStart = (source.match(/at starting step, no notification will be sent/g) || []).length;
    expect(notify).toBe(2);
    expect(atStart).toBe(2);
  });

  it("puts the repeat picker on the item editor only", () => {
    // Deliberately NOT on the inbox triage card: that is a capture-and-file
    // surface, and generating twenty rows mid-triage is not what it is for.
    // The picker adds no new element key, so no normaliser changes and the
    // twin-site rule is satisfied by there being nothing to duplicate.
    const repeatControls = (source.match(/setRepeatFromIndex\(index\)/g) || []).length;
    expect(repeatControls).toBe(1);
  });

  it("adds no new element key, so the normalisers need no change", () => {
    // Generated elements are ordinary elements. If the picker invented a
    // marker key, all six normalisers would strip it on the next save.
    expect(source).not.toMatch(/generated:\s*true/);
    expect(source).not.toMatch(/isGenerated/);
  });

  it("drops the offset wherever it drops collectable on a type change", () => {
    // Both updateElement copies must delete it, or a step demoted to a header
    // keeps an invisible scheduling instruction.
    const collectableDeletes = (source.match(/delete next\.collectable/g) || []).length;
    const offsetDeletes = (source.match(/delete next\.offsetMinutes/g) || []).length;
    expect(collectableDeletes).toBe(1); // only the item editor renders that checkbox
    expect(offsetDeletes).toBe(2); // both editors render the minutes input
  });
});
