import React, { useState } from "react";
import {
  OFFSET_UNITS,
  toMinutes,
  splitMinutes,
  describeBlock,
  repeatBlock,
} from "./utils/blockRepeat";

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
  const [blockLength, setBlockLength] = useState(1);
  const [times, setTimes] = useState(3);
  const [autoNumber, setAutoNumber] = useState(false);

  // Prefilled from the anchor row's existing gap, so the common case of
  // "repeat this, same spacing" needs no typing.
  const seed = splitMinutes(elements[startIndex] && elements[startIndex].offsetMinutes);
  const [offsetValue, setOffsetValue] = useState(seed.value === "" ? "" : seed.value);
  const [offsetUnit, setOffsetUnit] = useState(seed.unitId);

  const block = describeBlock(elements, startIndex, blockLength);
  const offsetMinutes = toMinutes(offsetValue, offsetUnit);
  const totalRows = block.rows.length * times;

  function handleDone() {
    onDone(
      repeatBlock({
        elements,
        startIndex,
        blockLength,
        times,
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
          <input
            type="number"
            min={1}
            max={maxLength}
            inputMode="numeric"
            value={blockLength}
            onChange={(e) =>
              setBlockLength(
                Math.max(1, Math.min(maxLength, parseInt(e.target.value, 10) || 1))
              )
            }
            className="w-16 px-2 py-2 border border-border rounded text-center text-base"
          />
          <span className="text-sm">{blockLength === 1 ? "step" : "steps"}</span>
        </div>

        {/* Times: the TOTAL, not the number of extra copies */}
        <div className="flex items-center gap-2 mb-3">
          <span className="text-sm">for a total of</span>
          <input
            type="number"
            min={1}
            max={99}
            inputMode="numeric"
            value={times}
            onChange={(e) =>
              setTimes(Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1)))
            }
            className="w-16 px-2 py-2 border border-border rounded text-center text-base"
          />
          <span className="text-sm">{times === 1 ? "pass" : "passes"}</span>
        </div>

        {/* Gap, with a unit so nobody computes that an hour is 60 */}
        <div className="flex items-center gap-2 mb-3 flex-wrap">
          <span className="text-sm">notify every</span>
          <input
            type="number"
            min={0}
            inputMode="numeric"
            value={offsetValue}
            onChange={(e) => setOffsetValue(e.target.value)}
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
              "Take dose" becomes "Take dose 1 of {times}". Without this, every
              copy has the same name.
            </span>
          </span>
        </label>

        {/* The preview. This is what a drag-selection would have shown. */}
        <div className="mb-4 p-3 bg-card border border-border rounded">
          <p className="text-xs text-muted-foreground mb-1">
            Repeating {block.rows.length} row{block.rows.length === 1 ? "" : "s"} ×{" "}
            {times} = <strong className="text-foreground">{totalRows} rows</strong>
            {block.stepCount > 0 && ` (${block.stepCount * times} with notifications)`}
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
              ? `These rows are already numbered (e.g. "${block.numberedNames[0]}"). They will be renumbered 1 of ${times}.`
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
