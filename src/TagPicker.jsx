import React, { useEffect, useRef, useState } from "react";
import { X, Plus } from "lucide-react";
import SearchInput from "./SearchInput";
import { matchesLoosely } from "./utils/search";
import { normaliseTag, MAX_TAGS, MAX_TAG_LENGTH } from "./utils/tags";

// The shared tag control: type to search tags already in use, pick one, or
// create a new one. Replaces the old comma-separated `TagInput`.
//
// Built on ItemPicker's structure — the same blur grace period, the same
// result cap with an overflow note, the same dropdown styling — but it is a
// sibling rather than a wrapper. ItemPicker is item-shaped all the way through
// (it takes `items`, resolves `contexts`, hides archived rows, hands back a
// record via `onPick`), and a tag is a string with none of that around it.
//
// ─── The create row is ALWAYS at the bottom ──────────────────────────────────
//
// This is the whole reason the component exists. `CollectionAddItems` shows its
// create button only when the search returns NOTHING, so it replaces the empty
// list rather than sitting under matches. Type "bread" where "breadcrumbs"
// already exists and there is no way to create "bread" at all — the matching
// suggestion crowds it out. That has already cost real time.
//
// So the create row renders beneath whatever matched. It is hidden in exactly
// three cases: what was typed normalises to nothing; it normalises to a tag
// already offered above it (picking the suggestion is the same act); or it
// normalises to a tag already on the record (the button would do nothing).
//
// ─── A tag is only ever created by an explicit act ───────────────────────────
//
// Tapping the Create row, tapping a suggestion, or pressing Enter. Nothing
// else. Blurring the field does NOT commit — the typed text stays in the box,
// uncommitted and visible.
//
// This reverses the old TagInput's commit-on-blur, which spec §9.2 originally
// called load-bearing. That reasoning was sound while typing was the ONLY way
// to add a tag: losing half-typed text on blur was worse than the occasional
// accidental tag. The always-visible Create row removes that premise. Now the
// failure mode runs the other way — typing "wo" and tapping anywhere else
// silently invented a tag called "wo".
//
// The accepted cost, decided deliberately: type a complete tag, tap Save
// without committing, and the tag is not saved. The text stays on screen while
// the form is open, and creating a tag is now always something you did on
// purpose.
//
// ─── Adding a tag closes the list ────────────────────────────────────────────
//
// After any successful add the dropdown closes and the field gives up focus,
// so the chip row underneath is visible and the phone keyboard gets out of the
// way. The list used to stay open and cover the chips, so there was no way to
// see that the tag had landed. Cost: adding several tags in a row takes one
// extra tap each.
//
// ─── Normalise on COMMIT, never on load ──────────────────────────────────────
//
// `value` is rendered as chips exactly as stored, untouched. Normalisation
// happens only when a tag is committed. Folding on load would make the four
// `JSON.stringify` dirty-checks in Alfred.jsx report edits nobody made — see
// technical-spec-tags.md §4.
//
// ─── One tag per commit ──────────────────────────────────────────────────────
//
// The old input split on commas, because spaces were illegal and a comma was
// the only way to type two tags. Now that spaces are legal, a comma is just
// punctuation inside a tag name, so "a, b" commits as one tag "a b" rather than
// two. The chip list is what makes this multi-value.

/** Most suggestions to show at once, before the overflow note. */
export const TAG_PICKER_CAP = 20;

// Delay before a blur hides the list. Only reached when focus genuinely leaves
// the control — every surface inside it cancels its own blur (see BLUR below).
const BLUR_HIDE_MS = 200;

// How long an error stays on screen. Matches the old TagInput.
const ERROR_MS = 3000;

const BOX =
  "absolute z-10 w-full mt-1 bg-card border border-border rounded-lg shadow-lg max-h-60 overflow-y-auto";
const ROW =
  "w-full text-left px-3 py-2 min-h-[44px] hover:bg-background border-b border-border last:border-b-0";
const NOTE = "px-3 py-2 text-sm text-muted-foreground";

