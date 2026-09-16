import { supabase } from "../../supabaseClient";

// Snippet identity, titling, and the save-if-absent path.
//
// One definition of what makes two snippets "the same snippet", shared by the
// snippet panel (which resolves a range to a saved row as you edit it) and by
// SamPlayer (which saves an unsaved range when Play is pressed). Two copies of
// this rule that drifted apart would silently fork practice history, which is
// the bug this module exists to stop happening twice.

// Snippet display label derived from the snippet's properties. Used at every
// title rendering site so saved-snippet titles always reflect current state
// (hand mode, rest count) rather than a stale stored string. The stored
// `title` column still gets this value written on save; display is computed
// from properties for backward compatibility with rows whose stored title
// doesn't match the current format.
export function formatSnippetTitle({ startMeasure, endMeasure, handMode, restMeasures }) {
  const handLabel =
    handMode === "lh" ? "LH" :
    handMode === "rh" ? "RH" : "Both";
  const restLabel = restMeasures > 0 ? `Rest: ${restMeasures}` : "No Rest";
  return `Measures ${startMeasure}-${endMeasure} ${handLabel} ${restLabel}`;
}

// The four properties that define a snippet — exactly the ones
// `formatSnippetTitle` renders, which is why two snippets agreeing on all four
// are indistinguishable to the user and must not become two rows.
function identityOf(range) {
  return {
    startMeasure: range.startMeasure,
    endMeasure: range.endMeasure,
    restMeasures: range.restMeasures ?? 0,
    handMode: range.handMode || "both",
  };
}

// Same comparison against a `sam_snippets` row rather than an app-side range.
function rowMatchesRange(row, range) {
  const id = identityOf(range);
  return (
    row.start_measure === id.startMeasure &&
    row.end_measure === id.endMeasure &&
    (row.rest_measures ?? 0) === id.restMeasures &&
    (row.settings?.handMode || "both") === id.handMode
  );
}

// Do two loaded ranges describe the same stretch of music, played the same way?
// Deliberately ignores `dbId`: resolving a range's database id does not change
// what is loaded, and SamPlayer relies on that to avoid resetting playback when
// Play attaches an id to a range mid-start.
export function sameLoadedRange(a, b) {
  if (!a || !b) return false;
  const x = identityOf(a);
  const y = identityOf(b);
  return (
    x.startMeasure === y.startMeasure &&
    x.endMeasure === y.endMeasure &&
    x.restMeasures === y.restMeasures &&
    x.handMode === y.handMode
  );
}

// The row in `rows` describing `range`, or null.
//
// Archive state is NOT part of identity. A snippet IS its range, rests and hand
// mode; `archived` is a visibility flag on top of that. Excluding archived rows
// here used to mean archiving a snippet and recreating its range inserted a
// second row with the same identity — and practice history then split across the
// two, leaving neither total correct.
//
// Which rows are searched is the caller's decision, and the two callers differ
// on purpose: `ensureSnippetSaved` passes everything, because saving must find
// an archived twin and restore it; the snippet panel passes only its live list,
// because Save New should stay on offer when the sole match is archived. A live
// row wins over an archived one when both somehow exist, so a database still
// holding pre-M1.8 duplicates resolves to the visible one.
export function findMatchingSnippet(rows, range) {
  const matches = (rows || []).filter((r) => rowMatchesRange(r, range));
  return matches.find((r) => !r.archived) || matches[0] || null;
}

// A `sam_snippets` row in the shape SamPlayer's `snippet` state expects.
export function snippetFromRow(row) {
  return {
    startMeasure: row.start_measure,
    endMeasure: row.end_measure,
    restMeasures: row.rest_measures ?? 0,
    handMode: row.settings?.handMode || "both",
    dbId: row.id,
    title: row.title,
  };
}

// Guarantee `range` has a `sam_snippets` row behind it, and return it as a
// loadable snippet.
//
// Matching comes first and matters more than saving: replaying the same ad-hoc
// range on Monday and again on Tuesday must land on ONE snippet, or the saved
// list fills with near-identical entries and per-snippet practice totals split
// across them. Only a range with no saved counterpart creates a row.
//
// An archived match is RESTORED rather than duplicated, keeping its id — which
// is the whole point, because that id is what every existing `sam_passes` and
// `sam_sessions` row references. `created_at` is deliberately left alone, so a
// restored snippet returns to its original place in the newest-first list
// instead of jumping to the top as if it were new.
//
// Returns `{ snippet, row, created, restored }`, or null if the database could
// not be reached. `row` is the raw `sam_snippets` record, for callers keeping a
// list of them. A null return is not fatal and callers are expected to carry on
// without an id — losing one snippet row is preferable to refusing to play.
export async function ensureSnippetSaved({ songDbId, range }) {
  if (!songDbId || !range) return null;

  const id = identityOf(range);

  try {
    // Narrow on the columns the database can index, then apply the full
    // identity test in `findMatchingSnippet` so the rule lives in one place.
    const { data: rows, error: selectError } = await supabase
      .from("sam_snippets")
      .select("*")
      .eq("song_id", songDbId)
      .eq("start_measure", id.startMeasure)
      .eq("end_measure", id.endMeasure);

    if (selectError) {
      console.error("[Sam] Snippet lookup failed (playback continues):", selectError);
      return null;
    }

    // Every row for this range, archived included — see `findMatchingSnippet`.
    const match = findMatchingSnippet(rows, range);

    if (match && !match.archived) {
      return { snippet: snippetFromRow(match), row: match, created: false, restored: false };
    }

    if (match) {
      const { data: restoredRow, error: restoreError } = await supabase
        .from("sam_snippets")
        .update({ archived: false })
        .eq("id", match.id)
        .select("*")
        .single();

      if (restoreError) {
        // Adopt the archived row's id anyway rather than falling through to the
        // insert below. A snippet that stays flagged archived is a cosmetic
        // problem; a second row with the same identity is the bug this whole
        // function exists to prevent, and it splits practice history for good.
        console.error("[Sam] Snippet restore failed — adopting the archived row as-is:", restoreError);
        return { snippet: snippetFromRow(match), row: match, created: false, restored: false };
      }

      return { snippet: snippetFromRow(restoredRow), row: restoredRow, created: false, restored: true };
    }

    const { data, error: insertError } = await supabase
      .from("sam_snippets")
      .insert({
        song_id: songDbId,
        title: formatSnippetTitle(id),
        start_measure: id.startMeasure,
        end_measure: id.endMeasure,
        rest_measures: id.restMeasures,
        settings: { handMode: id.handMode },
      })
      .select("*")
      .single();

    if (insertError) {
      console.error("[Sam] Snippet auto-save failed (playback continues):", insertError);
      return null;
    }

    return { snippet: snippetFromRow(data), row: data, created: true, restored: false };
  } catch (e) {
    console.error("[Sam] Snippet auto-save threw (playback continues):", e);
    return null;
  }
}
