import React, { useEffect, useRef, useState } from "react";

// A brief message with no action, e.g. "Moved to active". Separate from the
// Undo slot so it can never replace an undo offer.
export function useNotice(durationMs = 3000) {
  const [notice, setNotice] = useState(null);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  function showNotice(message) {
    clearTimeout(timerRef.current);
    setNotice(message);
    timerRef.current = setTimeout(() => setNotice(null), durationMs);
  }
  return { notice, showNotice };
}

export default function Notice({ notice }) {
  if (!notice) return null;
  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-4 pb-2">
      <div role="status" aria-live="polite" className="px-3 sm:px-4 py-2 bg-foreground text-white rounded-lg shadow-lg text-sm">
        {notice}
      </div>
    </div>
  );
}
