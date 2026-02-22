# Sam — VexFlow & MIDI Patterns Reference

## What This Is
A technical reference of validated patterns, gotchas, and working code for Sam's core systems: VexFlow notation rendering, Web MIDI input, chord matching, and side-scrolling. Every pattern in this document has been tested in working prototypes. When building Sam's React components, consult this document for implementation details — especially the gotchas section, which documents bugs and workarounds discovered through trial and error.

**Companion docs:**
- `sam-tech-spec.md` — Architecture, schema, component specs (what to build)
- `sam-build-plan.md` — Step-by-step implementation order (when to build it)
- `sam-data-model.md` — Full data model specification
- This file — Validated patterns and gotchas (how to build it)

---

## Prototype Prompt (Reference Only)

The prompt below was used to generate the original single-file HTML prototypes. It is included for context and as a fallback if components need to be rebuilt from scratch. **For the production build, follow the component architecture in sam-tech-spec.md instead.**

```
Build me a single-file HTML/JS web app with VexFlow 4.2.2 for music notation. 
Load VexFlow from CDN: https://cdn.jsdelivr.net/npm/vexflow@4.2.2/build/cjs/vexflow.js
Must be served from localhost (python -m http.server 8000), not file://.

### 1. MIDI Connection
- Use the Web MIDI API (navigator.requestMIDIAccess, sysex: false)
- Filter out virtual MIDI ports (any input name containing "midi through" or "thru")
- On success, bind onmidimessage to all real connected inputs
- Poll for new devices every 3 seconds (setInterval + rebind)
- Also listen to onstatechange for hot-plug
- Show connection status: connected (green), waiting (yellow), error (red)
- Display the connected device name
- Only process Note On messages: status byte & 0xf0 === 0x90 AND velocity > 0
- Ignore system messages: status byte >= 0xf0

### 2. Chord Input Buffering
- Don't process MIDI notes individually — buffer them into chord gestures
- When a note arrives, push it to an inputBuffer array with its midi number and timestamp
- Set/reset a setTimeout timer (default 80ms, configurable via "Chord group ms" input)
- When the timer fires, flush the buffer as one chord event
- Deduplicate: if the same MIDI note appears twice in the buffer, keep only one
- Pass the collected chord to the matching/validation function

### 3. VexFlow Grand Staff Notation
- Use VexFlow 4.2.2 (Vex.Flow) for rendering — it bundles fonts internally
- Render to SVG via VF.Renderer with Backends.SVG
- Grand staff: treble stave + bass stave with brace connector
- Notes below MIDI 60 (middle C) go to bass clef, 60+ go to treble clef
- Convert MIDI to VexFlow key format: e.g., MIDI 69 → "a/4"
- Add accidentals via VF.Accidental when needed (C#, F#, etc.)
- Color notes by state using setStyle({ fillStyle, strokeStyle })
  - Hit: green (#16a34a)
  - Miss: red (#dc2626)
  - Current (target): blue (#2563eb)
  - Upcoming/default: black (#1a1a1e)
- Group notes into measures of 4 quarter notes
- Pad incomplete measures with invisible rests (duration 'qr', transparent style)
- Use VF.Voice with num_beats:4, beat_value:4 for each measure
- Format each voice separately with VF.Formatter
- Auto-scroll container to rightmost content

### 4. Side-Scrolling Timing Display (for play mode)
- Notes/chords spawn off-screen right and scroll left toward a target line
- Target line at configurable position (default ~15% from left edge)
- Two horizontal lanes: RH (top) and LH (bottom)
- Use requestAnimationFrame for the game loop
- Support window.devicePixelRatio for crisp rendering on high-DPI screens

### 5. Timing Engine
- Notes spawn one per beat based on BPM (default 72, configurable input)
- Each note gets 8 beats of travel time from spawn to target line
- Position is calculated as linear interpolation:
    progress = (now - spawnTime) / (targetTime - spawnTime)
    x = spawnX + (targetX - spawnX) * progress
- Timing window (default 120ms, configurable input) defines hit/miss threshold
- A note is "missed" when: now > targetTime + windowMs AND state is still "pending"

### 6. Chord Matching Logic
- Each target has: label (string), lh (array of MIDI numbers), rh (array of MIDI numbers), allNotes (lh + rh combined)
- When a chord input arrives, find the closest pending target within the timing window
- Three outcomes:
  - HIT (green): played notes exactly match allNotes (order independent)
  - PARTIAL (yellow): played notes are a subset of allNotes
  - MISSED (red): target passed the window without being played
- Record hitDelta = round(now - targetTime) for display and stats

### 7. Two UI Modes
- PLAY MODE: maximally stripped down
  - Grand staff with scrolling notes
  - Target line, BPM badge, loop badge, minimal stats
  - "tap anywhere to pause" — single tap on score area pauses
  - No settings controls visible
- PAUSE MODE: everything you need
  - Settings drawer: BPM, timing window, chord grouping (+/- touch buttons)
  - Minimap: thin bar showing all measures, tappable to select
  - Collapsible snippet section: loop range, rest measures (+/- default 0), save/clear
  - Score area with "swipe to scrub" for navigation
  - Full stats bar: hits, misses, partial, accuracy, avg timing
  - Big green play button at bottom center

### 8. Chord Pool
Define chords as an array of objects:
  { label: "C", lh: [48], rh: [60, 64, 67] }   // C3 | C4+E4+G4
  { label: "G", lh: [55], rh: [59, 62, 67] }    // G3 | B3+D4+G4
Randomly pick from this pool each beat, or follow a defined sequence.

### 9. Data Model
- Song: full notation with measures, beats, per-note MIDI data for both hands
- Snippet: references a measure range in a song, with own BPM/settings and rest measures
- Practice Session: logs every note event with measure, beat, expected vs played, 
  timing delta, velocity, and loop iteration — enables note-level analysis
```

