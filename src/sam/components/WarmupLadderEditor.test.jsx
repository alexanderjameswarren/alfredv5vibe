// The ladder editor (warm-up spec §7.4), which is a FORM: it writes nothing, and
// the three states of the column are a choice inside it rather than three action
// buttons that each wrote immediately. The host owns the draft; these tests hold it
// the same way, so "nothing happens until Save" is visible here too.

import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom";
import WarmupLadderEditor from "./WarmupLadderEditor";
import { draftFromValue, valueFromDraft } from "../lib/warmupLadderEdit";

const rung = (percent, over = {}) => ({
  target_percent: percent, accuracy_target: null, target_passes: 2, consecutive: true, ...over,
});
const OWN = [rung(70), rung(100)];
const RESOLVED_OWN = { ladder: OWN, source: "snippet" };
const RESOLVED_DEFAULT = { ladder: [rung(85), rung(100)], source: "default" };

const rungs = () => screen.queryAllByTestId("ladder-rung");
const targetPercent = () =>
  screen.getByLabelText("Target rung tempo percent, always 100 and not editable");
const mode = (name) => screen.getByRole("radio", { name });
// The plus controls, in document order: one above every rung, none after the last.
const pluses = () => screen.queryAllByRole("button", { name: /^Insert a rung/ });

// A host that holds the draft, exactly as the two real dialogs do, and exposes what
// would be written if Save were pressed right now.
function Host({ value = null, resolved = RESOLVED_OWN, showErrors = false, ...rest }) {
  const [draft, setDraft] = React.useState(() => draftFromValue(value));
  return (
    <>
      <WarmupLadderEditor
        level="snippet"
        value={value}
        resolved={resolved}
        draft={draft}
        onDraftChange={setDraft}
        showErrors={showErrors}
        {...rest}
      />
      <output data-testid="would-write">{JSON.stringify(valueFromDraft(draft))}</output>
    </>
  );
}

const wouldWrite = () => JSON.parse(screen.getByTestId("would-write").textContent);

