import { useEffect, useState } from "react";
import { listNotesForExecutions, onNotesChanged } from "./notesApi";

// List cards each ask for their open execution's notes. Asks made in the same
// render are gathered and sent as ONE query (execution_id in (...)), so a long
// list costs one round trip, not one per card. Answers are cached per
// execution and dropped whenever a note is written.

const cache = new Map(); // executionId -> notes, newest first
const waiting = new Map(); // executionId -> Set of setters
let queued = new Set();
let timer = null;

function deliver(id) {
  for (const set of waiting.get(id) || []) set(cache.get(id) || []);
}

function flush() {
  timer = null;
  const ids = [...queued];
  queued = new Set();
  listNotesForExecutions(ids)
    .then((rows) => {
      for (const id of ids) cache.set(id, rows.filter((n) => n.executionId === id));
      ids.forEach(deliver);
    })
    .catch((e) => console.error("[Notes] card batch failed:", e));
}

function request(id) {
  queued.add(id);
  if (!timer) timer = setTimeout(flush, 0);
}

onNotesChanged(() => {
  cache.clear();
  for (const id of waiting.keys()) request(id);
});

/** The notes of one open execution, newest first, or [] (also while loading). */
export function useCardExecutionNotes(executionId) {
  const [notes, setNotes] = useState(() => (executionId && cache.get(executionId)) || []);

  useEffect(() => {
    if (!executionId) return undefined;
    if (!waiting.has(executionId)) waiting.set(executionId, new Set());
    waiting.get(executionId).add(setNotes);
    if (cache.has(executionId)) setNotes(cache.get(executionId));
    else request(executionId);
    return () => {
      const set = waiting.get(executionId);
      set.delete(setNotes);
      if (set.size === 0) waiting.delete(executionId);
    };
  }, [executionId]);

  return notes;
}

// Tests only.
export function _resetCardNotesCache() {
  cache.clear();
  waiting.clear();
  queued = new Set();
  if (timer) clearTimeout(timer);
  timer = null;
}
