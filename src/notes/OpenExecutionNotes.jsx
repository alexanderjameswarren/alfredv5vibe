import React, { useEffect, useState } from "react";
import { listExecutionNotes, onNotesChanged } from "./notesApi";
import { NoteLine } from "./noteFormat";

// Notes written so far during one open execution, as plain lines inside its
// teal or amber card. Read only here: they are written on the execution page,
// which tapping the card opens. Reloads when any note is written, since the
// execution page's last save can land after this mounts.
export default function OpenExecutionNotes({ executionId }) {
  const [notes, setNotes] = useState([]);

  useEffect(() => {
    let live = true;
    const load = () =>
      listExecutionNotes(executionId)
        .then((rows) => live && setNotes(rows))
        .catch((e) => console.error("[Notes] open execution notes failed:", e));
    load();
    const stop = onNotesChanged(load);
    return () => {
      live = false;
      stop();
    };
  }, [executionId]);

  if (notes.length === 0) return null;
  return (
    <div aria-label="Notes on this execution">
      {notes.map((n) => (
        <NoteLine key={n.id}>{n.body}</NoteLine>
      ))}
    </div>
  );
}