describe("the three states are one choice", () => {
  test("its own ladder opens on Set here, with the rungs loaded", () => {
    render(<Host value={OWN} />);
    expect(mode("Set here")).toBeChecked();
    expect(rungs()).toHaveLength(2);
    expect(screen.getByLabelText("Rung 1 percent of target tempo")).toHaveValue(70);
  });

  test("null opens on Inherit, and says what will run instead of rungs", () => {
    render(<Host value={null} resolved={RESOLVED_DEFAULT} />);
    expect(mode("Inherit")).toBeChecked();
    expect(rungs()).toHaveLength(0);
    expect(screen.getByTestId("ladder-consequence"))
      .toHaveTextContent("Pressing Warm up will run 85% → 100% · default.");
  });

  test("[] opens on No warm-up here, and says there will be none", () => {
    render(<Host value={[]} resolved={{ ladder: [], source: "snippet" }} />);
    expect(mode("No warm-up here")).toBeChecked();
    expect(screen.getByTestId("ladder-consequence"))
      .toHaveTextContent("There will be no warm-up for this range.");
  });

  test("Inherit with nothing to inherit says so rather than promising a ladder", () => {
    render(<Host value={OWN} resolved={{ ladder: null, source: null }} />);
    fireEvent.click(mode("Inherit"));
    expect(screen.getByTestId("ladder-consequence"))
      .toHaveTextContent("Nothing is inherited, so there will be no warm-up for this range.");
  });

  test("the rung table shows only on Set here", () => {
    render(<Host value={OWN} />);
    expect(rungs()).toHaveLength(2);
    fireEvent.click(mode("No warm-up here"));
    expect(rungs()).toHaveLength(0);
    fireEvent.click(mode("Set here"));
    expect(rungs()).toHaveLength(2);
  });

  test("each state maps to the value it will write", () => {
    render(<Host value={OWN} />);
    expect(wouldWrite()).toEqual(OWN);
    fireEvent.click(mode("Inherit"));
    expect(wouldWrite()).toBeNull();
    fireEvent.click(mode("No warm-up here"));
    expect(wouldWrite()).toEqual([]);
    fireEvent.click(mode("Set here"));
    expect(wouldWrite()).toEqual(OWN);
  });

  test("Set here on a level that has nothing stored seeds the smallest real ladder", () => {
    render(<Host value={null} resolved={RESOLVED_DEFAULT} />);
    fireEvent.click(mode("Set here"));
    expect(rungs()).toHaveLength(2);
    expect(targetPercent()).toHaveValue(100);
    expect(wouldWrite().map((r) => r.target_percent)).toEqual([70, 100]);
  });

  test("the heading row and every rung share one all-fixed template", () => {
    const { container } = render(<Host value={[rung(50), rung(70), rung(100)]} />);
    // eslint-disable-next-line testing-library/no-node-access
    const grids = container.querySelectorAll(".grid");
    // One heading row plus three rungs, all on the same explicit template — which is
    // what makes the locked rung's empty delete cell line up with the bins above it.
    expect(grids).toHaveLength(4);
    for (const g of grids) {
      expect(g.className).toMatch(/grid-cols-\[3\.25rem_3\.25rem_3\.25rem_4\.5rem_2\.75rem\]/);
      // NO flexible track before the delete button. A `1fr` there is what pinned the
      // bin to the far right of the dialog, away from the fields it belongs to.
      expect(g.className).not.toMatch(/1fr/);
    }
  });

  test("the leftover width falls after the delete button, so the controls group left", () => {
    render(<Host value={OWN} />);
    // Every track is fixed, so the tracks total less than the row and the slack sits
    // after the last one. Nothing stretches, and nothing is pushed to the right edge.
    const tracks = rungs()[0].className.match(/grid-cols-\[([^\]]+)\]/)[1].split("_");
    expect(tracks).toHaveLength(5);
    for (const t of tracks) expect(t).toMatch(/rem$/);
  });

  test("the headings are Tempo %, Acc. %, Passes, Consecutive, and none wraps", () => {
    const { container } = render(<Host value={OWN} />);
    for (const text of ["Tempo %", "Acc. %", "Passes", "Consecutive"]) {
      expect(screen.getByText(text).className).toMatch(/whitespace-nowrap/);
    }
    // And "in a row" is gone from the screen entirely.
    // eslint-disable-next-line testing-library/no-node-access
    expect(container.textContent).not.toMatch(/in a row/i);
  });
});

describe("it writes nothing itself", () => {
  test("there is no Save, Clear or No-warm-up BUTTON in the editor", () => {
    render(<Host value={OWN} />);
    expect(screen.queryByRole("button", { name: /Save/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Clear/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^No warm-up here$/ })).not.toBeInTheDocument();
    // The bottom "Add rung" button is gone too: adding is done at a position now.
    expect(screen.queryByRole("button", { name: /Add rung/ })).not.toBeInTheDocument();
    expect(pluses().length).toBeGreaterThan(0);
  });

  test("editing a rung changes only the draft", () => {
    render(<Host value={OWN} />);
    fireEvent.change(screen.getByLabelText("Rung 1 percent of target tempo"), { target: { value: "50" } });
    expect(wouldWrite()[0].target_percent).toBe(50);
    // The stored value is untouched — the host still holds OWN.
    expect(screen.getByLabelText("Rung 1 percent of target tempo")).toHaveValue(50);
  });
});

const THREE = [rung(50), rung(70), rung(100)];

