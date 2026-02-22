# Sam — Data Model Specification

## Overview

Three levels of data: **Song**, **Snippets**, and **Practice Sessions**.
Practice sessions log every note event at the individual note level,
enabling detailed analysis of timing, accuracy, and progress over time.

---

## 1. Song

A song is the top-level container. It holds the full notation and metadata.

### Measure Format (preferred): Independent Voices

Each measure has `lh` and `rh` as separate voice arrays. Each voice event is one tickable (note, chord, or rest) with its own duration. Voices are independent — LH can have a whole note while RH has 8 eighth notes. Durations within each voice must sum to 4 beats (in 4/4 time).

```json
{
  "id": "song_001",
  "title": "Someone Like You",
  "artist": "Adele",
  "source": "manual",
  "key": "A major",
  "timeSignature": "4/4",
  "defaultBpm": 68,
  "createdAt": "2026-02-11T14:00:00Z",
  "updatedAt": "2026-02-11T14:00:00Z",

  "measures": [
    {
      "number": 1,
      "lh": [
        {
          "duration": "w",
          "notes": [
            { "midi": 45, "name": "A2", "tie": "start" },
            { "midi": 50, "name": "D3", "tie": "start" }
          ]
        }
      ],
      "rh": [
        { "duration": "8", "notes": [{ "midi": 69, "name": "A4" }] },
        { "duration": "8", "notes": [{ "midi": 73, "name": "C#5" }] },
        { "duration": "8", "notes": [{ "midi": 76, "name": "E5" }] },
        { "duration": "8", "notes": [{ "midi": 73, "name": "C#5" }] },
        { "duration": "8", "notes": [{ "midi": 69, "name": "A4" }] },
        { "duration": "8", "notes": [{ "midi": 73, "name": "C#5" }] },
        { "duration": "8", "notes": [{ "midi": 76, "name": "E5" }] },
        { "duration": "8", "notes": [{ "midi": 73, "name": "C#5" }] }
      ]
    }
  ]
}
```

### Voice event structure:
- `duration` — `"w"`, `"h"`, `"q"`, `"8"`, `"16"` (required)
- `notes[]` — array of simultaneous notes (chord). Empty array or omitted = rest.
- Each note: `midi` (number), `name` (human readable, e.g. "C#5")
- Optional per-note: `tie` — `"start"`, `"end"`, or `"both"` for tied notes across measures

### Legacy Format: Shared Beats Array

The older format uses `beats[]` where LH and RH share the same beat grid. This works for music where both hands play on the same rhythmic positions (e.g., block chords). The player accepts both formats.

```json
{
  "number": 1,
  "beats": [
    {
      "beat": 1,
      "duration": "q",
      "lh": [{ "midi": 57, "name": "A3", "duration": "q" }],
      "rh": [
        { "midi": 69, "name": "A4", "duration": "q" },
        { "midi": 73, "name": "C#5", "duration": "q" },
        { "midi": 76, "name": "E5", "duration": "q" }
      ]
    }
  ]
}
```

### Notes on Song structure:
- `measures` is an ordered array — measure.number is the display number
- **Voice format (preferred):** each measure has `lh[]` and `rh[]` as independent voice arrays
- **Legacy format:** each measure has `beats[]` with shared LH/RH per beat position
- Duration values: `"w"` (whole=4 beats), `"h"` (half=2), `"q"` (quarter=1), `"8"` (eighth=0.5), `"16"` (sixteenth=0.25)
- Each voice's durations must sum to 4 beats in 4/4 time
- Rests: voice events with empty `notes[]`, or implicit (the player pads with rests if a voice is short)
- Ties: set `"tie": "start"` on last note of measure, `"tie": "end"` on first note of next measure
- Multiple notes in a voice event = chord (stacked noteheads)

---

## 2. Snippet

A snippet is a saved sub-region of a song, with its own practice settings.

```json
{
  "id": "snip_001",
  "songId": "song_001",
  "title": "D to E transition",
  "startMeasure": 17,
  "endMeasure": 18,
  "restMeasures": 0,
  "createdAt": "2026-02-11T15:00:00Z",
  "updatedAt": "2026-02-11T15:00:00Z",

  "settings": {
    "bpm": 45,
    "timingWindowMs": 120,
    "chordGroupMs": 80,
    "targetLinePosition": 0.15
  },

  "tags": ["transition", "difficult", "left-hand"],
  "notes": "Keep thumb on D, stretch pinky to E. Don't lift wrist."
}
```

### Notes on Snippets:
- `startMeasure` / `endMeasure` reference song measure numbers
- `restMeasures` defines how many empty measures to insert before looping
- `settings` are per-snippet overrides (each snippet can have its own BPM etc.)
- `tags` and `notes` are for the user's own organization
- The actual note data comes from the song — the snippet just references a range
- Snippets can overlap (multiple snippets covering the same measures at different tempos)

---

## 3. Practice Session

A practice session is a single sitting. It logs every attempt at every note.

