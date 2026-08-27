/* eslint-disable */
//
// SAM duplicate-pitch repair — paste into the BROWSER CONSOLE, on the tab where
// SAM is open and you are logged in.
//
//   1. Open the app (localhost:3000 or the deployed URL) and sign in.
//   2. Open DevTools → Console.
//   3. Paste this whole file.
//   4. Run:  await samRepairDuplicates()                          → dry run, every song
//            await samRepairDuplicates({ songId: "<id>" })        → dry run, one song
//            await samRepairDuplicates({ songId: "<id>", apply: true })
//            await samRepairDuplicates({ apply: true, all: true }) → repair everything
//
// DRY RUN IS THE DEFAULT. Nothing is written unless you pass { apply: true },
// and `apply` without a `songId` is refused unless you also pass { all: true }
// — repairing the whole library is available, but not by accident.
//
// It needs no credentials: supabase-js persists the session in localStorage on
// this origin, so we borrow that access token and talk to PostgREST with plain
// fetch. Same approach as scripts/sam-roundtrip-diff.js.
//
// WHAT IT DOES
//   Finds events where one pitch appears more than once as a fresh strike, and
//   collapses them into a single note carrying the union of their properties.
//   A pitch held by one voice while another strikes it fresh is NOT a duplicate
//   and is left alone — that rule lives in src/sam/lib/noteDuplicates.js and is
//   inlined below verbatim, not restated here.
//
// WHAT IT REFUSES
//   A song where a stored fingering would end up pointing at a different pitch.
//   Removing a note shifts note_index for everything above it in that event.
//   Such a song is reported with the offending rows named, and skipped entirely
//   — not partially repaired.
//
// ON APPLY it also sets measures_edited_at = now() and measures_compiled_at =
// null on each repaired song. sam_songs.measures is a compiled copy of the whole
// song and the app serves that copy; without this the repair appears to do
// nothing.