describe("editing rungs", () => {

  test("the target rung's percent is read-only and unfocusable, and says why", () => {
    const { container } = render(<Host value={OWN} />);
    expect(targetPercent()).toHaveValue(100);
    expect(targetPercent()).toHaveAttribute("readonly");
    expect(targetPercent()).toHaveAttribute("tabindex", "-1");
    expect(targetPercent()).toHaveAttribute("title", "The last rung is the target tempo — always 100%");
    // No padlock: it sat in the Accuracy column and pushed the row out of line.
    // eslint-disable-next-line testing-library/no-node-access
    expect(container.querySelector("svg.lucide-lock")).not.toBeInTheDocument();
  });

  test("its passes and consecutive are still editable", () => {
    render(<Host value={OWN} />);
    fireEvent.change(screen.getByLabelText("Rung 2 passes needed"), { target: { value: "4" } });
    fireEvent.click(screen.getByLabelText("Rung 2 passes must be consecutive"));
    expect(wouldWrite()[1]).toEqual({
      target_percent: 100, accuracy_target: null, target_passes: 4, consecutive: false,
    });
  });

  test("it has NO delete button at all", () => {
    render(<Host value={THREE} />);
    expect(screen.getByRole("button", { name: "Remove rung 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove rung 2" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Remove rung 3" })).not.toBeInTheDocument();
  });

  test("there is a plus above every rung and none after the last", () => {
    render(<Host value={THREE} />);
    expect(rungs()).toHaveLength(3);
    // Three pluses for three rungs: above each one, and nothing below the target.
    expect(pluses()).toHaveLength(3);
    expect(pluses()[2]).toHaveAttribute("title", "Insert a rung above the target rung");
  });

  test("the plus above the first rung inserts at the top", () => {
    render(<Host value={OWN} />);
    fireEvent.click(pluses()[0]);
    expect(rungs()).toHaveLength(3);
    fireEvent.change(screen.getByLabelText("Rung 1 percent of target tempo"), { target: { value: "40" } });
    expect(wouldWrite().map((r) => r.target_percent)).toEqual([40, 70, 100]);
  });

  test("a plus between two rungs inserts between them", () => {
    render(<Host value={THREE} />);
    // The second plus sits between rung 1 and rung 2.
    fireEvent.click(pluses()[1]);
    expect(rungs()).toHaveLength(4);
    fireEvent.change(screen.getByLabelText("Rung 2 percent of target tempo"), { target: { value: "60" } });
    expect(wouldWrite().map((r) => r.target_percent)).toEqual([50, 60, 70, 100]);
  });

  test("the last plus inserts directly above the 100 row, which stays at the bottom", () => {
    render(<Host value={OWN} />);
    fireEvent.click(pluses()[pluses().length - 1]);
    expect(targetPercent()).toHaveValue(100);
    fireEvent.change(screen.getByLabelText("Rung 2 percent of target tempo"), { target: { value: "85" } });
    expect(wouldWrite().map((r) => r.target_percent)).toEqual([70, 85, 100]);
  });

  test("deleting a middle rung leaves the ramp and the target", () => {
    render(<Host value={THREE} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove rung 2" }));
    expect(wouldWrite().map((r) => r.target_percent)).toEqual([50, 100]);
  });

  test("at two rungs the delete is refused, with the reason in the tooltip ONLY", () => {
    render(<Host value={OWN} />);
    const remove = screen.getByRole("button", { name: /^Remove rung 1/ });
    expect(remove).toBeDisabled();
    expect(remove).toHaveAttribute("title", "A ladder needs at least 2 rungs");
    // The text beside the button is gone: the tooltip and the accessible name carry it.
    expect(screen.queryByText("A ladder needs at least 2 rungs")).not.toBeInTheDocument();
    expect(remove).toHaveAccessibleName("Remove rung 1 — A ladder needs at least 2 rungs");
    fireEvent.click(remove);
    expect(rungs()).toHaveLength(2);
  });

  test("six rungs is the ceiling: every plus is refused, with the reason", () => {
    render(<Host value={[50, 60, 70, 80, 90, 100].map((p) => rung(p))} />);
    expect(pluses()).toHaveLength(6);
    for (const plus of pluses()) {
      expect(plus).toBeDisabled();
      expect(plus).toHaveAttribute("title", "A ladder can have at most 6 rungs");
    }
  });
});

describe("errors are the host's cue, shown on its Save", () => {
  test("nothing is red until the host says so", () => {
    render(<Host value={[rung(100)]} />);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  test("with showErrors, every problem is on screen at once", () => {
    render(<Host value={[rung(200, { target_passes: 0 }), rung(90)]} showErrors />);
    const alerts = screen.getAllByRole("alert").map((a) => a.textContent).join(" ");
    expect(alerts).toMatch(/between 10 and 100/);
    expect(alerts).toMatch(/1 or more/);
    expect(alerts).toMatch(/last rung must be 100%/);
  });

  test("a rung's error sits directly beneath that rung, not in a list at the end", () => {
    // Only the SECOND rung is wrong, so the error must follow the second row.
    render(<Host value={[rung(50), rung(40), rung(100)]} showErrors />);
    const rungErrors = screen.getAllByRole("alert").filter((a) => /higher than the rung above/.test(a.textContent));
    expect(rungErrors).toHaveLength(1);
    // eslint-disable-next-line testing-library/no-node-access
    expect(rungErrors[0].previousElementSibling).toBe(rungs()[1]);
  });

  test("a whole-ladder problem stays where general errors go", () => {
    render(<Host value={[rung(70), rung(90)]} showErrors />);
    const general = screen.getAllByRole("alert").find((a) => /last rung must be 100%/.test(a.textContent));
    // Not attached to a rung: its previous sibling is not a rung row.
    // eslint-disable-next-line testing-library/no-node-access
    expect(rungs()).not.toContain(general.previousElementSibling);
  });

  test("a refusal from the database is shown too — it is the real invariant", () => {
    render(<Host value={OWN} error='violates check constraint "sam_snippets_warmup_ladder_valid"' />);
    expect(screen.getByRole("alert")).toHaveTextContent("sam_snippets_warmup_ladder_valid");
  });

  test("Inherit and No warm-up here are always valid, whatever the rungs were", () => {
    render(<Host value={[rung(200)]} showErrors />);
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
    fireEvent.click(mode("Inherit"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});

describe("a plan item is read-only", () => {
  const ro = () => render(
    <WarmupLadderEditor level="item" value={OWN} resolved={{ ladder: OWN, source: "plan" }} readOnly />
  );

  test("no choice, no delete, no add, and it says why", () => {
    ro();
    expect(screen.getByTestId("ladder-readonly-note")).toHaveTextContent(/plans are never edited/);
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Add rung/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Remove rung/ })).not.toBeInTheDocument();
  });

  test("the rungs are shown", () => {
    ro();
    expect(rungs()).toHaveLength(2);
    expect(screen.getByLabelText("Rung 1 percent of target tempo")).toHaveValue(70);
  });
});

describe("as a collapsed section", () => {
  test("closed when asked, with the state in the header", () => {
    render(<Host value={OWN} collapsible open={false} onOpenChange={() => {}} />);
    expect(screen.getByTestId("ladder-collapsed-summary")).toHaveTextContent("70% → 100% · set here");
    expect(rungs()).toHaveLength(0);
  });

  test("the header follows the DRAFT, so an unsaved choice is visible while folded", () => {
    function Collapsing() {
      const [draft, setDraft] = React.useState(() => draftFromValue(OWN));
      const [open, setOpen] = React.useState(true);
      return (
        <WarmupLadderEditor
          level="song" value={OWN} resolved={RESOLVED_OWN}
          draft={draft} onDraftChange={setDraft}
          collapsible open={open} onOpenChange={setOpen}
        />
      );
    }
    render(<Collapsing />);
    fireEvent.click(mode("No warm-up here"));
    fireEvent.click(screen.getByRole("button", { expanded: true }));
    expect(screen.getByTestId("ladder-collapsed-summary")).toHaveTextContent("none here");
  });

  test("not collapsible by default: no header button, everything on show", () => {
    render(<Host value={OWN} />);
    expect(screen.queryByRole("button", { expanded: false })).not.toBeInTheDocument();
    expect(rungs()).toHaveLength(2);
  });
});

describe("readable and tappable without glasses", () => {
  test("every field and the delete button are at least 44px tall", () => {
    const { container } = render(<Host value={OWN} />);
    // The inline plus is excluded on purpose: it is the app's shared insert control
    // at its established size (see InsertRowButton), and at 44px it would roughly
    // double the height of a six-rung form inside an already tall dialog.
    // eslint-disable-next-line testing-library/no-node-access
    const controls = container.querySelectorAll('input[type="number"], button[aria-label^="Remove rung"]');
    expect(controls.length).toBeGreaterThan(0);
    for (const c of controls) {
      expect(c.className).toMatch(/min-h-\[44px\]|min-w-\[44px\]/);
    }
  });

  test("a rung never scrolls sideways: the grid's columns are what hold it together", () => {
    render(<Host value={OWN} />);
    for (const row of rungs()) {
      expect(row.className).toMatch(/\bgrid\b/);
      expect(row.className).not.toMatch(/overflow-x/);
    }
  });

  test("the three number boxes stay about three characters wide", () => {
    render(<Host value={OWN} />);
    // The width is the grid column's, not the input's, so the template is the thing
    // to assert; the inputs fill their cell.
    expect(rungs()[0].className).toMatch(/grid-cols-\[3\.25rem_3\.25rem_3\.25rem_/);
    for (const label of [
      "Rung 1 percent of target tempo",
      "Rung 1 accuracy target, blank to inherit",
      "Rung 1 passes needed",
    ]) {
      expect(screen.getByLabelText(label).className).toMatch(/\bw-full\b/);
    }
  });
});


// --- The plus controls sit in the table, not beside it (2026-09-27) ------------

describe("the plus controls", () => {
  test("they are left-aligned, over the first column rather than centred", () => {
    const { container } = render(<Host value={OWN} />);
    // eslint-disable-next-line testing-library/no-node-access
    const wrappers = [...container.querySelectorAll("div")].filter((d) =>
      d.className.includes("-my-1"));
    expect(wrappers).toHaveLength(2);
    for (const w of wrappers) {
      expect(w.className).toMatch(/justify-start/);
      expect(w.className).not.toMatch(/justify-center/);
    }
  });

  test("they are tight: the control's own negative margin plus a flat line height", () => {
    const { container } = render(<Host value={OWN} />);
    // eslint-disable-next-line testing-library/no-node-access
    const wrapper = [...container.querySelectorAll("div")].find((d) =>
      d.className.includes("-my-1"));
    expect(wrapper.className).toMatch(/leading-none/);
    // The padding that used to add a row's worth of height is gone.
    expect(wrapper.className).not.toMatch(/\bpy-1\b/);
  });
});

test("the locked 100 row has the same five cells as every other row, the last one empty", () => {
  render(<Host value={THREE} />);
  const rows = rungs();
  // Five grid children in every row, heading row included, so column N starts at the
  // same x in all of them. The locked row's fifth cell is an empty span where the
  // others have a bin — which is the whole reason it is a grid and not a flex row.
  for (const row of rows) {
    // eslint-disable-next-line testing-library/no-node-access
    expect(row.children).toHaveLength(5);
  }
  const locked = rows[rows.length - 1];
  // eslint-disable-next-line testing-library/no-node-access
  expect(locked.children[4].tagName).toBe("SPAN");
  // eslint-disable-next-line testing-library/no-node-access
  expect(locked.children[4]).toBeEmptyDOMElement();
  // eslint-disable-next-line testing-library/no-node-access
  expect(rows[0].children[4].tagName).toBe("BUTTON");
});
