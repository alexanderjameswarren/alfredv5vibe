import React from "react";
import { NoteLine } from "./noteFormat";
import { useCardExecutionNotes } from "./useCardExecutionNotes";

const SHOWN = 2;

// On a list card: the open execution's latest notes, one line each, two at
// most. Read only, and not a tap target of its own — the card is.
export default function CardExecutionNotes({ executionId }) {
  const notes = useCardExecutionNotes(executionId);
  if (notes.length === 0) return null;
  return (
    <span className="block" aria-label="Notes on the open execution">
      {notes.slice(0, SHOWN).map((n) => (
        <NoteLine key={n.id} oneLine>
          {n.body}
        </NoteLine>
      ))}
    </span>
  );
}