---

## MIDI Number Reference

```
Octave:  1    2    3    4    5    6
C       24   36   48   60   72   84
C#      25   37   49   61   73   85
D       26   38   50   62   74   86
D#      27   39   51   63   75   87
E       28   40   52   64   76   88
F       29   41   53   65   77   89
F#      30   42   54   66   78   90
G       31   43   55   67   79   91
G#      32   44   56   68   80   92
A       33   45   57   69   81   93
A#      34   46   58   70   82   94
B       35   47   59   71   83   95
```

Formula: `MIDI = (octave + 1) * 12 + noteIndex`
Where noteIndex: C=0, C#=1, D=2, D#=3, E=4, F=5, F#=6, G=7, G#=7, A=9, A#=10, B=11

Reverse: `octave = floor(midi / 12) - 1`, `noteIndex = midi % 12`

---

## Key Architecture Decisions

### Why buffer chords (not match note-by-note)?
A human playing a chord doesn't press all keys at the same millisecond. Notes arrive 10-60ms apart. The buffer collects them into a single gesture before comparing against the target. Without this, the first note of a chord might match one target and the second note another.

### Why poll for MIDI devices instead of relying on onstatechange?
ChromeOS (and some Linux setups) have a bug where onstatechange fires connect then immediately disconnect. Polling with setInterval is a reliable fallback. We do both.

### Why linear interpolation for scroll position?
It's simple, predictable, and frame-rate independent. The note's position is always a function of (currentTime - spawnTime) / (targetTime - spawnTime), so even if frames drop, notes stay in the right place.

### Why 8 beats of lead time?
Enough time to read ahead and prepare, without being so far away that notes are tiny. At 100 BPM, that's 4.8 seconds — comfortable for sight reading.

