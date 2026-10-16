import React from "react";

/**
 * A whole number from what was typed, or null when it is empty, not a whole
 * number, below `min` or above `max`.
 */
export function parseWhole(raw, { min = 1, max = Infinity } = {}) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/**
 * A small whole-number box (Restructure P4; SAM and the rest can adopt it later,
 * see Alfred record 790410b6). Holds the RAW text, so it may be empty while
 * typing and never snaps back to a default; focus selects the whole value, so
 * typing replaces it. When the value is not usable it says why, under the box;
 * the form disables its own Done with `parseWhole`.
 */
export default function NumberInput({ value, onChange, min = 1, max = Infinity, disabled = false, className = "", ...rest }) {
  const text = String(value ?? "");
  const n = parseWhole(text, { min, max });
  const message = disabled || n !== null ? null : /^\d+$/.test(text.trim()) && Number(text) > max ? `At most ${max}` : "Required";
  return (
    <span className="inline-flex flex-col items-center">
      <input
        type="text"
        inputMode="numeric"
        pattern="[0-9]*"
        value={text}
        disabled={disabled}
        aria-invalid={message ? true : undefined}
        onFocus={(e) => e.target.select()}
        onChange={(e) => {
          if (/^\d*$/.test(e.target.value)) onChange(e.target.value);
        }}
        className={className}
        {...rest}
      />
      {message && <span className="text-xs text-destructive mt-0.5">{message}</span>}
    </span>
  );
}