(function () {
  const SUPABASE_URL = "https://zuqjyfqnvhddnchhpbcz.supabase.co";
  const ANON_KEY =
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inp1cWp5ZnFudmhkZG5jaGhwYmN6Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzA3Mzc4NTYsImV4cCI6MjA4NjMxMzg1Nn0.BSRF3b5KZEWiVXm9f4eon6esqyrFPUM1qvlCzgwbJDo";

  // ==== BEGIN INLINED noteDuplicates.js — generated, do not edit ====
  // Duplicate-pitch rule for a single notation event — the shared predicate.
  //
  // One event's notes[] is a set of pitches sounding together. Two entries for
  // the same `midi` are the same sounding pitch, and storing both smears the
  // notehead in VexFlow and shifts the note_index that fingerings, lyric
  // placement and the simplification pipeline address notes by.
  //
  // EXCEPT when one entry is a CONTINUATION — tie "end" or "both", the tail of a
  // note struck earlier. Then one voice is holding the pitch while another
  // strikes it fresh: two distinct sounding events that legitimately share an
  // onset. Real in the corpus (Moonlight m60 C#4 + C#4:end, Someone Like You m27
  // F#4 + F#4:end) and noteTimeline.js's resolveTieChain depends on both copies
  // being present. Collapsing them changes what is heard.
  //
  // So the rule everything here is built on:
  //
  //     a pitch is duplicated iff it has more than one FRESH (non-continuation)
  //     entry in the same event.
  //
  // M1 uses it to merge at parse time; M2 uses it to reject at every write path.
  // Both go through `duplicatePitches` so the fixer and the checker cannot
  // disagree about what counts as a duplicate.
  //
  // Deliberately dependency-free and DOM-free: this module is imported by the
  // parser, by the app's validators, and (as a hand-kept port, see
  // supabase/functions/_shared/noteDuplicates.ts) by the Edge Function.

  /** The tail of a note struck earlier — a hold, not a strike. */
  function isContinuation(note) {
    return note?.tie === "end" || note?.tie === "both";
  }

  /**
   * MIDI values that appear more than once as a fresh strike in this event, in
   * order of first appearance. Empty array means the event is clean.
   *
   * This is THE predicate. Everything else in this module and every caller in
   * the three write paths is phrased in terms of it.
   */
  function duplicatePitches(notes) {
    if (!Array.isArray(notes) || notes.length < 2) return [];

    const freshPerMidi = new Map();
    for (const n of notes) {
      if (!n || typeof n.midi !== "number") continue;
      if (isContinuation(n)) continue;
      freshPerMidi.set(n.midi, (freshPerMidi.get(n.midi) || 0) + 1);
    }

    const out = [];
    for (const [midi, count] of freshPerMidi) {
      if (count > 1) out.push(midi);
    }
    return out;
  }

  function sameValue(a, b) {
    if (a === b) return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
      return false;
    }
    return JSON.stringify(a) === JSON.stringify(b);
  }

  // Fold `src` into `target` in place. A property present on one entry and absent
  // on the other is carried across; the same property with two different values
  // is a genuine conflict — keep the first, report it, continue. Never throws: an
  // import that hits a conflict is still worth having.
  function unionNoteInto(target, src, warn) {
    for (const k of Object.keys(src)) {
      const v = src[k];
      if (v === undefined) continue;
      if (target[k] === undefined) {
        target[k] = v;
        continue;
      }
      if (sameValue(target[k], v)) continue;
      if (!warn) continue;
      // `midi` is the merge key and can never land here. `name` gets its own
      // wording because the expected cause is a real enharmonic disagreement
      // (A#4 vs Bb4), not a parser bug.
      if (k === "name") {
        warn(
          `midi ${target.midi}: duplicate entries disagree on spelling ` +
          `("${target[k]}" vs "${v}") — kept "${target[k]}"`
        );
      } else {
        warn(
          `midi ${target.midi} (${target.name}): duplicate entries disagree on ` +
          `"${k}" (${JSON.stringify(target[k])} vs ${JSON.stringify(v)}) — ` +
          `kept ${JSON.stringify(target[k])}`
        );
      }
    }
  }

  /**
   * Collapse duplicate pitches in one event's notes array (the M1 parse-time
   * fix). Keyed on `midi` alone — whole-object comparison would miss the
   * reference case, where two F4 entries differ by a tie. Continuations are
   * never merged and never merged into.
   *
   * `warn` is optional and receives a single formatted message. Only conflicts
   * are reported; a clean merge is the fix working, and reporting every one
   * would flood the import gate on a piece like the Moonlight Sonata.
   *
   * Returns the original array (same reference) when nothing merged, so callers
   * and tests can tell "left alone" from "rewritten".
   *
   * Because a merged pair can never contain "end" or "both", the union of their
   * tie values is always "start" or absent. There is deliberately no "both"
   * branch — it is unreachable on this path.
   */
  function mergeDuplicatePitches(notes, warn) {
    if (!notes || notes.length < 2) return notes || [];

    const duplicated = new Set(duplicatePitches(notes));
    if (duplicated.size === 0) return notes;

    const out = [];
    const foldedAt = new Map();
    for (const n of notes) {
      if (!duplicated.has(n.midi) || isContinuation(n)) {
        out.push(n);
        continue;
      }
      const at = foldedAt.get(n.midi);
      if (at === undefined) {
        foldedAt.set(n.midi, out.length);
        out.push({ ...n });
        continue;
      }
      unionNoteInto(out[at], n, warn);
    }
    return out;
  }

  /**
   * The sentence, worded identically wherever the rule is enforced. The three
   * write paths address events differently, but what they say about them is
   * shared.
   */
  function duplicatePitchMessage(notes, midi) {
    const named = (notes || []).find((n) => n && n.midi === midi && n.name);
    const label = named ? `${named.name} (midi ${midi})` : `midi ${midi}`;
    return (
      `duplicate pitch ${label} — two notes in one event must not share a ` +
      `pitch unless one is a tie continuation.`
    );
  }

  /** The sentence, prefixed with whatever the caller uses to name the event. */
  function formatDuplicatePitchError(location, notes, midi) {
    return `${location}: ${duplicatePitchMessage(notes, midi)}`;
  }

  /** Error lines for one event, or [] when it is clean. */
  function duplicatePitchErrors(notes, location) {
    return duplicatePitches(notes).map((midi) =>
      formatDuplicatePitchError(location, notes, midi)
    );
  }

  /**
   * Scan a whole measures[] array. Used by the paths that do not already walk
   * every event themselves. `measure ${n}` numbering matches the wording the
   * app's other validators use (1-based position, not `m.number`, so the message
   * points at the document the human is looking at).
   */
  function scanMeasuresForDuplicatePitches(measures) {
    const errors = [];
    const list = Array.isArray(measures) ? measures : [];
    for (let mi = 0; mi < list.length; mi++) {
      for (const hand of ["rh", "lh"]) {
        const events = list[mi]?.[hand] || [];
        for (let ei = 0; ei < events.length; ei++) {
          errors.push(
            ...duplicatePitchErrors(events[ei]?.notes, `measure ${mi + 1} ${hand}[${ei}]`)
          );
        }
      }
    }
    return errors;
  }

  // ---------------------------------------------------------------------------
  // Schema layer.
  //
  // JSON Schema draft-07 cannot express "no two items of this array share a
  // property value" — there is no way to compare sibling items, and `uniqueItems`
  // does not help because the two entries are genuinely different objects (in the
  // reference case they differ by a tie). So the rule rides in the schema
  // document as a custom Ajv keyword instead of a plain constraint.
  //
  // This is the SECOND layer. The primary guarantee is the explicit predicate
  // call in each of the three write paths; the keyword is what makes any other
  // Ajv-based validation of a SAM document reject a duplicate too. A validator
  // that does not know the keyword ignores it (both current Ajv instances run
  // `strict: false`), so the schema still degrades safely rather than erroring
  // on an unrecognised word.
  // ---------------------------------------------------------------------------

  const DUPLICATE_PITCH_KEYWORD = "noDuplicatePitches";

  /** Teach an Ajv instance the keyword. Call before compiling the schema. */
  function registerDuplicatePitchKeyword(ajv) {
    ajv.addKeyword({
      keyword: DUPLICATE_PITCH_KEYWORD,
      type: "array",
      schemaType: "boolean",
      errors: true,
      validate: function check(schemaValue, data) {
        if (schemaValue !== true) return true;
        const dupes = duplicatePitches(data);
        if (dupes.length === 0) return true;
        check.errors = dupes.map((midi) => ({
          keyword: DUPLICATE_PITCH_KEYWORD,
          message: duplicatePitchMessage(data, midi),
          params: {},   // the midi is already named in the message
        }));
        return false;
      },
    });
  }
  // ==== END INLINED noteDuplicates.js ====

  // -------------------------------------------------------------------------
  // Planning — pure. No network, no globals. Exposed as __samPlanSong so the
  // Jest suite can exercise it against hand-built rows.
  // -------------------------------------------------------------------------

  /**
   * Work out what repairing one song would do.
   *
   * @param song        {id, title}
   * @param measureRows sam_song_measures rows: {id, number, rh, lh}
   * @param fingerings  sam_song_fingerings rows for this song
   * @param lyrics      sam_song_lyrics rows for this song
   * @returns {songId, title, findings, updates, blockers, dangling, lyricsOnAffected}
   *
   * `blockers` non-empty means the song must be skipped entirely.
   */
  function planSong(song, measureRows, fingerings, lyrics) {
    const findings = [];
    const updates = [];
    const blockers = [];
    const dangling = [];
    let lyricsOnAffected = 0;

    // Fingerings and lyrics both address the RIGHT hand only, by
    // (measure_num, rh_index) — see the column comments on both tables.
    const fingeringsAt = new Map();
    for (const f of fingerings || []) {
      const key = `${f.measure_num}:${f.rh_index}`;
      if (!fingeringsAt.has(key)) fingeringsAt.set(key, []);
      fingeringsAt.get(key).push(f);
    }
    const lyricsAt = new Map();
    for (const l of lyrics || []) {
      if (l.measure_num == null || l.rh_index == null) continue; // unplaced
      const key = `${l.measure_num}:${l.rh_index}`;
      if (!lyricsAt.has(key)) lyricsAt.set(key, []);
      lyricsAt.get(key).push(l);
    }

    for (const row of measureRows || []) {
      const patch = {};

      for (const hand of ["rh", "lh"]) {
        const events = Array.isArray(row[hand]) ? row[hand] : [];
        let handChanged = false;

        const newEvents = events.map((evt, ei) => {
          const notes = (evt && evt.notes) || [];
          const dupes = duplicatePitches(notes);
          if (dupes.length === 0) return evt;

          for (const midi of dupes) {
            const sample = notes.find((n) => n && n.midi === midi);
            findings.push({
              measureNumber: row.number,
              hand,
              eventIndex: ei,
              midi,
              name: (sample && sample.name) || null,
              copies: notes.filter((n) => n && n.midi === midi).length,
            });
          }

          const merged = mergeDuplicatePitches(notes);
          handChanged = true;

          if (hand === "rh") {
            const key = `${row.number}:${ei}`;

            // A stored note_index is invalidated iff it stops addressing the
            // pitch it addressed before. That is the whole test — it does not
            // matter which position was removed.
            for (const f of fingeringsAt.get(key) || []) {
              const before = notes[f.note_index];
              if (!before) {
                // Already pointing past the end of the event. Pre-existing
                // damage; report it, but do not blame this repair for it.
                dangling.push({
                  id: f.id,
                  measureNumber: row.number,
                  rhIndex: ei,
                  noteIndex: f.note_index,
                  finger: f.finger,
                  source: f.source,
                  eventSize: notes.length,
                });
                continue;
              }
              const after = merged[f.note_index];
              if (!after || after.midi !== before.midi) {
                blockers.push({
                  kind: "fingering",
                  id: f.id,
                  measureNumber: row.number,
                  rhIndex: ei,
                  noteIndex: f.note_index,
                  finger: f.finger,
                  source: f.source,
                  wasMidi: before.midi,
                  wasName: before.name || null,
                  nowMidi: after ? after.midi : null,
                  nowName: after ? after.name || null : null,
                });
              }
            }

            lyricsOnAffected += (lyricsAt.get(key) || []).length;
          }

          return Object.assign({}, evt, { notes: merged });
        });

        // Lyrics address an EVENT, not a notehead, so merging inside an event
        // cannot move them — the event count is what their rh_index depends on.
        // Asserted rather than assumed: if a merge ever dropped an event, every
        // lyric and fingering after it in the measure would silently shift.
        if (newEvents.length !== events.length) {
          blockers.push({
            kind: "event-count",
            measureNumber: row.number,
            hand,
            was: events.length,
            now: newEvents.length,
          });
        }

        if (handChanged) patch[hand] = newEvents;
      }

      if (patch.rh || patch.lh) {
        updates.push(Object.assign({ id: row.id, number: row.number }, patch));
      }
    }

    return {
      songId: song.id,
      title: song.title,
      findings,
      updates,
      blockers,
      dangling,
      lyricsOnAffected,
    };
  }

  window.__samPlanSong = planSong;

  // -------------------------------------------------------------------------
  // PostgREST access
  // -------------------------------------------------------------------------

  function accessToken() {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!/^sb-.*-auth-token$/.test(k)) continue;
      try {
        const v = JSON.parse(localStorage.getItem(k));
        const tok = v?.access_token || v?.currentSession?.access_token;
        if (tok) return tok;
      } catch (_) {}
    }
    throw new Error(
      "No Supabase session in localStorage. Sign in to SAM on this origin first."
    );
  }

  function headers(extra) {
    return Object.assign(
      { apikey: ANON_KEY, Authorization: `Bearer ${accessToken()}` },
      extra || {}
    );
  }

  async function q(pathAndQuery) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      headers: headers(),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.json();
  }

  // PostgREST caps a response at 1000 rows by default, and a song can have
  // hundreds of measures. Page explicitly rather than silently reading a
  // truncated corpus and reporting it as the whole database.
  const PAGE = 500;
  async function qAll(pathAndQuery) {
    const out = [];
    for (let offset = 0; ; offset += PAGE) {
      const sep = pathAndQuery.includes("?") ? "&" : "?";
      const page = await q(`${pathAndQuery}${sep}limit=${PAGE}&offset=${offset}`);
      out.push(...page);
      if (page.length < PAGE) return out;
    }
  }

  async function patch(pathAndQuery, body) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${pathAndQuery}`, {
      method: "PATCH",
      headers: headers({
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      }),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  }

  // -------------------------------------------------------------------------
  // Reporting
  // -------------------------------------------------------------------------

  const BOLD = "font-weight:bold";
  const RED = "color:#c00;font-weight:bold";
  const GREEN = "color:#0a0;font-weight:bold";
  const AMBER = "color:#b70;font-weight:bold";

  function reportSong(plan) {
    if (plan.findings.length === 0 && plan.dangling.length === 0) return;

    console.log(`\n%c${plan.title}%c  ${plan.songId}`, BOLD, "color:#888");

    if (plan.findings.length > 0) {
      console.log(
        `  ${plan.findings.length} duplicate(s) across ${plan.updates.length} measure row(s):`
      );
      console.table(
        plan.findings.map((f) => ({
          measure: f.measureNumber,
          hand: f.hand,
          event: f.eventIndex,
          pitch: f.name || `midi ${f.midi}`,
          midi: f.midi,
          copies: f.copies,
        }))
      );
    }

    if (plan.dangling.length > 0) {
      console.log(
        `%c  ${plan.dangling.length} fingering row(s) already point past the end of their event%c ` +
          `(pre-existing, not caused by this repair):`,
        AMBER,
        ""
      );
      for (const d of plan.dangling) {
        console.log(
          `    m${d.measureNumber} rh[${d.rhIndex}] note_index ${d.noteIndex} ` +
            `but the event has ${d.eventSize} note(s) — finger ${d.finger} (${d.source}), id ${d.id}`
        );
      }
    }

    if (plan.blockers.length > 0) {
      console.log(`%c  REFUSED — repairing this song would invalidate stored indices:%c`, RED, "");
      for (const b of plan.blockers) {
        if (b.kind === "fingering") {
          console.log(
            `    sam_song_fingerings ${b.id}: m${b.measureNumber} rh[${b.rhIndex}] ` +
              `note_index ${b.noteIndex} (finger ${b.finger}, ${b.source}) addresses ` +
              `${b.wasName || b.wasMidi}, would become ${b.nowName || b.nowMidi || "out of range"}`
          );
        } else {
          console.log(
            `    m${b.measureNumber} ${b.hand}: event count would change ${b.was} → ${b.now} ` +
              `— every lyric and fingering after it would shift`
          );
        }
      }
      console.log(`    Nothing was changed for this song. Fix or remove those rows first.`);
    } else if (plan.lyricsOnAffected > 0) {
      console.log(
        `  ${plan.lyricsOnAffected} lyric syllable(s) sit on affected events. ` +
          `Not invalidated — a syllable addresses the event, not the notehead, ` +
          `and the event count is unchanged.`
      );
    }
  }

  // -------------------------------------------------------------------------
  // Entry point
  // -------------------------------------------------------------------------

  window.samRepairDuplicates = async function samRepairDuplicates(opts = {}) {
    const apply = opts.apply === true;
    const onlySong = opts.songId || null;

    if (apply && !onlySong && opts.all !== true) {
      console.log(
        `%cRefused.%c { apply: true } needs a songId. Run the dry run first, read the\n` +
          `report, then apply one song at a time:\n` +
          `  await samRepairDuplicates({ songId: "<id>", apply: true })\n` +
          `If you really do want every repairable song in one pass, say so explicitly:\n` +
          `  await samRepairDuplicates({ apply: true, all: true })`,
        RED,
        ""
      );
      return { applied: false, reason: "apply-needs-song-id" };
    }

    console.log(
      apply
        ? `%cAPPLY%c — writing to ${onlySong ? "one song" : "every repairable song"}.`
        : `%cDRY RUN%c — nothing will be written.`,
      apply ? AMBER : GREEN,
      ""
    );

    const songFilter = onlySong
      ? `sam_songs?id=eq.${onlySong}&select=id,title,archived`
      : `sam_songs?archived=eq.false&select=id,title,archived&order=title`;
    const songs = await qAll(songFilter);
    if (songs.length === 0) {
      console.log("No songs matched.");
      return { songs: 0 };
    }
    if (onlySong && songs[0].archived) {
      console.log(`%cNote%c "${songs[0].title}" is archived.`, AMBER, "");
    }

    const plans = [];
    for (const song of songs) {
      const [measures, fingerings, lyrics] = await Promise.all([
        qAll(`sam_song_measures?song_id=eq.${song.id}&select=id,number,rh,lh&order=number`),
        qAll(`sam_song_fingerings?song_id=eq.${song.id}&select=id,measure_num,rh_index,note_index,finger,source`),
        qAll(`sam_song_lyrics?song_id=eq.${song.id}&select=id,word_order,syllable,measure_num,rh_index`),
      ]);
      const plan = planSong(song, measures, fingerings, lyrics);
      plans.push(plan);
      reportSong(plan);
    }

    const affected = plans.filter((p) => p.findings.length > 0);
    const refused = affected.filter((p) => p.blockers.length > 0);
    const repairable = affected.filter((p) => p.blockers.length === 0);
    const totalDupes = affected.reduce((n, p) => n + p.findings.length, 0);

    console.log(
      `\n%cScanned ${songs.length} song(s).%c ` +
        `${affected.length} affected, ${totalDupes} duplicate(s) total. ` +
        `${repairable.length} repairable, ${refused.length} refused.`,
      BOLD,
      ""
    );

    if (!apply) {
      if (repairable.length > 0) {
        console.log(
          `Dry run — nothing written. To repair one:\n` +
            repairable
              .slice(0, 10)
              .map((p) => `  await samRepairDuplicates({ songId: "${p.songId}", apply: true })   // ${p.title}`)
              .join("\n")
        );
      }
      return { dryRun: true, scanned: songs.length, affected: affected.length, totalDupes, refused: refused.length };
    }

    // --- apply ---------------------------------------------------------------
    if (refused.length > 0) {
      console.log(
        `%c${refused.length} song(s) refused and skipped%c — see above.`,
        RED,
        ""
      );
    }
    if (repairable.length === 0) {
      console.log("Nothing to do — no repairable duplicates in scope.");
      return { applied: false, reason: "nothing-to-repair", refused: refused.length };
    }

    const results = [];
    for (const plan of repairable) {
      console.log(`\n%cRepairing "${plan.title}"%c ${plan.songId}`, BOLD, "color:#888");

      for (const u of plan.updates) {
        const body = {};
        if (u.rh) body.rh = u.rh;
        if (u.lh) body.lh = u.lh;
        await patch(`sam_song_measures?id=eq.${u.id}`, body);
        console.log(`  wrote measure ${u.number}`);
      }
      console.log(`%c  ${plan.updates.length} measure row(s) written.%c`, GREEN, "");

      // Invalidate the compiled blob LAST, and be loud if it fails: the measure
      // rows are already repaired at this point, and the app serves the compiled
      // copy. Without this the repair looks like it did nothing.
      const result = {
        songId: plan.songId,
        title: plan.title,
        measures: plan.updates.length,
        duplicates: plan.findings.length,
        blobInvalidated: false,
      };
      try {
        await patch(`sam_songs?id=eq.${plan.songId}`, {
          measures_edited_at: new Date().toISOString(),
          measures_compiled_at: null,
        });
        result.blobInvalidated = true;
        console.log(
          `%c  compiled blob invalidated%c — measures_compiled_at = null, the app rebuilds on next open.`,
          GREEN,
          ""
        );
      } catch (e) {
        result.error = e.message;
        console.log(
          `%c  MEASURE ROWS WERE WRITTEN BUT THE BLOB WAS NOT INVALIDATED:%c ${e.message}\n` +
            `  The app will keep serving the stale compiled copy and the repair will look\n` +
            `  like it did nothing. Re-run this song to finish the job:\n` +
            `    await samRepairDuplicates({ songId: "${plan.songId}", apply: true })`,
          RED,
          ""
        );
      }
      results.push(result);
    }

    const incomplete = results.filter((r) => !r.blobInvalidated);
    console.log(
      `\n%cDone.%c ${results.length} song(s) repaired, ` +
        `${results.reduce((n, r) => n + r.duplicates, 0)} duplicate(s) merged.` +
        (refused.length > 0 ? ` ${refused.length} refused.` : "") +
        (incomplete.length > 0
          ? ` ${incomplete.length} still serving a stale blob — see above.`
          : "") +
        `\nReopen the repaired songs and check the affected measures.`,
      GREEN,
      ""
    );
    return { applied: true, repaired: results, refused: refused.length };
  };

  console.log(
    "samRepairDuplicates loaded.\n" +
      "  await samRepairDuplicates()                                  → dry run, every non-archived song\n" +
      '  await samRepairDuplicates({ songId: "<id>" })                → dry run, one song\n' +
      '  await samRepairDuplicates({ songId: "<id>", apply: true })   → repair that one song\n' +
      '  await samRepairDuplicates({ apply: true, all: true })        → repair every repairable song'
  );
})();