```json
{
  "id": "session_001",
  "songId": "song_001",
  "snippetId": "snip_001",
  "startedAt": "2026-02-11T15:30:00Z",
  "endedAt": "2026-02-11T15:45:00Z",
  "durationSeconds": 900,

  "settings": {
    "bpm": 45,
    "timingWindowMs": 120,
    "chordGroupMs": 80
  },

  "summary": {
    "totalBeats": 120,
    "hits": 98,
    "misses": 14,
    "partials": 8,
    "accuracyPercent": 81.7,
    "avgTimingDeltaMs": 22,
    "loopCount": 15
  },

  "events": [
    {
      "loopIteration": 1,
      "measure": 17,
      "beat": 1,
      "hand": "both",
      "expectedNotes": [50, 62, 66, 69],
      "playedNotes": [50, 62, 66, 69],
      "result": "hit",
      "timingDeltaMs": -8,
      "expectedTimeMs": 0,
      "actualTimeMs": -8,
      "velocity": [72, 68, 65, 70]
    },
    {
      "loopIteration": 1,
      "measure": 17,
      "beat": 2,
      "hand": "both",
      "expectedNotes": [50, 62, 66, 69],
      "playedNotes": [50, 62, 69],
      "result": "partial",
      "missingNotes": [66],
      "extraNotes": [],
      "timingDeltaMs": 15,
      "expectedTimeMs": 1333,
      "actualTimeMs": 1348,
      "velocity": [70, 64, 67]
    },
    {
      "loopIteration": 1,
      "measure": 17,
      "beat": 3,
      "hand": "both",
      "expectedNotes": [52, 64, 68, 71],
      "playedNotes": [],
      "result": "miss",
      "timingDeltaMs": null,
      "expectedTimeMs": 2666,
      "actualTimeMs": null,
      "velocity": []
    },
    {
      "loopIteration": 1,
      "measure": 18,
      "beat": 1,
      "hand": "both",
      "expectedNotes": [52, 64, 68, 71],
      "playedNotes": [52, 64, 67, 71],
      "result": "wrong_note",
      "wrongNotes": [67],
      "expectedWrong": [68],
      "timingDeltaMs": 45,
      "expectedTimeMs": 5333,
      "actualTimeMs": 5378,
      "velocity": [74, 60, 55, 68]
    }
  ]
}
```

### Notes on Practice Session events:
- Every beat the user was supposed to play gets an event entry
- `loopIteration` tracks which pass through the loop (1st time, 2nd time, etc.)
- `measure` and `beat` reference the song position — enables cross-session analysis
- `expectedNotes` vs `playedNotes` — exact MIDI numbers for full comparison
- `result` is one of: "hit", "miss", "partial", "wrong_note"
- `missingNotes` — notes that were expected but not played
- `extraNotes` — notes played that weren't expected
- `wrongNotes` / `expectedWrong` — when the right number of notes were played but wrong pitches
- `timingDeltaMs` — negative = early, positive = late, null = not played
- `expectedTimeMs` — milliseconds from session start when note should have been played
- `actualTimeMs` — when it was actually played
- `velocity` — array matching playedNotes order, useful for dynamics analysis

---

## 4. Analysis Queries This Data Supports

With this structure, these analyses become simple queries:

### "You're consistently late on measure 17, beat 3"
```
Filter events where measure=17, beat=3
Across all sessions for this snippet
Average timingDeltaMs → if consistently positive, you're late
```

### "Your accuracy on the D-E transition improves over time"
```
Group sessions by date for snippet "D to E transition"
Plot summary.accuracyPercent over time
```

### "Measure 20: you keep missing the F# in the right hand"
```
Filter events where measure=20, result in (partial, wrong_note)
Count occurrences of MIDI 66 in missingNotes or expectedWrong
```

### "Your left hand is consistently ahead of your right"
```
Requires future enhancement: log LH and RH timing separately
Add fields: lhTimingDeltaMs, rhTimingDeltaMs
Compare averages
```

### "At 45 BPM you're 95% accurate, at 60 BPM you drop to 70%"
```
Group sessions by settings.bpm
Compare summary.accuracyPercent
Find the tempo ceiling
```

### "You practice this snippet most on Tuesdays"
```
Group sessions by day of week
Count/sum durationSeconds
```

### "Velocity analysis: you're hammering beat 1 and ghosting beat 3"
```
Group events by beat position
Average velocity values
Compare across beats
```

---

## 5. Storage Strategy

### For MVP / Local:
- Store everything as JSON in localStorage or IndexedDB
- One key per song, one key per snippet index, one key per session
- Sessions can get large — consider storing only the current session in memory
  and flushing to IndexedDB on pause/stop

### For Future / Cloud:
- Songs and Snippets → small, sync easily
- Practice Sessions → can be large (900 events in a 15-min session)
- Consider: store full events locally, sync only summaries to cloud
- Full event data available for Claude analysis when user uploads/shares

### Key naming convention for IndexedDB:
```
songs:{songId}              → song data
snippets:{songId}           → array of snippets for a song
sessions:{snippetId}:{date} → session data
sessions:{songId}:{date}    → full-song session data
```

---

## 6. Export Format for Claude Analysis

When the user wants me to analyze their practice, they export a JSON file:

```json
{
  "exportedAt": "2026-02-11T16:00:00Z",
  "song": { ... },
  "snippet": { ... },
  "sessions": [ ... ]
}
```

This gives me everything: what the music is, what region they're practicing,
and every note event across all sessions. I can then provide specific,
measure-level, note-level feedback.

---

## 7. Future Fields (not needed for MVP, but reserve space)

- `fingering`: array per note (1-5 for each finger)
- `pedalEvents`: sustain pedal on/off timestamps
- `dynamicMarking`: pp, p, mp, mf, f, ff per beat
- `articulationExpected`: staccato, legato, accent
- `metronomeActive`: boolean per session
- `videoTimestamp`: sync practice data to a video recording
