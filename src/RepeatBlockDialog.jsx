import React, { useState } from "react";
import {
  OFFSET_UNITS,
  coerceCount,
  isPartialCount,
  toMinutes,
  splitMinutes,
  describeBlock,
  repeatBlock,
} from "./utils/blockRepeat";

const DEFAULT_BLOCK_LENGTH = 1;
const DEFAULT_TIMES = 3;

/**
 * A number field that can actually be typed into.
 *
 * ⚠️ The bug this replaces: coercing on every keystroke with
 * `parseInt(value, 10) || 1`. Deleting the "1" put a "1" straight back, so the
 * field could never be cleared and going from 1 to 20 was impossible.
 *
 * Three things make it behave:
 *   - the RAW string stays in state while typing, so "" is a legal state;
 *   - focus selects the whole value, so typing over it replaces rather than
 *     appends — no more "120" when you meant 20;
 *   - blur is the only place a value is committed, filling in the default if
 *     the field was left empty and clamping anything out of range.
 */
function CountInput({ value, onChange, onCommit, min, max, className, ...rest }) {
  return (
    <input
      type="text"
      inputMode="numeric"
      pattern="[0-9]*"
      value={value}
      onFocus={(e) => e.target.select()}
      onChange={(e) => {
        // Reject anything that is not digits, but ALLOW the empty string.
        if (isPartialCount(e.target.value)) onChange(e.target.value);
      }}
      onBlur={() => onCommit(String(coerceCount(value, { fallback: min, min, max })))}
      className={className}
      {...rest}
    />
  );
}

/**
 * Repeat a block of steps — the authoring picker. Phase 7.
 *
 * A PARALLEL component, not a reuse of RecurrenceQuickSelect or
 * CustomRecurrenceDialog. Their vocabulary is calendar-anchored: the smallest
 * unit anywhere in the recurrence stack is a day, `calculateNextEventDate`
 * normalises to local midnight, and "ends" is date-based with no count. Bending
 * them to also mean "every 6 hours, 20 times" would mean adding a sub-day
 * dimension and a count-based end to a component two live Intentions call sites
 * depend on.
 *
 * The modal chrome IS copied from CustomRecurrenceDialog, so it looks native.
 *
 * ── How a block is chosen, and why not a range selection ───────────────────
 *
 * Dragging to select a range is a desktop idiom with no good phone equivalent —
 * shift-click has no touch analogue, and long-press-then-drag over a scrolling
 * list is miserable on a small screen.
 *
 * So the block is anchored on the row that opened this dialog and expressed as
 * a LENGTH: "this row, plus N more". Two numbers instead of a two-dimensional
 * gesture, identical on both platforms. The preview below names every row that
 * will be included, which is what a drag-selection would have shown visually.
 */
