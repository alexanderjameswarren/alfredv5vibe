import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  loadFingerings,
  setFingering,
  clearFingering,
  resolveFingerings,
  fingeringKey,
} from "./fingeringsApi";

// Encapsulates fingering writes for the edit screen: the loaded coordinate map,
// optimistic set/clear with rollback + toast on failure, and an in-session undo
// stack (last 20 ops).
//
// `byCoord` ({ "m:rh:ni": { manual, musicxml } }) is the source of truth so
// precedence stays correct and clearing a manual override re-reveals an imported
// one without a refetch. `fingerings` is the resolved render map both renderers
// consume. Coordinates are { measureNum, rhIndex, noteIndex }.
export default function useFingeringEditor({ songId, showImported }) {
  const [byCoord, setByCoord] = useState({});
  const [undoStack, setUndoStack] = useState([]);
  const [error, setError] = useState(null);

  // Refs mirror the latest committed state so async write handlers can read
  // "the value before this op" without stale closures.
  const byCoordRef = useRef(byCoord);
  byCoordRef.current = byCoord;
  const undoStackRef = useRef(undoStack);
  undoStackRef.current = undoStack;
  const errorTimerRef = useRef(null);

  // Load on song change; reset undo history + any stale error.
  useEffect(() => {
    setUndoStack([]);
    setError(null);
    if (!songId) { setByCoord({}); return; }
    let cancelled = false;
    loadFingerings(songId)
      .then((map) => { if (!cancelled) setByCoord(map); })
      .catch((e) => {
        if (!cancelled) { console.error("[Sam] Failed to load fingerings:", e); setByCoord({}); }
      });
    return () => { cancelled = true; };
  }, [songId]);

  const fingerings = useMemo(
    () => resolveFingerings(byCoord, showImported),
    [byCoord, showImported]
  );

  const flashError = useCallback((msg) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), 4000);
  }, []);

  // Apply a manual value (finger number, or null to clear) optimistically, then
  // persist. On failure, roll back to the exact prior coordinate state and toast.
  // Does NOT touch the undo stack — callers decide whether an op is undoable.
  const applyManual = useCallback(async (coord, finger) => {
    if (!songId) return;
    const key = fingeringKey(coord);
    const prevEntry = byCoordRef.current[key]; // undefined if nothing was there

    setByCoord((prev) => {
      const next = { ...prev };
      const cur = next[key] || { manual: null, musicxml: null };
      next[key] = { ...cur, manual: finger == null ? null : { finger, source: "manual" } };
      return next;
    });

    try {
      if (finger == null) await clearFingering(songId, coord);
      else await setFingering(songId, coord, finger);
    } catch (e) {
      console.error("[Sam] Fingering write failed:", e);
      setByCoord((prev) => {
        const next = { ...prev };
        if (prevEntry === undefined) delete next[key];
        else next[key] = prevEntry;
        return next;
      });
      flashError("Couldn't save fingering — change reverted.");
    }
  }, [songId, flashError]);

  const pushUndo = useCallback((entry) => {
    setUndoStack((s) => [...s, entry].slice(-20)); // keep the last 20 ops
  }, []);

  // Set a manual finger on a coordinate (user action → undoable).
  const setFinger = useCallback((coord, finger) => {
    const prevFinger = byCoordRef.current[fingeringKey(coord)]?.manual?.finger ?? null;
    pushUndo({ op: "set", coord, prevFinger, nextFinger: finger });
    applyManual(coord, finger);
  }, [applyManual, pushUndo]);

  // Clear the manual finger on a coordinate (user action → undoable). No-op if
  // there is no manual row to remove.
  const clearFinger = useCallback((coord) => {
    const prevFinger = byCoordRef.current[fingeringKey(coord)]?.manual?.finger ?? null;
    if (prevFinger == null) return;
    pushUndo({ op: "clear", coord, prevFinger, nextFinger: null });
    applyManual(coord, null);
  }, [applyManual, pushUndo]);

  // Reverse the most recent op by restoring its prior value. Undo is not itself
  // pushed onto the stack.
  const undo = useCallback(() => {
    const stack = undoStackRef.current;
    if (stack.length === 0) return;
    const entry = stack[stack.length - 1];
    setUndoStack((s) => s.slice(0, -1));
    applyManual(entry.coord, entry.prevFinger);
  }, [applyManual]);

  return {
    fingerings,
    setFinger,
    clearFinger,
    undo,
    canUndo: undoStack.length > 0,
    error,
    dismissError: useCallback(() => setError(null), []),
  };
}
