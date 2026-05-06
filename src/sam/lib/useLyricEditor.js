import { useCallback, useEffect, useMemo, useState } from "react";
import { recompileMeasures } from "./measureCompiler";

// Encapsulates lyric-editing state, derived navigation indices, the four
// pull/push/cascade handlers, the sam_song_lyrics fetch, and the save/recompile
// flow. The parent owns `skipTiedNotes` (a UI toggle) and consumes the returned
// `lyricPlacements` to inject syllables into `activeMeasures` for rendering.
//
// `setLyricPlacements` resets the dirty flag so external "fresh from DB" updates
// (e.g. the auto-match flow) don't leave the dirty flag set. Internal handlers
// use a private helper that sets dirty=true.
//
// `saveLyrics` returns the recompiled measures (or null on error / no-op) so the
// parent can fold them into the song state without the hook depending on
// `setSong`.
export default function useLyricEditor({ song, songDbId, skipTiedNotes, supabase }) {
  const [lyricPlacements, setLyricPlacementsState] = useState(null);
  const [lyricsDirty, setLyricsDirty] = useState(false);
  const [lyricsSaving, setLyricsSaving] = useState(false);

  const setLyricPlacements = useCallback((placements) => {
    setLyricPlacementsState(placements);
    setLyricsDirty(false);
  }, []);

  // Fetch lyrics from sam_song_lyrics when song is loaded
  useEffect(() => {
    if (!songDbId) {
      setLyricPlacementsState(null);
      setLyricsDirty(false);
      return;
    }
    supabase
      .from("sam_song_lyrics")
      .select("word_order, syllable, measure_num, rh_index")
      .eq("song_id", songDbId)
      .order("word_order", { ascending: true })
      .then(({ data, error }) => {
        if (error) {
          console.error("[Sam] Failed to fetch lyrics:", error);
          setLyricPlacementsState(null);
        } else {
          setLyricPlacementsState(data && data.length > 0 ? data : null);
        }
        setLyricsDirty(false);
      });
  }, [songDbId, supabase]);

  // Flat sequence of all non-rest RH note positions for lyric navigation
  // isTiedCont: true if ALL notes have tie='end' or tie='both' (continuation of a tied note)
  const rhNoteSequence = useMemo(() => {
    if (!song?.measures) return [];
    const seq = [];
    for (const m of song.measures) {
      const rh = m.rh || [];
      for (let i = 0; i < rh.length; i++) {
        if (rh[i].notes && rh[i].notes.length > 0) {
          const isTiedCont = rh[i].notes.every((n) => n.tie === "end" || n.tie === "both");
          seq.push({ measureNum: m.number, rhIndex: i, isTiedCont });
        }
      }
    }
    return seq;
  }, [song]);

  // Map from "measureNum-rhIndex" → sequence index for O(1) lookup
  const rhSeqIdxMap = useMemo(() => {
    const map = {};
    for (let i = 0; i < rhNoteSequence.length; i++) {
      const n = rhNoteSequence[i];
      map[`${n.measureNum}-${n.rhIndex}`] = i;
    }
    return map;
  }, [rhNoteSequence]);

  const findRhSeqIdx = useCallback(
    (measureNum, rhIndex) => rhSeqIdxMap[`${measureNum}-${rhIndex}`] ?? -1,
    [rhSeqIdxMap]
  );

  // Navigate to next/prev position, skipping tied continuations when skipTiedNotes is on
  const nextNavIdx = useCallback((fromSeqIdx, direction) => {
    let idx = fromSeqIdx + direction;
    if (!skipTiedNotes) return idx;
    while (idx >= 0 && idx < rhNoteSequence.length) {
      if (!rhNoteSequence[idx].isTiedCont) return idx;
      idx += direction;
    }
    return idx; // out of bounds
  }, [rhNoteSequence, skipTiedNotes]);

  const applyPlacementChange = useCallback((newPlacements) => {
    setLyricPlacementsState(newPlacements);
    setLyricsDirty(true);
  }, []);

  // --- Lyric editing handlers ---
  // wordOrders: array of word_orders at the clicked position (group moves together)

  const handleLyricPullBack = useCallback((wordOrders) => {
    if (!lyricPlacements) return;
    const first = lyricPlacements.find((lp) => lp.word_order === wordOrders[0]);
    if (!first || first.measure_num == null) return;
    const seqIdx = findRhSeqIdx(first.measure_num, first.rh_index);
    const prevIdx = nextNavIdx(seqIdx, -1);
    if (prevIdx < 0) return;
    const prevPos = rhNoteSequence[prevIdx];
    // When multiple syllables share a position, only move the earliest (min word_order)
    const moveWO = wordOrders.length > 1 ? Math.min(...wordOrders) : wordOrders[0];
    applyPlacementChange(
      lyricPlacements.map((lp) =>
        lp.word_order === moveWO
          ? { ...lp, measure_num: prevPos.measureNum, rh_index: prevPos.rhIndex }
          : lp
      )
    );
  }, [lyricPlacements, rhNoteSequence, findRhSeqIdx, nextNavIdx, applyPlacementChange]);

  const handleLyricPushForward = useCallback((wordOrders) => {
    if (!lyricPlacements) return;
    // When multiple syllables share a position, only move the latest (max word_order)
    const moveWOs = wordOrders.length > 1 ? [Math.max(...wordOrders)] : [...wordOrders];
    const first = lyricPlacements.find((lp) => lp.word_order === moveWOs[0]);
    if (!first || first.measure_num == null) return;
    const seqIdx = findRhSeqIdx(first.measure_num, first.rh_index);
    const targetIdx = nextNavIdx(seqIdx, 1);
    if (targetIdx >= rhNoteSequence.length) {
      alert("Cannot push forward — already at the last note.");
      return;
    }

    // Build seqIdx → [word_orders] map for collision detection
    const posMap = {};
    for (const lp of lyricPlacements) {
      if (lp.measure_num == null) continue;
      const si = findRhSeqIdx(lp.measure_num, lp.rh_index);
      if (si >= 0) {
        if (!posMap[si]) posMap[si] = [];
        posMap[si].push(lp.word_order);
      }
    }

    // Collect displacement chain: move clicked group forward, cascade until gap found
    const moves = []; // [{wordOrders, toIdx}]
    moves.push({ wordOrders: moveWOs, toIdx: targetIdx });
    const alreadyMoving = new Set(moveWOs);

    let checkIdx = targetIdx;
    while (checkIdx < rhNoteSequence.length) {
      const occupants = (posMap[checkIdx] || []).filter((wo) => !alreadyMoving.has(wo));
      if (occupants.length === 0) break; // gap found
      const nextIdx = nextNavIdx(checkIdx, 1);
      if (nextIdx >= rhNoteSequence.length) {
        alert("Cannot push forward — would exceed available notes.");
        return;
      }
      moves.push({ wordOrders: occupants, toIdx: nextIdx });
      for (const wo of occupants) alreadyMoving.add(wo);
      checkIdx = nextIdx;
    }

    // Apply moves
    const moveMap = {};
    for (const move of moves) {
      const targetPos = rhNoteSequence[move.toIdx];
      for (const wo of move.wordOrders) {
        moveMap[wo] = targetPos;
      }
    }
    applyPlacementChange(
      lyricPlacements.map((lp) => {
        const target = moveMap[lp.word_order];
        return target ? { ...lp, measure_num: target.measureNum, rh_index: target.rhIndex } : lp;
      })
    );
  }, [lyricPlacements, rhNoteSequence, findRhSeqIdx, nextNavIdx, applyPlacementChange]);

  const handleLyricCascadePullBack = useCallback((wordOrders) => {
    if (!lyricPlacements) return;
    const minWO = Math.min(...wordOrders);
    const toMove = lyricPlacements.filter(
      (lp) => lp.word_order >= minWO && lp.measure_num != null
    );
    const toMoveWOs = new Set(toMove.map((lp) => lp.word_order));
    const nonMoving = lyricPlacements.filter(
      (lp) => !toMoveWOs.has(lp.word_order) && lp.measure_num != null
    );

    // Check all moving syllables: can they go back without collision?
    const moveTargets = {};
    for (const lp of toMove) {
      const seqIdx = findRhSeqIdx(lp.measure_num, lp.rh_index);
      const prevIdx = nextNavIdx(seqIdx, -1);
      if (prevIdx < 0) return;
      const prevPos = rhNoteSequence[prevIdx];
      if (
        nonMoving.some(
          (nm) => nm.measure_num === prevPos.measureNum && nm.rh_index === prevPos.rhIndex
        )
      ) {
        return; // would create multiples
      }
      moveTargets[lp.word_order] = prevPos;
    }

    applyPlacementChange(
      lyricPlacements.map((lp) => {
        const target = moveTargets[lp.word_order];
        return target ? { ...lp, measure_num: target.measureNum, rh_index: target.rhIndex } : lp;
      })
    );
  }, [lyricPlacements, findRhSeqIdx, nextNavIdx, rhNoteSequence, applyPlacementChange]);

  const handleLyricCascadePushForward = useCallback((wordOrders) => {
    if (!lyricPlacements) return;
    const minWO = Math.min(...wordOrders);
    const toMove = lyricPlacements.filter(
      (lp) => lp.word_order >= minWO && lp.measure_num != null
    );

    // Check none would exceed bounds and compute targets
    const moveTargets = {};
    for (const lp of toMove) {
      const seqIdx = findRhSeqIdx(lp.measure_num, lp.rh_index);
      const nextIdx = nextNavIdx(seqIdx, 1);
      if (nextIdx >= rhNoteSequence.length) {
        alert("Cannot push forward — would exceed available notes.");
        return;
      }
      moveTargets[lp.word_order] = rhNoteSequence[nextIdx];
    }

    applyPlacementChange(
      lyricPlacements.map((lp) => {
        const target = moveTargets[lp.word_order];
        return target ? { ...lp, measure_num: target.measureNum, rh_index: target.rhIndex } : lp;
      })
    );
  }, [lyricPlacements, findRhSeqIdx, nextNavIdx, rhNoteSequence, applyPlacementChange]);

  const lyricEditHandlers = useMemo(
    () => ({
      onPullBack: handleLyricPullBack,
      onPushForward: handleLyricPushForward,
      onCascadePullBack: handleLyricCascadePullBack,
      onCascadePushForward: handleLyricCascadePushForward,
    }),
    [
      handleLyricPullBack,
      handleLyricPushForward,
      handleLyricCascadePullBack,
      handleLyricCascadePushForward,
    ]
  );

  async function saveLyrics() {
    if (!songDbId || !lyricPlacements || !lyricsDirty) return null;
    setLyricsSaving(true);
    try {
      // Single batch upsert keyed on the (song_id, word_order) unique
      // constraint. One round-trip means partial-failure can't leave half
      // the rows updated and the measures blob out of sync. `syllable` is
      // included because it's NOT NULL — on conflict it's re-written to
      // its existing value (no-op).
      const rows = lyricPlacements.map((lp) => ({
        song_id: songDbId,
        word_order: lp.word_order,
        syllable: lp.syllable,
        measure_num: lp.measure_num,
        rh_index: lp.rh_index,
      }));
      const { error } = await supabase
        .from("sam_song_lyrics")
        .upsert(rows, { onConflict: "song_id,word_order" });
      if (error) throw new Error("Failed to save: " + error.message);

      // Recompile only after the batch succeeds so the blob never
      // diverges from the rows on partial failure.
      const newMeasures = await recompileMeasures(songDbId, supabase);
      setLyricsDirty(false);
      console.log("[Sam] Lyrics saved and recompiled.");
      return newMeasures;
    } catch (err) {
      console.error("[Sam] Save lyrics failed:", err);
      alert("Save lyrics failed: " + err.message);
      return null;
    } finally {
      setLyricsSaving(false);
    }
  }

  return {
    lyricPlacements,
    setLyricPlacements,
    lyricsDirty,
    lyricsSaving,
    lyricEditHandlers,
    saveLyrics,
  };
}