// Tapping a suggestion, the create row, or a chip's × must not move focus out
// of the input. Preventing the default on mousedown stops the focus change
// entirely; the click still fires.
//
// It originally guarded against a double commit, back when blur committed:
// tapping a suggestion would have added the half-typed text AND the
// suggestion. Blur no longer commits, but these are still load-bearing for two
// reasons. On a phone, letting focus go on mousedown dismisses the keyboard and
// reflows the page mid-tap, which lands the tap somewhere else. And removing a
// chip would otherwise close the dropdown as a side effect of the ×.
//
// It is also why `dismiss()` has to blur explicitly — after a tap, focus is
// still in the input by design.
const BLUR = (e) => e.preventDefault();

export default function TagPicker({
  value = [],
  pool = [],
  onChange,
  placeholder = "Search or add a tag…",
  label = "Search or add a tag",
  autoFocus = false,
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const rootRef = useRef(null);
  const blurTimer = useRef(null);
  const errorTimer = useRef(null);

  useEffect(
    () => () => {
      clearTimeout(blurTimer.current);
      clearTimeout(errorTimer.current);
    },
    [],
  );

  // Put the cursor in the box when the control is mounted on purpose — a tag
  // editor opened by tapping a Tag button should be ready to type into, not
  // need a second tap.
  //
  // Belt and braces: the `autoFocus` attribute is passed to the input as well,
  // but iOS does not reliably honour it (the same reason ItemPicker's inline
  // variant does not depend on it). Focusing here runs inside the commit that
  // the tap triggered, which is what lets the keyboard come up. Calling focus()
  // on an already-focused input is a no-op, so doing both is harmless.
  //
  // Focusing fires onFocus, which opens the suggestion list. That is intended.
  useEffect(() => {
    if (!autoFocus) return;
    rootRef.current?.querySelector("input")?.focus();
  }, [autoFocus]);

  function flash(message) {
    clearTimeout(errorTimer.current);
    setError(message);
    errorTimer.current = setTimeout(() => setError(""), ERROR_MS);
  }

  function show() {
    clearTimeout(blurTimer.current);
    setOpen(true);
  }

  // Blur hides the list and NOTHING ELSE. It used to commit; see the header.
  // Whatever is typed stays in the box, so nothing is lost from sight — it just
  // is not a tag until you say so.
  function hideSoon() {
    clearTimeout(blurTimer.current);
    blurTimer.current = setTimeout(() => setOpen(false), BLUR_HIDE_MS);
  }

  // Close up after a tag lands, so the chip row below is visible and the phone
  // keyboard gets out of the way.
  //
  // The blur is explicit because the mousedown handlers deliberately keep focus
  // in the input, so it is still focused after a tap. Reached through the DOM
  // rather than a ref: `SearchInput` does not forward one, and teaching it to
  // would touch a component `ItemPicker` and `ListToolbar` also render.
  function dismiss() {
    clearTimeout(blurTimer.current);
    setOpen(false);
    rootRef.current?.querySelector("input")?.blur();
  }

  const applied = new Set(value);
  const available = (pool || []).filter(
    (tag) => typeof tag === "string" && !applied.has(tag),
  );
  const matches = available.filter((tag) => matchesLoosely(query, tag));
  const shown = matches.slice(0, TAG_PICKER_CAP);

  // What the typed text would actually be stored as. null when nothing survives
  // the rule — punctuation only, or over the length cap.
  const candidate = normaliseTag(query);

  // What was typed is already a chip on this record. Mutually exclusive with
  // `showCreate` by construction, and it takes over the bottom slot to say so
  // — otherwise the list fell through to "No matching tags", which reads as
  // "that tag does not exist" when in fact it is already applied.
  const alreadyApplied = candidate !== null && applied.has(candidate);

  const showCreate =
    candidate !== null && !applied.has(candidate) && !shown.includes(candidate);

  /**
   * Append an already-normalised tag.
   *
   * The box is cleared and the list dismissed only when the tag ends up
   * applied. A refused commit leaves the text exactly where it is so it can be
   * fixed — losing it would be the same complaint as commit-on-blur, one step
   * later.
   */
  function commitTag(tag) {
    if (!tag) return;

    // Already on the record: the user's intent is satisfied, so this reads as
    // success rather than an error.
    if (applied.has(tag)) {
      setQuery("");
      dismiss();
      return;
    }
    if (value.length >= MAX_TAGS) {
      flash(`Maximum ${MAX_TAGS} tags`);
      return;
    }

    onChange([...value, tag]);
    setQuery("");
    dismiss();
  }

  /** Commit whatever is in the box. Enter only — blur does not come here. */
  function commitTyped() {
    if (!query.trim()) return;
    if (candidate === null) {
      flash(
        query.trim().length > MAX_TAG_LENGTH
          ? `Tags can be at most ${MAX_TAG_LENGTH} characters`
          : "A tag needs at least one letter or number",
      );
      return;
    }
    commitTag(candidate);
  }

  function handleKeyDown(e) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitTyped();
    }
  }

  return (
    <div ref={rootRef}>
      <div className="relative">
        <SearchInput
          value={query}
          onChange={(next) => {
            setQuery(next);
            show();
          }}
          onFocus={show}
          onBlur={hideSoon}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          label={label}
          autoFocus={autoFocus}
          className="w-full"
        />

        {/* Opens on focus rather than on first keystroke, unlike ItemPicker's
            dropdown. A tag pool is a dozen or so strings and browsing it is the
            point — seeing "middle eastern" already exists is what stops a
            second spelling of it being invented. */}
        {open && (
          <div className={BOX}>
            {shown.map((tag) => (
              <button
                key={tag}
                type="button"
                onMouseDown={BLUR}
                onClick={() => commitTag(tag)}
                className={ROW}
              >
                <span className="font-medium text-foreground break-words">
                  {tag}
                </span>
              </button>
            ))}

            {matches.length > shown.length && (
              <p className={`${NOTE} text-xs`}>
                Showing {shown.length} of {matches.length} — keep typing to
                narrow
              </p>
            )}

            {/* Nothing matched and nothing to create: say which. An empty pool
                is a different state from a search that found nothing, and both
                are different from "you already have that one" — which speaks
                for itself below and must not be overruled here. */}
            {shown.length === 0 && !showCreate && !alreadyApplied && (
              <p className={NOTE}>
                {available.length === 0
                  ? "No other tags yet — type to create one"
                  : "No matching tags"}
              </p>
            )}

            {/* The create row. Beneath the matches, not instead of them. Shows
                the NORMALISED text, so what is on the button is exactly what
                gets stored — "Whole Foods" offers Create "whole foods". */}
            {showCreate && (
              <button
                type="button"
                onMouseDown={BLUR}
                onClick={() => commitTag(candidate)}
                className={`${ROW} flex items-center gap-2 text-primary`}
              >
                <Plus className="w-4 h-4 shrink-0" />
                <span className="break-words">
                  Create &quot;{candidate}&quot;
                </span>
              </button>
            )}

            {/* Same slot the create row would have taken, because it is the
                answer to the same question — "can I add this?". Quotes the
                NORMALISED form, so typing "Buggy" or "bug-gy" names the chip
                you actually have. Deliberately not a button: there is nothing
                to do, and something tappable here would suggest otherwise. */}
            {alreadyApplied && (
              <p className={NOTE}>&quot;{candidate}&quot; is already added</p>
            )}
          </div>
        )}
      </div>

      {error && <p className="text-xs text-destructive mt-1">{error}</p>}

      {/* Chips render `value` exactly as stored — never re-normalised. */}
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-2">
          {value.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 px-2 py-0.5 bg-warning-light text-accent-foreground text-xs rounded-full"
            >
              {tag}
              <button
                type="button"
                onMouseDown={BLUR}
                onClick={() => onChange(value.filter((t) => t !== tag))}
                aria-label={`Remove tag ${tag}`}
                title={`Remove tag ${tag}`}
                className="p-1 hover:text-primary"
              >
                <X size={12} />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
