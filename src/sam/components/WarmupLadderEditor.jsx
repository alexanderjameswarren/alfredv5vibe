import React from "react";
import { ChevronDown, ChevronRight, Flame, Trash2 } from "lucide-react";
import InsertRowButton from "../../InsertRowButton";
import { sourceLabel } from "../lib/warmupLadder";
import {
  MAX_RUNGS, canRemoveRung, draftSummary, toDraft, validateMode, withRungAt,
} from "../lib/warmupLadderEdit";

// Editing a warm-up ladder (spec §7.4). One component for all three levels: a
// snippet, a song, and a plan item — which is read-only, because plans are
// immutable and changing one means a new plan.
//
// A FORM, NOT A SET OF ACTIONS (2026-09-27). It writes nothing and knows nothing
// about the database. The host owns the draft, validates it when its own Save is
// pressed, and is the only thing that writes; Cancel is then simply the host
// throwing the draft away. Before this, three buttons here each wrote immediately,
// which left every dialog with two saves and made its own Save and Cancel mean
// nothing at all.
//
// THE THREE STATES OF THE COLUMN ARE A CHOICE, AND THE UI MUST NOT CONFLATE THEM:
//
//   Set here        — these rungs, at this level
//   Inherit         — null: fall through to the next level down, and ultimately to
//                     the app default
//   No warm-up here — []: stop the chain, so an inherited ladder does not apply
//                     and the Warm up button does not appear
//
// One radio group, so choosing is visibly choosing one OF three rather than
// pressing a button whose effect has to be remembered. Only "Set here" shows the
// rung table; the other two say in words what will happen instead, because the
// consequence of Inherit is not knowable from the word — it depends entirely on
// what the next level down holds.
//
// READABILITY (Alex plays without his glasses): body size or larger everywhere,
// full `foreground` contrast on anything that carries meaning, and 44px minimum on
// every input and control.
//
// THE RUNG TABLE IS A GRID, NOT FLEX ROWS (2026-09-27). Flex rows lined their
// fields up only by accident: the locked rung had one element fewer than the rest,
// so its remaining fields slid left and nothing in the column agreed. One grid
// template, shared by the heading row and every rung, lines the five columns up by
// construction — and the locked rung's missing delete button is then simply an
// empty cell. Column widths are fixed for the three number boxes, which is also
// what keeps them three characters wide instead of stretching.
export default function WarmupLadderEditor({
  // "snippet" | "song" | "item"
  level,
  // { mode, rows } — owned by the host. Ignored when readOnly.
  draft,
  onDraftChange,
  // The column as stored: the read-only view, and the seed when switching to
  // "Set here".
  value,
  // { ladder, source } — what the player will run as things stand.
  resolved,
  // True once the host's Save has been pressed on an invalid draft.
  showErrors = false,
  // A refusal from the database, which is the real invariant.
  error = null,
  readOnly = false,
  // A section that folds away, with its state in the collapsed header. Pass
  // `open`/`onOpenChange` to control it — the Edit Song dialog does, so a failed
  // Save can open it to show why.
  collapsible = false,
  open: openProp,
  onOpenChange,
}) {
  const [openSelf, setOpenSelf] = React.useState(!collapsible);
  const open = !collapsible ? true : (openProp === undefined ? openSelf : openProp);
  const setOpen = (next) => (onOpenChange ? onOpenChange(next) : setOpenSelf(next));

  const mode = readOnly ? "own" : draft?.mode ?? "inherit";
  const rows = readOnly ? toDraft(value) : draft?.rows ?? [];
  const { errors } = validateMode({ mode, rows });

  const resolvedLadder = resolved?.ladder;
  const hasResolved = Array.isArray(resolvedLadder) && resolvedLadder.length > 0;
  const resolvedText = hasResolved
    ? `${resolvedLadder.map((r) => `${r.target_percent}%`).join(" → ")} · ${sourceLabel(resolved.source)}`
    : null;

  const set = (patch) => onDraftChange?.({ mode, rows, ...patch });
  const setRow = (i, patch) =>
    set({ rows: rows.map((r, n) => (n === i ? { ...r, ...patch } : r)) });
  // `at` is the index the new rung will occupy, so "the plus above row i" is
  // insertAt(i) and "the plus below row i" is insertAt(i + 1) — the same position.
  const insertAt = (at) => set({ rows: withRungAt(rows, at) });
  const removeRow = (i) => {
    if (canRemoveRung(rows, i).ok) set({ rows: rows.filter((_, n) => n !== i) });
  };

  // Switching to "Set here" with nothing to show would be a dead end, so it brings
  // back whatever is stored, or seeds the smallest real ladder.
  const pickMode = (next) => {
    if (next === mode) return;
    if (next !== "own") {
      set({ mode: next });
      return;
    }
    const stored = toDraft(value);
    set({ mode: "own", rows: rows.length ? rows : (stored.length ? stored : withRungAt([], 0)) });
  };

  const INPUT =
    "w-full px-1 py-2 text-center border border-border rounded text-sm text-foreground min-h-[44px] " +
    "focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent";

  // THE ONE TEMPLATE, used by the heading row and by every rung. EVERY TRACK IS A
  // FIXED WIDTH, and that is the point: the five controls then sit as a tight group
  // on the left and the leftover width falls after the last track, to the right of
  // the delete button.
  //
  // It used to end `..._1fr_2.75rem`, which made the Consecutive column absorb all
  // the spare width and pinned the bin to the far right of the dialog, a hand's
  // width from the fields it belongs to. A `1fr` anywhere before the last control is
  // that bug.
  //
  // The Consecutive track is 4.5rem because its widest content is the word in the
  // heading row, not the checkbox — and a fixed width is what keeps the heading row
  // and every rung row, which are separate grids, agreeing on where each column
  // starts. Gaps tighten on a phone so the whole group still fits without scrolling.
  const GRID =
    "grid grid-cols-[3.25rem_3.25rem_3.25rem_4.5rem_2.75rem] gap-x-1 sm:gap-x-2";

  const summary =
    mode === "own" ? `${draftSummary(rows)} · set here`
      : mode === "none" ? "none here"
        : "inherited";

  return (
    <div className="text-sm text-foreground" aria-label="Warm-up ladder editor">
      {collapsible ? (
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="flex w-full items-center gap-2 mb-2 text-left min-h-[44px]"
        >
          {open
            ? <ChevronDown className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            : <ChevronRight className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden="true" />}
          <Flame className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">Warm-up ladder</span>
          {/* The state rides in the header, so a folded section still answers the
              question. A fold that hides the answer is worse than no fold. */}
          <span className="text-muted-foreground" data-testid="ladder-collapsed-summary">{summary}</span>
        </button>
      ) : (
        <div className="flex items-center gap-2 mb-2">
          <Flame className="w-4 h-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span className="font-medium">Warm-up ladder</span>
        </div>
      )}

      {!open ? null : (
        <>
          {level === "item" && (
            <p className="mb-3 text-muted-foreground" data-testid="ladder-readonly-note">
              A plan item&apos;s ladder is read-only: plans are never edited, so changing this one means
              a new plan. Ask Claude for one.
            </p>
          )}

          {!readOnly && (
            <div role="radiogroup" aria-label="Where this range&apos;s warm-up comes from" className="mb-3">
              {[
                ["own", "Set here"],
                ["inherit", "Inherit"],
                ["none", "No warm-up here"],
              ].map(([id, label]) => (
                <label key={id} className="flex items-center gap-2 min-h-[44px] cursor-pointer">
                  <input
                    type="radio"
                    className="w-5 h-5"
                    name="warmup-mode"
                    value={id}
                    checked={mode === id}
                    onChange={() => pickMode(id)}
                  />
                  <span>{label}</span>
                </label>
              ))}
            </div>
          )}

          {/* What the choice means, in the only terms that matter: what pressing
              Warm up will do. Omitted when the host resolved nothing — outside the
              player nothing is loaded, so claiming an answer would be worse than
              giving none. */}
          {resolved && mode !== "own" && (
            <p className="mb-3" data-testid="ladder-consequence">
              {mode === "none"
                ? "There will be no warm-up for this range."
                : resolvedText
                  ? `Pressing Warm up will run ${resolvedText}.`
                  : "Nothing is inherited, so there will be no warm-up for this range."}
            </p>
          )}
          {resolved && mode === "own" && (
            <p className="mb-3 text-muted-foreground" data-testid="ladder-resolved">
              {hasResolved
                ? `As things stand, pressing Warm up runs ${resolvedText}.`
                : "Pressing Warm up does nothing here — no ladder applies."}
            </p>
          )}

          {mode === "own" && rows.length > 0 && (
            <div className="mb-2">
              <div className={`${GRID} text-muted-foreground`}>
                <span className="text-xs whitespace-nowrap">Tempo %</span>
                <span className="text-xs whitespace-nowrap">Acc. %</span>
                <span className="text-xs whitespace-nowrap">Passes</span>
                <span className="text-xs whitespace-nowrap">Consecutive</span>
                <span aria-hidden="true" />
              </div>

              {rows.map((row, i) => {
                const isTarget = i === rows.length - 1;
                const removable = canRemoveRung(rows, i);
                const rungErrors = showErrors ? (errors.rungs[i] || []) : [];
                const full = rows.length >= MAX_RUNGS;
                const where = isTarget
                  ? "Insert a rung above the target rung"
                  : `Insert a rung above rung ${i + 1}`;
                return (
                  <React.Fragment key={i}>
                    {/* A plus above every rung. "Above rung i" and "below rung
                        i - 1" are the same position, so this one set of controls
                        covers both — and there is deliberately none after the last
                        row, because nothing can follow the target rung. */}
                    {/* Left-aligned, over the Tempo % column, so it reads as part
                        of the table rather than floating in the middle of it; and
                        `leading-none` on top of the control's own negative margin so
                        a six-rung ladder stays a compact table instead of six
                        separated blocks. */}
                    <InsertRowButton
                      onClick={() => insertAt(i)}
                      disabled={readOnly || full}
                      align="start"
                      title={full ? `A ladder can have at most ${MAX_RUNGS} rungs` : where}
                      label={full ? `${where} — a ladder can have at most ${MAX_RUNGS} rungs` : where}
                      className="leading-none"
                    />

                    <div className={`${GRID} items-center`} data-testid="ladder-rung">
                      {/* THE TARGET RUNG'S PERCENT IS NOT A CHOICE. It is what
                          finishing the ladder means, so it is shown and not
                          offered: greyed and unfocusable, with the reason on hover
                          and in its accessible name. No padlock — the icon sat in
                          the Accuracy column and pushed the whole row out of line
                          with the rows above it. */}
                      <input
                        type="number"
                        className={`${INPUT} ${isTarget ? "bg-secondary text-muted-foreground" : ""}`}
                        value={row.percent}
                        onChange={(e) => setRow(i, { percent: e.target.value })}
                        readOnly={isTarget}
                        tabIndex={isTarget ? -1 : undefined}
                        title={isTarget ? "The last rung is the target tempo — always 100%" : undefined}
                        aria-label={isTarget
                          ? "Target rung tempo percent, always 100 and not editable"
                          : `Rung ${i + 1} percent of target tempo`}
                        min={10}
                        max={100}
                      />
                      <input
                        type="number"
                        className={INPUT}
                        value={row.accuracy}
                        onChange={(e) => setRow(i, { accuracy: e.target.value })}
                        aria-label={`Rung ${i + 1} accuracy target, blank to inherit`}
                        placeholder="—"
                        min={1}
                        max={100}
                      />
                      <input
                        type="number"
                        className={INPUT}
                        value={row.passes}
                        onChange={(e) => setRow(i, { passes: e.target.value })}
                        aria-label={`Rung ${i + 1} passes needed`}
                        min={1}
                      />
                      <label className="flex items-center min-h-[44px]">
                        <input
                          type="checkbox"
                          className="w-5 h-5"
                          checked={!!row.consecutive}
                          onChange={(e) => setRow(i, { consecutive: e.target.checked })}
                          aria-label={`Rung ${i + 1} passes must be consecutive`}
                        />
                      </label>
                      {/* The target rung has NO delete control at all — not a
                          disabled one — because it is not a thing that could ever
                          be deleted. Its cell is left empty so the four fields
                          above still line up. A rung that cannot go right now (two
                          rungs left) keeps its button, disabled, and carries the
                          reason in its tooltip alone. */}
                      {!readOnly && !isTarget ? (
                        <button
                          type="button"
                          onClick={() => removeRow(i)}
                          disabled={!removable.ok}
                          className="p-2 min-h-[44px] min-w-[44px] flex items-center justify-center text-muted-foreground hover:text-destructive disabled:opacity-40 disabled:hover:text-muted-foreground"
                          aria-label={removable.ok ? `Remove rung ${i + 1}` : `Remove rung ${i + 1} — ${removable.reason}`}
                          title={removable.ok ? `Remove rung ${i + 1}` : removable.reason}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      ) : (
                        <span aria-hidden="true" />
                      )}
                    </div>

                    {/* Directly beneath its own rung, so it reads as that rung's
                        problem rather than as a list at the bottom of the form. */}
                    {rungErrors.length > 0 && (
                      <p className="text-destructive mb-1" role="alert">{rungErrors.join(" ")}</p>
                    )}
                  </React.Fragment>
                );
              })}

              <p className="text-muted-foreground mt-2">
                {draftSummary(rows)} · a blank accuracy uses the plan item&apos;s target, or 85% off plan.
              </p>
            </div>
          )}

          {showErrors && errors.ladder.length > 0 && (
            <p className="mb-2 text-destructive" role="alert">{errors.ladder.join(" ")}</p>
          )}
          {error && <p className="mb-2 text-destructive" role="alert">{error}</p>}

        </>
      )}
    </div>
  );
}
