import { useCallback, useEffect, useRef, useState } from "react";
import { currentUserId, listExecutionNotes, saveNote } from "./notesApi";

/**
 * The execution page's note box: `draft` is the signed-in user's one note for
 * this execution, saved to the notes table with execution_id set. Saves are
 * queued so a blur followed by Back can never insert the same note twice.
 * Every other note (earlier ones, other people's) is the page's list, from
 * useRecordNotes.
 */
// `target`: { type, id } the note is on (Restructure P5: a menu run's note is on the
// group, a recipe's on the item); the intention when not given.
export function useExecutionNotes({ executionId, intentId, target = null }) {
  const targetType = target?.type || "intention";
  const targetId = target ? target.id : intentId;
  const [mineId, setMineId] = useState(null);
  const [draft, setDraftState] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saveState, setSaveState] = useState("idle"); // idle | saving | error
  const mine = useRef(null);
  const draftRef = useRef("");
  const queue = useRef(Promise.resolve());

  const setDraft = useCallback((text) => {
    draftRef.current = text;
    setDraftState(text);
  }, []);

  useEffect(() => {
    let live = true;
    setLoaded(false);
    mine.current = null;
    (async () => {
      try {
        const [uid, own] = await Promise.all([currentUserId(), listExecutionNotes(executionId)]);
        if (!live) return;
        mine.current = own.find((n) => n.userId === uid) || null;
        setMineId(mine.current?.id || null);
        setDraft(mine.current?.body || "");
        setLoaded(true);
      } catch (e) {
        console.error("[Notes] load failed:", e);
      }
    })();
    return () => {
      live = false;
    };
  }, [executionId, setDraft]);

  // Resolves true when the text is saved (or nothing needed saving).
  const save = useCallback(
    (text = draftRef.current) => {
      if (!loaded || !targetId) return Promise.resolve(true);
      const run = queue.current.then(async () => {
        const before = mine.current?.body || "";
        if (text.trim() === before.trim()) return true;
        setSaveState("saving");
        try {
          mine.current = await saveNote({
            id: mine.current?.id,
            body: text,
            targetType,
            targetId,
            executionId,
          });
          setMineId(mine.current?.id || null);
          setSaveState("idle");
          return true;
        } catch (e) {
          console.error("[Notes] save failed:", e);
          setSaveState("error");
          return false;
        }
      });
      queue.current = run;
      return run;
    },
    [loaded, targetType, targetId, executionId],
  );

  // Leaving by any route (bottom dock, a link) still saves what was typed.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => () => saveRef.current(), []);

  return { mineId, draft, setDraft, save, loaded, saveState };
}
