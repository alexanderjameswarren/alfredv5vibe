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
  "(1a) ⚠️⚠️ ACCURACY CHANGED ON 2026-09-20 AND IS NOT COMPARABLE ACROSS THAT DATE ON ANY PIECE CONTAINING " +
  "TIES. Until then the app asked the player to STRIKE notes that were already sounding: it decided a beat's " +
  "expected notes with `notes.every(n => n.tie === \"end\")` per EVENT, which treated a middle link of a tie " +
  "chain (tie \"both\") as freshly struck, and treated a mixed chord — one voice tied over, another " +
  "re-articulated — as entirely struck. Correctly playing nothing at a held beat scored a MISS; correctly " +
  "playing only the re-articulated note of a mixed chord scored a PARTIAL. Both are fixed: a note is expected " +
  "only when freshly struck, judged per note. EXPECT ACCURACY TO RISE ON PIECES WITH TIES FROM 2026-09-20, AND " +
  "ATTEMPTS TO FALL, because beats that ask for no key at all leave the ratio. THAT RISE IS THE SCORING BEING " +
  "CORRECTED, NOT THE PLAYING IMPROVING — do not report it as progress, and do not compare or average accuracy " +
  "across the boundary on a piece with ties. Rows written before that date keep the old expected_notes. " +
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
  "(4a) ⚠️⚠️ TIMING CALIBRATION CHANGED ON 2026-09-19 AND OFFSETS ACROSS THAT DATE ARE NOT COMPARABLE. " +
  "Until then a chord's offset was measured when the chord-grouping timer FLUSHED, ~80 ms after the last key " +
  "of the chord (more when the main thread was busy, worst at a loop restart), and the elapsed clock was read " +
  "once per animation frame rather than at the keystroke. Both are fixed: the press time is now captured when " +
  "the MIDI event arrives. EXPECT EVERY OFFSET FROM 2026-09-19 ONWARD TO SIT ROUGHLY 80-100 ms LESS LATE THAN " +
  "BEFORE, on identical playing. THAT JUMP IS THE MEASUREMENT CHANGING, NOT THE PLAYING IMPROVING — do not " +
  "report it as progress, and never average or compare mean offsets, entry lateness or drift across the " +
  "boundary. Interval ratio and spread are unaffected (a constant offset cancels out of a gap), so they are " +
  "the figures that remain comparable across it. " +
  "(4) TIMING: POSITIVE = EARLY (rushing), NEGATIVE = LATE (dragging). On an EXTRA row it is the offset to " +
  "the nearest pending beat and is NULL when that beat is further than twice the window — an unattached " +
  "keystroke is neither early nor late (extras from before 2026-09-18 stored it regardless: noise). The " +
  "magnitude is truncated by the " +
  "session's matching window (settings.windowMs, default 300 ms) — anything further out matched no beat and " +
  "was never recorded, so extremes are invisible and the mean is pulled toward zero — and any fixed MIDI or " +
  "audio latency rides along as a constant offset. There is also a MEASUREMENT FLOOR of about 17 ms (one " +
  "animation frame at 60 Hz), so a spread or a difference under roughly 20 ms is noise, not a finding. " +
  "Comparisons WITHIN one session are far more reliable than absolute values. " +
  "(5) ⚠️ THE WINDOW DECIDES HOW FORGIVING SCORING IS, and the same passage practised at different window " +
  "settings is NOT COMPARABLE: tightening the window lowers accuracy on identical playing, and reading that " +
  "as getting worse is a mistake. Always state the window behind a figure. " +
  "(6) DATES: events from 2026-02-14; `partial` rows from 2026-09-18 (plus earlier ones recovered by the " +
  "backfill); `extra` rows from 2026-09-18 only; sam_passes hits/misses/notes_played/accuracy_percent and " +
  "playback_speed/effective_bpm from 2026-09-16 part-way through the day. 285 ended sessions have no event " +
  "rows and never will (tab closed mid-practice). " +
  "(7) MEASURE NUMBERS ARE PLAYED NUMBERS (repeats written out); the printed number is " +
  "sam_song_measures.source_measure and differs wherever a bar repeats.";
