import { useRef, useCallback } from "react";
import { supabase } from "../../supabaseClient";

// Pass counting: eligibility tracking plus the append-only write to
// `sam_passes`. One row per completed playthrough of whatever range is
// loaded — the whole song, or a snippet.
//
// Eligibility, not position, is what makes a completion count. The flag is
// armed the moment playback is started from the first measure of the loaded
// range and stays armed across a pause, because pause/resume is the same
// playthrough interrupted (spec rule 4). Stop, reset, a range change, or any
// future seek/scrub entry point disarms it: the playthrough those interrupt is
// abandoned, not paused (rule 5).
//
// `recordPass` re-arms before it writes, which is what makes looped playback
// count per cycle rather than once (rule 1). The write itself is deliberately
// fire-and-forget and fully guarded — it is invoked from ScrollEngine's
// requestAnimationFrame loop, where a throw would stop the scroll mid-song.
// A failed pass write costs a row; it must never cost the playthrough.
export default function useSamPasses({ onPassRecorded } = {}) {
  const armedRef = useRef(false);

  // Fires once a pass row has actually landed. Held in a ref so callers can
  // pass an inline arrow without destabilising `recordPass`, which must stay
  // referentially stable — it is reached from ScrollEngine's captured
  // `onLoopCount` closure, and a changed identity there is never called again.
  const onPassRecordedRef = useRef(onPassRecorded);
  onPassRecordedRef.current = onPassRecorded;

  // Playback began at the first measure of the loaded range.
  const armPass = useCallback(() => {
    armedRef.current = true;
  }, []);

  // The playthrough in progress is abandoned. Never removes banked passes —
  // those are rows, and rows are only ever inserted.
  const disarmPass = useCallback(() => {
    armedRef.current = false;
  }, []);

  // Credit a completed playthrough, if one was eligible.
  //
  // `snippet` is the loaded snippet object or null. A null snippet means the
  // range was the whole song and the row carries `snippet_id: null`; a loaded
  // snippet credits itself and never the song (rule 6).
  //
  // Returns true when a row was queued, false when the completion was not
  // eligible or could not be attributed — so callers can log the distinction
  // without reaching into the ref.
  const recordPass = useCallback(({ songId, snippet, sessionId, bpm }) => {
    if (!armedRef.current) return false;

    // Re-arm first, before anything that can fail. The next loop cycle has
    // already begun by the time this runs — ScrollEngine teleports and then
    // calls us — so an early return below must still leave the next cycle
    // countable.
    armedRef.current = true;

    if (!songId) {
      console.warn("[Sam] Pass completed before the song had a DB id — not recorded");
      return false;
    }

    // An ad-hoc range that has never been saved has no row of its own. It
    // cannot be written as a snippet pass (no id to reference) and must not be
    // written as a song pass (it is not the whole song), so it is dropped.
    //
    // Applying a range that DOES match a saved snippet adopts that snippet's id
    // in SnippetPanel, so reaching here means the range genuinely has no saved
    // counterpart — save it and its passes start counting.
    if (snippet && !snippet.dbId) {
      console.warn(
        `[Sam] Pass completed on an unsaved range (m.${snippet.startMeasure}-${snippet.endMeasure}) — save it as a snippet to count its passes`
      );
      return false;
    }

    const row = {
      song_id: songId,
      snippet_id: snippet?.dbId || null,
      session_id: sessionId || null,
      bpm: Number.isFinite(bpm) ? Math.round(bpm) : null,
      completed_at: new Date().toISOString(),
    };

    try {
      supabase
        .from("sam_passes")
        .insert(row)
        .then(({ error }) => {
          if (error) {
            console.error("[Sam] Pass write failed (playback continues):", error);
            return;
          }
          console.log("[Sam] Pass recorded:", row);
          // Notified on success only: the on-screen count claims what has been
          // recorded, so a failed write must leave it where it was.
          try {
            // Pass the written `snippet_id` rather than letting the listener
            // read current state: it identifies the range this pass was
            // actually credited to, which is what keeps a snippet's passes out
            // of the song's own count.
            onPassRecordedRef.current?.({ snippetId: row.snippet_id });
          } catch (cbErr) {
            console.error("[Sam] onPassRecorded callback threw:", cbErr);
          }
        });
    } catch (e) {
      console.error("[Sam] Pass write threw (playback continues):", e);
      return false;
    }

    return true;
  }, []);

  return { armPass, disarmPass, recordPass };
}
