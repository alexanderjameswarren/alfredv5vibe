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
  "(2) RESULT VALUES: `hit` (every expected note played in time), `miss` (the beat passed unplayed — " +
  "raised on elapsed time without consulting MIDI, so a session with no keyboard records a full count of " +
  "misses), `partial`, and `extra` (a keystroke matching no beat: a wrong key, or one too far from its " +
  "beat — SCORELESS, and the answer to \"what am I hitting instead\"). `wrong` is permitted by the " +
  "constraint but has never been written. " +
  "(3) A WRONG KEY STRUCK AND CORRECTED WITHIN THE WINDOW STILL SCORES AS A HIT. That is deliberate — the " +
  "score measures whether the passage was played, and punishing a recovered slip makes it less useful. The " +
  "stray key is kept as its own `extra` row and changes no score. " +
  "(4) TIMING: POSITIVE = EARLY (rushing), NEGATIVE = LATE (dragging). The magnitude is truncated by the " +
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
