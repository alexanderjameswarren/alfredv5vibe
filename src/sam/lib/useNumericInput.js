import { useState } from "react";

// Pairs a numeric value with the string draft the user is typing into a
// number input. Eliminates the `[bpm, bpmInput] = [useState, useState]`
// boilerplate and centralizes the on-blur "commit-with-clamp" pattern.
//
// Usage:
//   const bpm = useNumericInput(68);
//   <input
//     value={bpm.input}
//     onChange={(e) => bpm.setInput(e.target.value)}
//     onBlur={() => bpm.commit({ min: 1, fallback: 68 })}
//   />
//   ...read the number elsewhere as `bpm.value`.
//
// Return shape:
//   value      — committed numeric value
//   input      — current draft string
//   set(n)     — write both value and input to a new committed number
//   setInput   — raw setter for the draft (used by onChange)
//   commit     — parse input, fall back / clamp via { min, max, fallback }
//   reset(n)   — alias of set(n); exists for caller readability when seeding
//                from a freshly-loaded song so the intent is "this is the
//                authoritative new value", not "the user committed".
export default function useNumericInput(initial) {
  const [value, setValue] = useState(initial);
  const [input, setInput] = useState(String(initial));

  function set(n) {
    setValue(n);
    setInput(String(n));
  }

  function commit({ min, max, fallback } = {}) {
    let n = Number(input);
    // NaN catches "" and non-numeric strings; the explicit check lets a
    // legitimate 0 survive when no min (or min <= 0) is set.
    if (Number.isNaN(n) || (min != null && n < min)) {
      n = fallback;
    } else if (max != null && n > max) {
      n = max;
    }
    setValue(n);
    setInput(String(n));
    return n;
  }

  return {
    value,
    input,
    set,
    setInput,
    commit,
    reset: set,
  };
}
