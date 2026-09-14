import React, { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import TagPicker, { TAG_PICKER_CAP } from "./TagPicker";
import { MAX_TAGS } from "./utils/tags";

const POOL = ["breadcrumbs", "whole foods", "tjs", "stir fry", "middle eastern"];

// The picker owns its own query; the caller owns the chip list. This is the
// caller.
function Harness({
  initial = [],
  pool = POOL,
  onChange,
  autoFocus = false,
  showChips = true,
}) {
  const [value, setValue] = useState(initial);
  return (
    <TagPicker
      value={value}
      pool={pool}
      autoFocus={autoFocus}
      showChips={showChips}
      onChange={(next) => {
        setValue(next);
        if (onChange) onChange(next);
      }}
    />
  );
}

const box = () => screen.getByPlaceholderText("Search or add a tag…");
const focus = () => fireEvent.focus(box());
const type = (text) => fireEvent.change(box(), { target: { value: text } });

/** Suggestion + create rows, in the order they render. */
const rows = () =>
  screen
    .queryAllByRole("button")
    .map((b) => b.textContent.trim())
    .filter((t) => t !== "");

const createRow = () =>
  screen.queryAllByRole("button").find((b) => b.textContent.includes("Create"));

const chips = () =>
  screen
    .queryAllByRole("button", { name: /^Remove tag / })
    .map((b) => b.getAttribute("aria-label").replace("Remove tag ", ""));

describe("TagPicker — the create row", () => {
  test("is visible BENEATH matches, not only when nothing matched", () => {
    // The bug this component exists to fix: "bread" matches "breadcrumbs", and
    // the old picker offered no way to create "bread" because a match existed.
    render(<Harness />);
    focus();
    type("bread");

    expect(rows()).toEqual(["breadcrumbs", 'Create "bread"']);
  });

  test("creating a tag contained inside an existing one works", () => {
    render(<Harness />);
    focus();
    type("bread");
    fireEvent.click(createRow());

    expect(chips()).toEqual(["bread"]);
  });

  test("shows the NORMALISED form, not what was typed", () => {
    render(<Harness />);
    focus();
    type("Whole Grain Bread");
    expect(createRow().textContent).toContain('Create "whole grain bread"');

    type("TJ's Sauce");
    expect(createRow().textContent).toContain('Create "tjs sauce"');

    type("stir-fry sauce");
    expect(createRow().textContent).toContain('Create "stir fry sauce"');
  });

  test("hidden when the typed text normalises to an offered suggestion", () => {
    render(<Harness />);
    focus();
    type("Whole Foods"); // normalises to "whole foods", already in the pool
    expect(rows()).toEqual(["whole foods"]);
    expect(createRow()).toBeUndefined();
  });

  test("hidden when the typed text normalises to a tag already applied", () => {
    render(<Harness initial={["tjs"]} />);
    focus();
    type("TJ's");
    expect(createRow()).toBeUndefined();
  });

  test("hidden when the typed text normalises to nothing", () => {
    render(<Harness />);
    focus();
    type("!!!");
    expect(createRow()).toBeUndefined();

    // The suggestions stay put rather than emptying out. `matchesLoosely`
    // folds a punctuation-only query to empty, and an empty query matches
    // everything — the box reads as unfiltered, which is what it effectively
    // is. No false affordance either way: there is nothing to create, and
    // pressing Enter says why (covered under "committing").
    expect(rows()).toEqual(POOL);
  });

  test("hidden when the typed text is only whitespace", () => {
    render(<Harness />);
    focus();
    type("   ");
    expect(createRow()).toBeUndefined();
  });

  test("still offered when nothing matches at all", () => {
    render(<Harness />);
    focus();
    type("zzz");
    expect(rows()).toEqual(['Create "zzz"']);
  });
});

describe("TagPicker — filtering", () => {
  test("matches loosely: case, punctuation and spacing are all ignored", () => {
    render(<Harness />);
    focus();

    type("TJ's");
    expect(rows()).toContain("tjs");

    type("tj-s");
    expect(rows()).toContain("tjs");

    type("wholefoods");
    expect(rows()).toContain("whole foods");

    type("MIDDLE");
    expect(rows()).toContain("middle eastern");
  });

  test("shows the whole pool on focus, so it can be browsed", () => {
    // Unlike ItemPicker's dropdown, which stays shut until you type.
    render(<Harness />);
    focus();
    expect(rows()).toEqual(POOL);
  });

  test("tags already applied are not offered again", () => {
    render(<Harness initial={["tjs"]} />);
    focus();
    expect(rows()).not.toContain("tjs");
  });

  test("caps the list and says how many were cut", () => {
    const big = Array.from({ length: TAG_PICKER_CAP + 5 }, (_, i) => `tag ${i}`);
    render(<Harness pool={big} />);
    focus();
    expect(rows().length).toBe(TAG_PICKER_CAP);
    expect(
      screen.getByText(/Showing 20 of 25 — keep typing to narrow/),
    ).toBeTruthy();
  });

  test("an empty pool reads differently from a search that found nothing", () => {
    render(<Harness pool={[]} />);
    focus();
    expect(screen.getByText("No other tags yet — type to create one")).toBeTruthy();
  });

  test("says so when the typed text is already a chip on this record", () => {
    // Used to fall through to "No matching tags", which reads as "that tag does
    // not exist" when it is in fact already applied.
    render(<Harness initial={["buggy"]} pool={["buggy"]} />);
    focus();
    type("buggy");

    expect(screen.getByText('"buggy" is already added')).toBeTruthy();
    expect(screen.queryByText("No matching tags")).toBeNull();
    expect(createRow()).toBeUndefined();
  });

  test("the already-added message quotes the NORMALISED form", () => {
    render(<Harness initial={["stir fry"]} pool={["stir fry"]} />);
    focus();

    type("Stir-Fry");
    expect(screen.getByText('"stir fry" is already added')).toBeTruthy();

    type("STIR_FRY");
    expect(screen.getByText('"stir fry" is already added')).toBeTruthy();
  });

  test("the already-added message is not tappable", () => {
    render(<Harness initial={["buggy"]} pool={["buggy"]} />);
    focus();
    type("buggy");

    const message = screen.getByText('"buggy" is already added');
    expect(message.tagName).toBe("P");
    expect(message.closest("button")).toBeNull();
  });

  test("it sits beneath matches rather than replacing them", () => {
    // "buggy" is applied; "buggy code" is not and still matches the query.
    render(<Harness initial={["buggy"]} pool={["buggy", "buggy code"]} />);
    focus();
    type("buggy");

    expect(rows()).toEqual(["buggy code"]);
    expect(screen.getByText('"buggy" is already added')).toBeTruthy();
  });

  test("the ordinary no-matches state is unaffected", () => {
    // Nothing matched and nothing applied — this must keep its own message.
    render(<Harness initial={["buggy"]} pool={["buggy"]} />);
    focus();
    type("zzz");

    expect(screen.queryByText(/is already added/)).toBeNull();
    expect(createRow().textContent).toContain('Create "zzz"');
  });

  test("a tag applied but NOT typed leaves the no-matches state alone", () => {
    render(<Harness initial={["buggy"]} pool={["buggy", "whole foods"]} />);
    focus();
    type("qqq zzz qqq");

    expect(screen.queryByText(/is already added/)).toBeNull();
    expect(createRow()).toBeTruthy();
  });
});

describe("TagPicker — committing", () => {
  test("Enter commits the normalised form", () => {
    render(<Harness />);
    focus();
    type("Whole Grain");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(chips()).toEqual(["whole grain"]);
    expect(box().value).toBe("");
  });

  test("blur does NOT commit, and leaves the typed text in the box", () => {
    // Reversed after Phase 4 verification. Typing "wo" and tapping outside used
    // to invent a tag called "wo". A tag is now only created by an explicit
    // act, and uncommitted text stays visible rather than vanishing.
    render(<Harness />);
    focus();
    type("nervous system");
    fireEvent.blur(box());

    expect(chips()).toEqual([]);
    expect(box().value).toBe("nervous system");
  });

  test("blur after a partial word creates nothing — the reported bug", () => {
    render(<Harness />);
    focus();
    type("wo");
    fireEvent.blur(box());

    expect(chips()).toEqual([]);
  });

  test("clicking a suggestion commits it", () => {
    render(<Harness />);
    focus();
    type("tj");
    fireEvent.click(screen.getByRole("button", { name: "tjs" }));

    expect(chips()).toEqual(["tjs"]);
    expect(box().value).toBe("");
  });

  test("clicking a suggestion does not ALSO commit the typed text", () => {
    // The row prevents the input's blur, so one tap cannot produce two tags.
    render(<Harness />);
    focus();
    type("brea");
    const row = screen.getByRole("button", { name: "breadcrumbs" });

    const ev = fireEvent.mouseDown(row);
    expect(ev).toBe(false); // preventDefault() was called
    fireEvent.click(row);

    expect(chips()).toEqual(["breadcrumbs"]);
  });

  test("blur with an empty box commits nothing", () => {
    render(<Harness />);
    focus();
    fireEvent.blur(box());
    expect(chips()).toEqual([]);
  });

  test("committing the same tag twice is a silent no-op", () => {
    render(<Harness initial={["tjs"]} />);
    focus();
    type("TJ's");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(chips()).toEqual(["tjs"]);
  });

  test("text that normalises to nothing is rejected, and kept for fixing", () => {
    render(<Harness />);
    focus();
    type("!!!");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(chips()).toEqual([]);
    expect(screen.getByText("A tag needs at least one letter or number")).toBeTruthy();
    expect(box().value).toBe("!!!");
  });

  test("over-length text is rejected, and kept for fixing", () => {
    render(<Harness />);
    focus();
    type("a".repeat(51));
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(chips()).toEqual([]);
    expect(screen.getByText("Tags can be at most 50 characters")).toBeTruthy();
    expect(box().value).toBe("a".repeat(51));
  });

  test("stops at the 20-tag cap, says so, and keeps the text", () => {
    const full = Array.from({ length: MAX_TAGS }, (_, i) => `tag ${i}`);
    render(<Harness initial={full} pool={[]} />);
    focus();
    type("one more");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(chips().length).toBe(MAX_TAGS);
    expect(screen.getByText(`Maximum ${MAX_TAGS} tags`)).toBeTruthy();
    expect(box().value).toBe("one more");
  });
});

describe("TagPicker — the list closes after a tag lands", () => {
  // The list used to stay open and cover the chip row, so there was no way to
  // see that the tag had been added.
  const listIsOpen = () =>
    screen.queryAllByRole("button").some((b) => b.className.includes("w-full"));

  test("closes after Create", () => {
    render(<Harness />);
    focus();
    type("bread");
    expect(listIsOpen()).toBe(true);

    fireEvent.click(createRow());

    expect(listIsOpen()).toBe(false);
    expect(chips()).toEqual(["bread"]);
  });

  test("closes after tapping a suggestion", () => {
    render(<Harness />);
    focus();
    fireEvent.click(screen.getByRole("button", { name: "tjs" }));

    expect(listIsOpen()).toBe(false);
    expect(chips()).toEqual(["tjs"]);
  });

  test("closes after Enter", () => {
    render(<Harness />);
    focus();
    type("nervous system");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(listIsOpen()).toBe(false);
    expect(chips()).toEqual(["nervous system"]);
  });

  test("drops focus, so the phone keyboard gets out of the way", () => {
    render(<Harness />);
    // Real focus, not just the synthetic event — the assertion is about where
    // the browser's focus actually sits.
    act(() => box().focus());
    type("nervous system");
    expect(document.activeElement).toBe(box());

    fireEvent.keyDown(box(), { key: "Enter" });

    expect(document.activeElement).not.toBe(box());
  });

  test("stays open when the commit was refused", () => {
    // Nothing landed, so there is nothing to step back and look at.
    render(<Harness />);
    focus();
    type("!!!");
    fireEvent.keyDown(box(), { key: "Enter" });

    expect(listIsOpen()).toBe(true);
  });

  test("reopens when the field is focused again", () => {
    render(<Harness />);
    focus();
    type("bread");
    fireEvent.click(createRow());
    expect(listIsOpen()).toBe(false);

    focus();
    expect(listIsOpen()).toBe(true);
  });
});

describe("TagPicker — chips", () => {
  test("renders the value exactly as stored, never re-normalised", () => {
    // Normalising on load is what would make the dirty-checks report phantom
    // edits. A legacy non-canonical tag must render untouched.
    render(<Harness initial={["Legacy_Tag", "whole foods"]} pool={[]} />);
    expect(chips()).toEqual(["Legacy_Tag", "whole foods"]);
  });

  test("onChange is not called on mount or on focus", () => {
    // The other half of the same guarantee: rendering a record must not
    // announce an edit.
    const onChange = jest.fn();
    render(<Harness initial={["Legacy_Tag"]} onChange={onChange} />);
    focus();
    type("x");
    expect(onChange).not.toHaveBeenCalled();
  });

  test("× removes one chip and leaves the rest", () => {
    render(<Harness initial={["tjs", "whole foods", "stir fry"]} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove tag whole foods" }));

    expect(chips()).toEqual(["tjs", "stir fry"]);
  });

  test("removing a chip does not commit half-typed text", () => {
    render(<Harness initial={["tjs"]} />);
    focus();
    type("brea");
    const x = screen.getByRole("button", { name: "Remove tag tjs" });

    const ev = fireEvent.mouseDown(x);
    expect(ev).toBe(false); // preventDefault() was called
    fireEvent.click(x);

    expect(chips()).toEqual([]);
    expect(box().value).toBe("brea");
  });
});

describe("TagPicker — autoFocus", () => {
  const listIsOpen = () =>
    screen.queryAllByRole("button").some((b) => b.className.includes("w-full"));

  test("puts the cursor in the box when asked", () => {
    // The collection tag editor is opened by a deliberate tap on a Tag button,
    // so it should be ready to type into without a second tap.
    render(<Harness autoFocus />);
    expect(document.activeElement).toBe(box());
  });

  test("focusing opens the suggestion list, as focusing always does", () => {
    render(<Harness autoFocus />);
    expect(listIsOpen()).toBe(true);
  });

  test("does not focus, or open, when not asked", () => {
    // The four item/intention pickers sit inside a form you may be scrolling
    // past; raising the keyboard on render would be wrong there.
    render(<Harness />);
    expect(document.activeElement).not.toBe(box());
    expect(listIsOpen()).toBe(false);
  });

  test("commit behaviour is unchanged by autoFocus", () => {
    render(<Harness autoFocus />);
    type("wo");
    fireEvent.blur(box());

    expect(chips()).toEqual([]);
    expect(box().value).toBe("wo");
  });
});

describe("TagPicker — switching between rows", () => {
  // Models how the collection detail view mounts the editor: one picker at a
  // time, chosen by an "open row" id, exactly as `toggleTagEditor` /
  // `openTagEditor` / `closeTagEditor` in Alfred.jsx drive it. What is being
  // pinned here is the contract that view depends on — that a picker carries
  // nothing between rows.
  function Rows({ onChange }) {
    const [openId, setOpenId] = useState(null);
    const [tags, setTags] = useState({ eggs: [], milk: [] });
    return (
      <div>
        {["eggs", "milk"].map((id) => (
          <div key={id}>
            <button onClick={() => setOpenId(openId === id ? null : id)}>
              tag {id}
            </button>
            {openId === id && (
              <TagPicker
                autoFocus
                value={tags[id]}
                pool={POOL}
                onChange={(next) => {
                  setTags((prev) => ({ ...prev, [id]: next }));
                  if (onChange) onChange(id, next);
                }}
              />
            )}
          </div>
        ))}
      </div>
    );
  }

  const tagButton = (id) => screen.getByRole("button", { name: `tag ${id}` });

  test("opening a second row closes the first", () => {
    render(<Rows />);
    fireEvent.click(tagButton("eggs"));
    expect(screen.queryAllByPlaceholderText("Search or add a tag…")).toHaveLength(1);

    fireEvent.click(tagButton("milk"));
    // Still exactly one editor, not two.
    expect(screen.queryAllByPlaceholderText("Search or add a tag…")).toHaveLength(1);
  });

  test("uncommitted text is discarded, not carried to the next row", () => {
    render(<Rows />);
    fireEvent.click(tagButton("eggs"));
    type("whole f");

    fireEvent.click(tagButton("milk"));

    expect(box().value).toBe("");
  });

  test("uncommitted text is not committed on the way out", () => {
    // The Phase 4 rule holding: a tag is created only by an explicit act, and
    // switching rows is not one.
    const onChange = jest.fn();
    render(<Rows onChange={onChange} />);
    fireEvent.click(tagButton("eggs"));
    type("whole f");

    fireEvent.click(tagButton("milk"));

    expect(onChange).not.toHaveBeenCalled();
    expect(chips()).toEqual([]);
  });

  test("the newly opened row is focused and ready to type", () => {
    render(<Rows />);
    fireEvent.click(tagButton("eggs"));
    fireEvent.click(tagButton("milk"));

    expect(document.activeElement).toBe(box());
  });

  test("a committed tag stays on its own row when you switch away and back", () => {
    render(<Rows />);
    fireEvent.click(tagButton("eggs"));
    type("tjs");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(chips()).toEqual(["tjs"]);

    fireEvent.click(tagButton("milk"));
    expect(chips()).toEqual([]); // milk has none

    fireEvent.click(tagButton("eggs"));
    expect(chips()).toEqual(["tjs"]); // eggs still does
  });

  test("tapping the open row's own button closes it entirely", () => {
    render(<Rows />);
    fireEvent.click(tagButton("eggs"));
    fireEvent.click(tagButton("eggs"));

    expect(screen.queryAllByPlaceholderText("Search or add a tag…")).toHaveLength(0);
  });
});

describe("TagPicker — showChips", () => {
  test("renders no chip list when told not to", () => {
    // The collection member row shows its own removable chips directly above
    // the editor; a second copy inside it was two places to remove the same tag
    // from, and only one of them was reachable without opening the editor.
    render(<Harness initial={["tjs", "whole foods"]} showChips={false} />);
    expect(chips()).toEqual([]);
  });

  test("value still drives everything else", () => {
    // Suppressing the display must not suppress the behaviour: applied tags are
    // still hidden from suggestions, still deduplicated, and still reported as
    // already added.
    render(<Harness initial={["tjs"]} showChips={false} />);
    focus();
    expect(rows()).not.toContain("tjs");

    type("TJ's");
    expect(createRow()).toBeUndefined();
    expect(screen.getByText('"tjs" is already added')).toBeTruthy();
  });

  test("chips are on by default, for the item and intention forms", () => {
    render(<Harness initial={["tjs"]} />);
    expect(chips()).toEqual(["tjs"]);
  });
});

describe("TagPicker — the collection editor", () => {
  // Models the collection member row: removable chips above, an editor below
  // holding only the input and dropdown, and a mousedown listener that closes
  // the whole editor on a tap outside the row. Same structure and same close
  // path as the collection detail view.
  function Row({ onClose }) {
    const [open, setOpen] = useState(false);
    const [tags, setTags] = useState([]);
    const rowRef = React.useRef(null);

    React.useEffect(() => {
      if (!open) return undefined;
      const onDown = (e) => {
        if (rowRef.current && !rowRef.current.contains(e.target)) {
          setOpen(false);
          if (onClose) onClose();
        }
      };
      document.addEventListener("mousedown", onDown);
      return () => document.removeEventListener("mousedown", onDown);
    }, [open, onClose]);

    return (
      <div>
        <div ref={rowRef} data-testid="row">
          <span>Eggs</span>
          {tags.map((tag) => (
            <button
              key={tag}
              aria-label={`Remove tag ${tag}`}
              onClick={() => setTags(tags.filter((t) => t !== tag))}
            >
              x
            </button>
          ))}
          <button aria-label="Tag this item" onClick={() => setOpen(!open)}>
            tag
          </button>
          {open && (
            <TagPicker
              autoFocus
              showChips={false}
              value={tags}
              pool={POOL}
              onChange={setTags}
              placeholder="Search or add"
            />
          )}
        </div>
        <div data-testid="outside">elsewhere on the page</div>
      </div>
    );
  }

  const editorBox = () => screen.queryByPlaceholderText("Search or add");
  const openEditor = () =>
    fireEvent.click(screen.getByRole("button", { name: "Tag this item" }));
  const rowChips = () =>
    screen
      .queryAllByRole("button", { name: /^Remove tag / })
      .map((b) => b.getAttribute("aria-label").replace("Remove tag ", ""));

  test("adding a tag does NOT close the editor", () => {
    // Settled in Phase 4 and load-bearing here: the dropdown closes and focus
    // drops so the new chip is visible, but the input stays so a second tag is
    // one tap away.
    render(<Row />);
    openEditor();
    fireEvent.change(editorBox(), { target: { value: "tjs" } });
    fireEvent.keyDown(editorBox(), { key: "Enter" });

    expect(rowChips()).toEqual(["tjs"]);
    expect(editorBox()).toBeTruthy();
  });

  test("two tags can be added in one editor session", () => {
    render(<Row />);
    openEditor();

    fireEvent.change(editorBox(), { target: { value: "tjs" } });
    fireEvent.keyDown(editorBox(), { key: "Enter" });
    fireEvent.focus(editorBox());
    fireEvent.change(editorBox(), { target: { value: "whole foods" } });
    fireEvent.keyDown(editorBox(), { key: "Enter" });

    expect(rowChips()).toEqual(["tjs", "whole foods"]);
    expect(editorBox()).toBeTruthy();
  });

  test("tapping outside closes the whole editor, input and all", () => {
    render(<Row />);
    openEditor();
    expect(editorBox()).toBeTruthy();

    fireEvent.mouseDown(screen.getByTestId("outside"));

    expect(editorBox()).toBeNull();
  });

  test("uncommitted text is discarded on an outside tap", () => {
    render(<Row />);
    openEditor();
    fireEvent.change(editorBox(), { target: { value: "wo" } });

    fireEvent.mouseDown(screen.getByTestId("outside"));

    expect(rowChips()).toEqual([]);
    expect(editorBox()).toBeNull();

    // And it is not carried back in when the editor is reopened.
    openEditor();
    expect(editorBox().value).toBe("");
  });

  test("tapping inside the row does not close it", () => {
    // The row's own Tag button and its chips live here; closing on those would
    // fight the toggle and make removing a tag mid-edit throw you out.
    render(<Row />);
    openEditor();

    fireEvent.mouseDown(screen.getByText("Eggs"));

    expect(editorBox()).toBeTruthy();
  });

  test("the row's Tag button still closes it", () => {
    render(<Row />);
    openEditor();
    openEditor();
    expect(editorBox()).toBeNull();
  });

  test("a chip can be removed from the row with no editor open", () => {
    // The change the rest depend on: removing a tag used to mean opening the
    // editor to reach a second copy of the chips.
    render(<Row />);
    openEditor();
    fireEvent.change(editorBox(), { target: { value: "tjs" } });
    fireEvent.keyDown(editorBox(), { key: "Enter" });
    fireEvent.mouseDown(screen.getByTestId("outside"));
    expect(editorBox()).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Remove tag tjs" }));

    expect(rowChips()).toEqual([]);
    expect(editorBox()).toBeNull();
  });

  test("removing a chip while the editor is open leaves it open", () => {
    render(<Row />);
    openEditor();
    fireEvent.change(editorBox(), { target: { value: "tjs" } });
    fireEvent.keyDown(editorBox(), { key: "Enter" });

    fireEvent.click(screen.getByRole("button", { name: "Remove tag tjs" }));

    expect(rowChips()).toEqual([]);
    expect(editorBox()).toBeTruthy();
  });
});