### Why performance.now() instead of Date.now()?
performance.now() gives sub-millisecond precision and is monotonic (won't jump due to system clock changes). Essential for timing validation.

---

## Tunable Parameters

| Parameter        | Default | Range     | Purpose                                    |
|------------------|---------|-----------|--------------------------------------------|
| BPM              | 68      | 20–300    | Speed of note spawning                     |
| Window (ms)      | 120     | 10–500    | How close to target time counts as a hit   |
| Chord group (ms) | 80      | 20–200    | Max gap between notes in same chord gesture|
| TARGET_X_RATIO   | 0.15    | 0.1–0.3   | Where the target line sits (% from left)   |
| Travel beats     | 8       | 4–16      | How many beats ahead notes appear          |
| Flash decay      | 0.015   | 0.01–0.05 | How quickly hit/miss flash fades           |

---

## Common Chord Definitions

```javascript
// Major triads (root position)
var CHORDS = {
  // label    LH bass    RH triad
  'C':  { lh: [48], rh: [60, 64, 67] },  // C3 | C4 E4 G4
  'D':  { lh: [50], rh: [62, 66, 69] },  // D3 | D4 F#4 A4
  'E':  { lh: [52], rh: [64, 68, 71] },  // E3 | E4 G#4 B4
  'F':  { lh: [53], rh: [65, 69, 72] },  // F3 | F4 A4 C5
  'G':  { lh: [55], rh: [67, 71, 74] },  // G3 | G4 B4 D5
  'A':  { lh: [57], rh: [69, 73, 76] },  // A3 | A4 C#5 E5
  'Bb': { lh: [58], rh: [70, 74, 77] },  // Bb3 | Bb4 D5 F5

  // Minor triads (root position)
  'Cm':  { lh: [48], rh: [60, 63, 67] }, // C3 | C4 Eb4 G4
  'Dm':  { lh: [50], rh: [62, 65, 69] }, // D3 | D4 F4 A4
  'Em':  { lh: [52], rh: [64, 67, 71] }, // E3 | E4 G4 B4
  'Am':  { lh: [57], rh: [69, 72, 76] }, // A3 | A4 C5 E5
};
```

---

## Gotchas & Lessons Learned

### MIDI
1. **ChromeOS USB MIDI is broken** — devices connect then instantly disconnect at the OS level. Not fixable in JS. Use Windows or macOS. Recommended hardware: Microsoft Surface Go or any Windows laptop/tablet with USB-C.

2. **"Midi Through Port-0" is a Linux virtual loopback** — always filter it out or users will think they're connected when they're not.

3. **Note On with velocity 0 means Note Off** — always check `velocity > 0` when filtering Note On messages (status 0x90).

4. **file:// may silently block MIDI permissions** — always serve from localhost (`python -m http.server 8000`).

### VexFlow
5. **Use VexFlow 4.2.2, not 5.x** — Version 5.0.0 requires separate web font loading (Bravura woff2 files via @font-face + `document.fonts.ready` promise + `VexFlow.setFonts()`). This is fragile and fails when fonts don't load. Version 4.2.2 bundles all font data internally — zero font setup needed. The API object is `Vex.Flow` (not `VexFlow`).

6. **The working CDN URL is exactly: `https://cdn.jsdelivr.net/npm/vexflow@4.2.2/build/cjs/vexflow.js`** — Version 4.2.6 does not exist. Version 4.2.5 and others may not exist either. Always verify the exact version on jsdelivr before using it. The version `4.2.2` is confirmed working.

7. **VexFlow 4.x vs 5.x API differences:**
   - 4.x: `var VF = Vex.Flow;` then `new VF.Renderer(...)`, `new VF.Stave(...)`, etc.
   - 5.x: `VexFlow.setFonts('Bravura', 'Academico');` then use `VexFlow` directly as the namespace.
   - The 4.x CJS build exposes `Vex` as a global. Check `typeof Vex !== 'undefined' && Vex.Flow`.

8. **`document.fonts.ready` can reject even when VexFlow works** — Don't gate your entire app init on font loading promises. In 4.2.2, fonts are embedded, so `document.fonts.ready` is irrelevant. Use `window.addEventListener('load', ...)` with a short `setTimeout(init, 200)` to let the script execute.

9. **Define `log()` before calling it** — When wrapping everything inside an `init()` function, make sure helper functions like `log()` are declared at the top of `init()`, before any code that calls them. JavaScript function declarations are hoisted within their scope, but if `log` is defined lower in the function than the first call site, it causes `ReferenceError` in strict evaluation paths.

10. **VexFlow note key format** — MIDI numbers must be converted to VexFlow's string format: `"c/4"`, `"f#/3"`, `"bb/5"`. The formula: take `midi % 12` to get the note name, `Math.floor(midi / 12) - 1` for the octave. Accidentals are added separately via `staveNote.addModifier(new VF.Accidental('#'))`.

11. **Invisible rests for padding** — VexFlow voices must have exactly the right number of beats. If a measure has fewer notes than beats, pad with rests: `new VF.StaveNote({ keys: ['b/4'], duration: 'qr' })` styled with transparent fill/stroke.

12. **Light theme is better for notation** — Dark backgrounds make staff lines and noteheads hard to see. Use a light gray background (#f4f4f5) with dark notation. Color states: green for hits (#16a34a), red for misses (#dc2626), blue for current/target (#2563eb), black for default (#1a1a1e).

13. **Scrolling is pure CSS transform on SVG (not Canvas)** — Render the full score as one wide VexFlow SVG, then scroll with `translateX(-offset)` driven by `requestAnimationFrame`. No Canvas needed. To loop endlessly: render 3 copies of the score, track scroll position, and when the second copy crosses the target line, teleport `originPx` forward by one copy width. The user sees no jump because the SVG content is identical.

14. **Off-screen SVG has no layout — getBBox() fails** — VexFlow's `getBoundingBox()` and SVG `getBBox()` return zeros when the SVG element is not attached to the DOM. Fix: temporarily attach the container div to the document body (positioned off-screen at `left:-9999px`) before querying bounding boxes, then remove it after. This is essential for collecting note positions for hit detection and for collecting SVG path elements for recoloring.

15. **Beaming: use `new VF.Beam(notes)` before `voice.draw()`, not `generateBeams()` after** — `VF.Beam.generateBeams()` draws beams but does NOT suppress the individual flags on eighth/sixteenth notes, resulting in double rendering (beam + flag). The fix: manually group consecutive beamable notes, create `new VF.Beam(group)` objects BEFORE calling `voice.draw()`, then call `beam.draw()` after. Creating the Beam object before draw tells VexFlow to suppress the flags.

16. **Beam grouping logic** — Walk the note array, collect runs of consecutive 8th/16th notes (skip rests, quarters, halves, etc.). Each run of 2+ beamable notes becomes one Beam. Single beamable notes keep their flag. Example helper:
    ```javascript
    function getBeamGroups(notes) {
      var groups = [], cur = [];
      for (var i = 0; i < notes.length; i++) {
        var d = notes[i].getDuration();
        if (d === '8' || d === '16') { cur.push(notes[i]); }
        else { if (cur.length >= 2) groups.push(cur); cur = []; }
      }
      if (cur.length >= 2) groups.push(cur);
      return groups;
    }
    ```

17. **Dotted notes** — Use `VF.Dot.buildAndAttach([staveNote], { all: true })` to add a dot. The duration string stays `'h'` or `'q'` (not `'hd'`). VexFlow calculates tick duration from the dot modifier, not from the duration string. A dotted half = 3 beats, dotted quarter = 1.5 beats.

18. **Accidentals: flats use `'b'` not `'♭'`** — VexFlow accidental strings: `'#'` for sharp, `'b'` for flat, `'bb'` for double flat, `'##'` or `'x'` for double sharp, `'n'` for natural. The key string should use the base note only: `'e/5'` with `.addModifier(new VF.Accidental('b'), keyIndex)` — not `'eb/5'`.

19. **Ties between notes** — Use `new VF.StaveTie({ first_note, last_note, first_indices: [0], last_indices: [0] })`. Both notes must be in the same voice and already added as tickables. Call `tie.setContext(ctx).draw()` after the voice is drawn. For ties across barlines, you need notes in adjacent measures — this requires cross-measure references.

20. **Voice strict mode** — Use `.setStrict(false)` on voices when note durations might not sum to exactly 4 beats (e.g., during development or when using dotted notes). Strict mode throws an error if ticks don't match the time signature exactly.

21. **VexFlow duration strings** — `'w'` = whole (4 beats), `'h'` = half (2), `'q'` = quarter (1), `'8'` = eighth (0.5), `'16'` = sixteenth (0.25). Rests: append `'r'` → `'wr'`, `'hr'`, `'qr'`, `'8r'`, `'16r'`. Dotted notes use the base duration string plus `VF.Dot.buildAndAttach()`.

### General
22. **Canvas needs devicePixelRatio scaling** — without it, everything looks blurry on Retina/HiDPI screens. Set canvas.width/height to element size * devicePixelRatio, then use ctx.setTransform to scale back.

---

## VexFlow Quick Reference

### Initialization
```javascript
// After <script src="...vexflow@4.2.2/build/cjs/vexflow.js">
var VF = Vex.Flow;
```

### MIDI to VexFlow Conversion
```javascript
var NOTE_NAMES = ['c','c','d','d','e','f','f','g','g','a','a','b'];
var ACCIDENTALS = [null,'#',null,'#',null,null,'#',null,'#',null,'#',null];

function midiToVexKey(midi) {
  return NOTE_NAMES[midi % 12] + '/' + (Math.floor(midi / 12) - 1);
}
function midiAccidental(midi) {
  return ACCIDENTALS[midi % 12];  // null or '#'
}
function midiToClef(midi) {
  return midi < 60 ? 'bass' : 'treble';
}
```

### Rendering a Grand Staff Measure
```javascript
var renderer = new VF.Renderer(divElement, VF.Renderer.Backends.SVG);
renderer.resize(width, 280);
var ctx = renderer.getContext();

var treble = new VF.Stave(x, 10, measureWidth);
treble.addClef('treble');  // first measure only
treble.setContext(ctx).draw();

var bass = new VF.Stave(x, 140, measureWidth);
bass.addClef('bass');
bass.setContext(ctx).draw();

// Brace connector (first measure only)
new VF.StaveConnector(treble, bass)
  .setType(VF.StaveConnector.type.BRACE).setContext(ctx).draw();
```

### Note Durations
```javascript
// Durations: 'w'=whole, 'h'=half, 'q'=quarter, '8'=eighth, '16'=sixteenth
// Rests: 'wr', 'hr', 'qr', '8r', '16r'

// Quarter note
var note = new VF.StaveNote({ clef:'treble', keys:['a/4'], duration:'q' });

// Dotted half note (3 beats)
var dotted = new VF.StaveNote({ clef:'treble', keys:['a/4'], duration:'h' });
VF.Dot.buildAndAttach([dotted], { all: true });

// Eighth rest
var rest = new VF.StaveNote({ clef:'treble', keys:['b/4'], duration:'8r' });
```

### Chords (multiple notes stacked)
```javascript
// C major triad
var chord = new VF.StaveNote({
  clef:'treble', keys:['c/4','e/4','g/4'], duration:'q'
});
// Accidental on second note (E♭ instead of E)
chord.addModifier(new VF.Accidental('b'), 1);  // index 1 = second key
```

### Beaming (connecting 8th/16th notes)
```javascript
// MUST create Beam objects BEFORE voice.draw() to suppress flags

// Helper: group consecutive beamable notes
function getBeamGroups(notes) {
  var groups = [], cur = [];
  for (var i = 0; i < notes.length; i++) {
    var d = notes[i].getDuration();
    if (d === '8' || d === '16') { cur.push(notes[i]); }
    else { if (cur.length >= 2) groups.push(cur); cur = []; }
  }
  if (cur.length >= 2) groups.push(cur);
  return groups;
}

// Usage:
var beamGroups = getBeamGroups(vexNotes);
var beams = beamGroups.map(function(g) { return new VF.Beam(g); });

// Draw voice AFTER creating beams (flags auto-suppressed)
voice.draw(ctx, stave);
beams.forEach(function(b) { b.setContext(ctx).draw(); });
```

### Ties
```javascript
// Tie between two notes in the same voice
var tie = new VF.StaveTie({
  first_note: noteA,
  last_note: noteB,
  first_indices: [0],   // which key index in the chord
  last_indices: [0]
});
// Draw after voice.draw()
tie.setContext(ctx).draw();
```

### Coloring Notes
```javascript
note.setStyle({ fillStyle: '#16a34a', strokeStyle: '#16a34a' }); // green
// Colors: hit=#16a34a, miss=#dc2626, current=#2563eb, default=#1a1a1e
// For rests you want to hide: fillStyle:'transparent', strokeStyle:'transparent'
```

### Side-Scrolling Architecture
```javascript
// 1. Render full score (or N repeats) as one wide SVG
var renderer = new VF.Renderer(div, VF.Renderer.Backends.SVG);
renderer.resize(totalWidth, 280);
// ... render all measures ...

// 2. Append SVG to scroll layer div
scrollLayer.appendChild(svg);

// 3. Scroll via CSS transform in rAF loop
var originPx = firstNoteX - screenWidth;  // start with notes off-screen right
var scrollStartT = performance.now();
var pxPerMs = BEAT_PX / (60000 / bpm);

function frame() {
  var elapsed = performance.now() - scrollStartT;
  var scrollOff = originPx + elapsed * pxPerMs;
  scrollLayer.style.transform = 'translateX(' + (-scrollOff) + 'px)';

  // Check for notes crossing target line, loop when exhausted
  requestAnimationFrame(frame);
}

// 4. Seamless looping: render 3 copies, teleport origin when 2nd copy passes target
if (targetWorldX > secondCopyStart) {
  originPx += copyWidth;  // jump forward, visually identical
}
```

---

## Data Model Summary

Three tiers (full spec in sam-data-model.md):

### Song
```json
{ "id": "song_001", "title": "Someone Like You", "measures": [...] }
```
Each measure contains beats, each beat has `lh` and `rh` arrays of `{ midi, name, duration }`.

### Snippet
```json
{ "id": "snip_001", "songId": "song_001", "startMeasure": 5, "endMeasure": 8,
  "restMeasures": 0, "settings": { "bpm": 45, "timingWindowMs": 120 } }
```
References a range of measures with per-snippet settings.

### Practice Session
```json
{ "id": "session_001", "snippetId": "snip_001",
  "events": [
    { "loopIteration": 1, "measure": 17, "beat": 3,
      "expectedNotes": [52, 64, 68, 71], "playedNotes": [52, 64, 67, 71],
      "result": "wrong_note", "timingDeltaMs": 45, "velocity": [74, 60, 55, 68] }
  ]
}
```
Every note event is logged with enough context for measure-level, note-level analysis.

### What This Enables
- "You're consistently 40ms late on measure 17, beat 3"
- "You keep dropping the F# in the right hand at measure 20"
- "Your accuracy drops from 92% to 68% above 55 BPM"
- "Velocity analysis: you're hammering beat 1, ghosting beat 3"

---

## Next Proof of Concepts

These are the next layers toward the full product vision, in suggested order:

1. ~~**VexFlow + scrolling integration**~~ ✅ DONE — Pure CSS `translateX` on wide VexFlow SVG, driven by `requestAnimationFrame`. Seamless looping via 3-copy teleport.

2. ~~**Notation stress test**~~ ✅ DONE — Verified: whole/half/quarter/8th/16th notes and rests, dotted notes, beaming, chords (triads and 7ths), accidentals (sharps and flats), ties, ledger lines (high treble C6+, low bass G1), wide spreads, mixed durations. All render and scroll smoothly.

3. **Sequence loading from JSON** — Load a song JSON file (drag-and-drop or file picker), parse into the internal data model, render on the grand staff with proper durations/beaming, and play through it.

4. **Loop engine refinement** — Currently loops endlessly. Add: configurable loop region (start/end measure), rest measures between loops, loop count limit.

5. **Touch gesture system** — Tap to pause/play, swipe to scrub, drag-select for loop region. Essential for tablet-at-piano use case.

6. **Snippet management** — Save/load/delete snippets. Store in IndexedDB with the per-snippet settings and practice history.

7. **Practice session logging** — Wire up the event logger to capture every note during play. Store sessions. Build a simple stats view.

8. **MusicXML import** — Parse MusicXML files into the song data model. Enables loading purchased sheet music from MuseScore.

9. **Tempo ramping** — Start slow (40 BPM), manually increase. Track accuracy at each tempo to find the "breakdown" speed.

10. **Offline/PWA** — Add a service worker and bundle VexFlow locally so the app works without internet after first load.

---

## Files in This Project

### Documentation
| File | Description |
|------|-------------|
| `sam-tech-spec.md` | Architecture, Supabase schema, component specifications |
| `sam-midi-guide.md` | This file — validated patterns, gotchas, code reference |
| `sam-build-plan.md` | Step-by-step implementation order with acceptance criteria |
| `sam-data-model.md` | Full data model spec (Song, Snippet, Practice Session) |

### Prototypes (for reference — production build follows tech spec)
| File | Description |
|------|-------------|
| `sam-player.html` | JSON song loader + scrolling player + MIDI chord matching |
| `sam-notation-test.html` | VexFlow stress test — all durations, beaming, chords, accidentals, ties |
| `sam-vexflow.html` | Scrolling VexFlow + MIDI — hardcoded chord sequence |
| `sam-midi-capture.html` | Original MIDI capture + timing engine (vanilla JS, no VexFlow) |
| `sam-ui-mockup.html` | Static UI mockup — Play Mode and Pause Mode toggle |
| `someone-like-you.json` | Sample song file in internal JSON format (8 measures) |
