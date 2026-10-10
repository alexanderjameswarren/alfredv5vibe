import { useCallback, useEffect, useState } from "react";
import { currentUserId, deleteNote, listExecutionNotes, listNotesForTargets, onNotesChanged, saveNote } from "./notesApi";

/**
 * The note timeline for one item or intention. Item pages also pass the item's
 * intentions, so their general and execution notes join the same list.
 * `target` is where a new note goes. With `executionId` the list is that one
 * execution's notes, and new notes are written against it.
 */
export function useRecordNotes({ target, itemIds = [], intentionIds = [], executionId = null }) {
  const [notes, setNotes] = useState(null);
  const [userId, setUserId] = useState(null);
  const [error, setError] = useState(null);
  // Arrays from the caller are new every render; key the load on their contents.
  const key = `${itemIds.join(",")}|${intentionIds.join(",")}|${executionId || ""}`;

  const load = useCallback(async () => {
    try {
      const [uid, rows] = await Promise.all([
        currentUserId(),
        executionId
          ? listExecutionNotes(executionId).then((r) => [...r].reverse())
          : listNotesForTargets({ itemIds, intentionIds }),
      ]);
      setUserId(uid);
      setNotes(rows);
    } catch (e) {
      console.error("[Notes] load failed:", e);
      setNotes([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Reload on any note write, including a save landing after this page opened.
  useEffect(() => {
    load();
    return onNotesChanged(load);
  }, [load]);

  const run = useCallback(async (write) => {
    setError(null);
    try {
      await write();
      return true;
    } catch (e) {
      console.error("[Notes] write failed:", e);
      setError("The note was not saved.");
      return false;
    }
  }, []);

  const add = (body) =>
    run(async () => {
      const row = await saveNote({
        body,
        targetType: target.type,
        targetId: target.id,
        ...(executionId ? { executionId } : {}),
      });
      if (row) setNotes((prev) => [row, ...(prev || [])]);
    });

  const edit = (id, body) =>
    run(async () => {
      const row = await saveNote({ id, body });
      setNotes((prev) => (row ? prev.map((n) => (n.id === id ? row : n)) : prev.filter((n) => n.id !== id)));
    });

  const remove = (id) =>
    run(async () => {
      await deleteNote(id);
      setNotes((prev) => prev.filter((n) => n.id !== id));
    });

  return { notes, userId, error, add, edit, remove };
}
