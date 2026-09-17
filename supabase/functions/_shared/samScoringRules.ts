// The SAM scoring definitions, in the one form every tool description repeats.
// Full prose: docs/sam-scoring-definitions.md. The same statements are comments
// on sam_session_events and its columns (migrations 029 and 030), so a reader
// who sees only the schema, or only a tool, still gets them.
//
// No imports, no database: a string constant, so any tool file can carry it.

export const SAM_SCORING_RULES =
  "SCORING DEFINITIONS (docs/sam-scoring-definitions.md — do not guess at these): " +
  "(1) ACCURACY IS hits / (hits + misses). A `partial` (some but not all of a beat's notes) counts as " +
  "NEITHER, sits outside the ratio and is reported separately; an `extra` counts as nothing at all. " +
  "Accuracy is NULL, never 0, when nothing was measured — null means unmeasurable, 0 means measured and " +
  "every note wrong, and null must never be averaged as 0. " +
  "(2) RESULT VALUES: `hit` (every expected note played in time), `miss` (the beat was not played correctly — " +
  "either nothing was struck at it, raised on elapsed time without consulting MIDI so a session with no " +
  "keyboard records a full count of misses, or what was struck was wrong, in which case played_notes carries " +
  "those keys), `partial`, and `extra` (a keystroke that was NOT AN ATTEMPT AT ANY BEAT — it matched nothing " +
  "within the window: SCORELESS, and the answer to \"what am I hitting instead\"). `wrong` is permitted by " +
  "the constraint but has never been written. " +
  "(2b) ONE FUMBLE IS ONE ROW: a wrong attempt AT a beat lives on that beat's miss row (its pitches are not " +
  "counted toward notesPlayed); only an unattached keystroke is an extra. A count of wrong notes should read " +
  "extra rows AND the played_notes of miss rows, and will not double-count one attempt. " +
  "(3) A WRONG KEY STRUCK AND CORRECTED WITHIN THE WINDOW STILL SCORES AS A HIT. That is deliberate — the " +
  "score measures whether the passage was played, and punishing a recovered slip makes it less useful. What " +
  "was struck is still recorded, and changes no score. " +
  "(4) TIMING: POSITIVE = EARLY (rushing), NEGATIVE = LATE (dragging). On an EXTRA row it is the offset to " +
  "the nearest pending beat and is NULL when that beat is further than twice the window — an unattached " +
  "keystroke is neither early nor late (extras from before 2026-09-18 stored it regardless: noise). The " +
  "magnitude is truncated by the " +
  "session's matching window (settings.windowMs, default 300 ms) — anything further out matched no beat and " +
  "was never recorded, so extremes are invisible and the mean is pulled toward zero — and any fixed MIDI or " +
  "audio latency rides along as a constant offset. Comparisons WITHIN one session are far more reliable " +
  "than absolute values. " +
  "(5) ⚠️ THE WINDOW DECIDES HOW FORGIVING SCORING IS, and the same passage practised at different window " +
  "settings is NOT COMPARABLE: tightening the window lowers accuracy on identical playing, and reading that " +
  "as getting worse is a mistake. Always state the window behind a figure. " +
  "(6) DATES: events from 2026-02-14; `partial` rows from 2026-09-18 (plus earlier ones recovered by the " +
  "backfill); `extra` rows from 2026-09-18 only; sam_passes hits/misses/notes_played/accuracy_percent and " +
  "playback_speed/effective_bpm from 2026-09-16 part-way through the day. 285 ended sessions have no event " +
  "rows and never will (tab closed mid-practice). " +
  "(7) MEASURE NUMBERS ARE PLAYED NUMBERS (repeats written out); the printed number is " +
  "sam_song_measures.source_measure and differs wherever a bar repeats.";