export default function RepeatBlockDialog({ elements, startIndex, onDone, onCancel }) {
  const maxLength = Math.max(1, elements.length - startIndex);
  // Raw strings, not numbers: "" has to be a legal state while typing.
  const [blockLength, setBlockLength] = useState(String(DEFAULT_BLOCK_LENGTH));
  const [times, setTimes] = useState(String(DEFAULT_TIMES));
  const [autoNumber, setAutoNumber] = useState(false);

  // Prefilled from the anchor row's existing gap, so the common case of
  // "repeat this, same spacing" needs no typing.
  const seed = splitMinutes(elements[startIndex] && elements[startIndex].offsetMinutes);
  const [offsetValue, setOffsetValue] = useState(
    seed.value === "" ? "" : String(seed.value)
  );
  const [offsetUnit, setOffsetUnit] = useState(seed.unitId);

  // Interpreted for the preview and for generation; the fields keep their raw
  // text so a half-typed value never snaps back under the cursor.
  const blockLengthNum = coerceCount(blockLength, {
    fallback: DEFAULT_BLOCK_LENGTH,
    min: 1,
    max: maxLength,
  });
  const timesNum = coerceCount(times, { fallback: DEFAULT_TIMES, min: 1, max: 99 });

  const block = describeBlock(elements, startIndex, blockLengthNum);
  const offsetMinutes = toMinutes(offsetValue, offsetUnit);
  const totalRows = block.rows.length * timesNum;

  function handleDone() {
    onDone(
      repeatBlock({
        elements,
        startIndex,
        blockLength: blockLengthNum,
        times: timesNum,
        offsetMinutes: offsetValue === "" ? undefined : offsetMinutes,
        autoNumber,
      })
    );
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50"
      onClick={onCancel}
    >
      <div
        className="bg-background border border-border rounded-lg shadow-xl p-5 w-full max-w-sm mx-4 max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-lg font-semibold mb-4">Repeat these steps</h3>

        {/* Block: this row, plus N more */}
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm">Repeat</span>
          <CountInput
            value={blockLength}
            onChange={setBlockLength}
            onCommit={setBlockLength}
            min={1}
            max={maxLength}
            className="w-16 px-2 py-2 border border-border rounded text-center text-base"
          />
          <span className="text-sm">{blockLengthNum === 1 ? "step" : "steps"}</span>
        </div>

        {/* Times: the TOTAL, not the number of extra copies */}
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm">for a total of</span>
          <CountInput
            value={times}
            onChange={setTimes}
            onCommit={setTimes}
            min={1}
            max={99}
            className="w-16 px-2 py-2 border border-border rounded text-center text-base"
          />
          <span className="text-sm">{timesNum === 1 ? "pass" : "passes"}</span>
        </div>

        {/* Gap, with a unit so nobody computes that an hour is 60 */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-sm">notify every</span>
          {/* Not a CountInput: an empty gap MEANS "keep each step's existing
              gap", so blur must not fill in a default here. */}
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={offsetValue}
            onFocus={(e) => e.target.select()}
            onChange={(e) => {
              if (isPartialCount(e.target.value)) setOffsetValue(e.target.value);
            }}
            placeholder="—"
            className="w-16 px-2 py-2 border border-border rounded text-center text-base"
          />
          <select
            value={offsetUnit}
            onChange={(e) => setOffsetUnit(e.target.value)}
            className="px-2 py-2 border border-border rounded text-sm"
          >
            {OFFSET_UNITS.map((u) => (
              <option key={u.id} value={u.id}>
                {u.label}
              </option>
            ))}
          </select>
        </div>
        {offsetValue !== "" && offsetMinutes > 0 && (
          <p className="text-xs text-muted-foreground mb-3">
            Stored as {offsetMinutes} minutes, on every generated step.
          </p>
        )}
        {offsetValue === "" && (
          <p className="text-xs text-muted-foreground mb-3">
            Leave blank to keep each step's existing gap.
          </p>
        )}

        {/* Auto-numbering, off by default */}
        <label className="flex items-start gap-2 mb-4 cursor-pointer min-h-[44px]">
          <input
            type="checkbox"
            checked={autoNumber}
            onChange={(e) => setAutoNumber(e.target.checked)}
            className="mt-1 rounded accent-primary"
          />
          <span className="text-sm">
            Number them
            <span className="block text-xs text-muted-foreground">
              "Take dose" becomes "Take dose 1 of {timesNum}". Without this, every
              copy has the same name.
            </span>
          </span>
        </label>

        {/* The preview. This is what a drag-selection would have shown. */}
        <div className="mb-4 p-3 bg-card border border-border rounded">
          <p className="text-xs text-muted-foreground mb-1">
            Repeating {block.rows.length} row{block.rows.length === 1 ? "" : "s"} ×{" "}
            {timesNum} = <strong className="text-foreground">{totalRows} rows</strong>
            {block.stepCount > 0 && ` (${block.stepCount * timesNum} with notifications)`}
          </p>
          <ul className="text-xs space-y-0.5">
            {block.rows.map((row, i) => (
              <li key={i} className="text-foreground truncate">
                • {row.name}
                {row.type !== "step" && (
                  <span className="text-muted-foreground"> ({row.type})</span>
                )}
              </li>
            ))}
          </ul>
          {block.truncated && (
            <p className="text-xs text-destructive mt-1">
              The block runs past the end of the list and has been trimmed.
            </p>
          )}
        </div>

        {/* Repeating an already-numbered block: warn, do not refuse. */}
        {block.numberedNames.length > 0 && (
          <p className="text-xs text-destructive mb-4">
            {autoNumber
              ? `These rows are already numbered (e.g. "${block.numberedNames[0]}"). They will be renumbered 1 of ${timesNum}.`
              : `These rows are already numbered (e.g. "${block.numberedNames[0]}"). Every copy will repeat that same number — tick "Number them" to renumber instead.`}
          </p>
        )}

        <p className="text-xs text-muted-foreground mb-4">
          This writes ordinary steps into the item. Nothing is saved until you
          save the item.
        </p>

        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 min-h-[44px] text-sm border border-border rounded hover:bg-muted transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleDone}
            className="px-4 py-2 min-h-[44px] text-sm bg-primary text-primary-foreground rounded hover:opacity-90 transition-colors"
          >
            Generate {totalRows} rows
          </button>
        </div>
      </div>
    </div>
  );
}
