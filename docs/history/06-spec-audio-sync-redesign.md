# Audio Sync Redesign — Technical Specification

## Overview

Replace the two-BPM system (`defaultBpm` + `playbackBpm`) with an anchor-based audio sync model using `audio_offset_ms` on song measures, plus a single `playback_speed` percentage control. This simplifies the mental model and enables accurate sync with real recordings that have natural tempo variation.

## Design Goals

1. Songs with audio derive scroll speed from audio anchor points, not BPM
2. Songs without audio derive scroll speed from `default_bpm` (unchanged)
3. Replace `playbackBpm / defaultBpm` ratio with a single `playback_speed` percentage (100 = original speed)
4. Remove `audio_lead_in_ms` from `sam_songs` — replaced by `audio_offset_ms` on measure 1
5. Remove `playback_bpm` from `sam_songs` — replaced by `playback_speed`
6. Support 1 anchor (measure 1 only, end = audio duration) or N anchors (mid-song correction points)

## Data Model Changes

### sam_songs

| Field | Change |
|---|---|
| `playback_bpm` | REMOVED |
| `audio_lead_in_ms` | REMOVED |
| `playback_speed` | NEW — integer percentage, default 100. Stored on the song so it persists across sessions. |
| `default_bpm` | KEPT — used for no-audio mode scroll speed. Informational only in audio mode. |

### sam_song_measures

| Field | Change |
|---|---|
| `audio_offset_ms` | EXISTING — now the primary sync mechanism. Represents "this measure starts at this ms in the audio file." |

## Two Scroll Modes

### Audio Mode (audioElement exists)

The scroll engine derives speed from anchor points on the measures.

**Anchor collection:**
1. Scan `activeMeasures` for any measure with `audioOffsetMs` set
2. Build an ordered list of anchors: `[{ measureIndex, beatOffset, audioMs }]`
3. If no anchors exist at all, fall back to no-audio mode using `default_bpm`
4. The final anchor end-point is the audio element's duration: `audioElement.duration * 1000`

**Scroll speed calculation per segment:**

For each pair of adjacent anchors (A, B):

```javascript
const segmentBeats = totalBeatsBetween(anchorA, anchorB);  // sum of quarter-note durations
const segmentAudioMs = anchorB.audioMs - anchorA.audioMs;   // time span in the recording
const playbackRate = playbackSpeed / 100;                    // e.g., 75 / 100 = 0.75
const segmentRealMs = segmentAudioMs / playbackRate;         // real time at playback speed
const segmentPx = pixelsBetween(anchorA, anchorB);           // distance on the SVG
const localPxPerMs = segmentPx / segmentRealMs;
```

For the final segment (last anchor to end of song):
- If only one anchor exists (measure 1), the end is `audioElement.duration * 1000`
- `segmentBeats` = beats from last anchor to end of notation
- `segmentAudioMs` = audioDurationMs - lastAnchor.audioMs
- Same formula applies

**During the frame() loop:**

```javascript
// 1. Determine elapsed time from audio position
const audioCurrentMs = audioElement.currentTime * 1000;
const playbackRate = playbackSpeed / 100;

// 2. Find which segment we're in based on audio time
const segment = findSegmentForAudioTime(audioCurrentMs);

// 3. Calculate scroll position within the segment
const segmentProgress = (audioCurrentMs - segment.startAudioMs) / (segment.endAudioMs - segment.startAudioMs);
const scrollX = segment.startPx + segmentProgress * segment.segmentPx;

// 4. Apply scroll
scrollLayer.style.transform = `translateX(${targetX - scrollX}px)`;
```

This replaces the current `elapsed * pxPerMs` approach with a position derived directly from the audio time.

**When audio hasn't started yet (pre-approach):**
Use wall-clock time with the first segment's pxPerMs to scroll during the visual lead-in before audio starts.

### No-Audio Mode (no audioElement)

Unchanged from current behavior:

```javascript
const msPerBeat = 60000 / bpm;       // bpm = the user's chosen practice BPM
const pxPerMs = pxPerBeat / msPerBeat;
const elapsed = now - scrollStartT;
const scrollOffset = originPx + elapsed * pxPerMs;
```

The `playback_speed` field is NOT used in no-audio mode — the BPM input IS the speed control. `playback_speed` only applies when audio is present.

## UI Changes

### SettingsBar

**With audio:**
- Show `Playback Speed` as a number input with `%` suffix, default 100
- Show `Default BPM` as read-only/informational (grayed out), or hide entirely
- Remove `Playback BPM` field
- Remove `Lead-In ms` field

**Without audio:**
- Show `BPM` input (this is `default_bpm`, the only speed control)
- Show `Default BPM` as editable (sets the practice tempo)
- Hide `Playback Speed` (not relevant)
- Remove `Lead-In ms` field

### Audio Offset UI (future enhancement)

Eventually, a way to set `audio_offset_ms` on measures from the UI — perhaps tap a measure while the audio plays to mark the sync point. For now, offsets are set via MCP or SQL.

## SamPlayer.jsx Changes

### Remove deprecated state/props
- Remove `audioLeadInMs`, `audioLeadInMsInput` state
- Remove `defaultBpm`, `defaultBpmInput` state (keep `bpm` / `bpmInput` for no-audio mode)
- Remove `playbackBpm` references
- Add `playbackSpeed`, `playbackSpeedInput` state (integer, default 100)

### Audio playback rate
Currently: `audioElement.playbackRate = bpm / defaultBpm`
New: `audioElement.playbackRate = playbackSpeed / 100`

### Approach time and audio delay
The current `getApproachMs()` → `scrollDelay` / `audioDelay` logic needs updating:

**With audio:**
- `approachMs` = time for first note to travel from start position to target line (same calculation)
- Measure 1's `audioOffsetMs` = where notation starts in the audio
- At `playbackSpeed = 100`: audio should be at `audioOffsetMs` when measure 1 crosses the target line
- `audioStartTime = audioOffsetMs / 1000 - approachMs * (playbackSpeed / 100) / 1000`
  - If negative: seek audio to 0, delay scroll by the overshoot
  - If positive: seek audio to that timestamp, start scroll immediately

**Without audio:**
- Same as current BPM-driven approach, no delay calculation needed

### ScrollEngine props
- Remove `audioLeadInMs` prop
- Remove `scrollPrerollMs` prop
- Add `playbackSpeed` prop (integer percentage)
- Add `audioAnchors` prop — array of `{ measureIndex, cumulativeBeat, audioMs }` computed by SamPlayer from `activeMeasures`
- Add `audioDurationMs` prop — from `audioElement.duration * 1000`

### Building the anchors array (in SamPlayer)

```javascript
const audioAnchors = useMemo(() => {
  if (!audioElement || !activeMeasures.length) return [];
  
  const anchors = [];
  let cumulativeBeat = 0;
  
  for (let i = 0; i < activeMeasures.length; i++) {
    const m = activeMeasures[i];
    if (m.audioOffsetMs != null) {
      anchors.push({
        measureIndex: i,
        cumulativeBeat,
        audioMs: m.audioOffsetMs,
      });
    }
    cumulativeBeat += getMeasDurationQ(m);
  }
  
  // Add end anchor from audio duration
  anchors.push({
    measureIndex: activeMeasures.length,
    cumulativeBeat,
    audioMs: audioElement.duration * 1000,
  });
  
  return anchors;
}, [audioElement, activeMeasures]);
```

## ScrollEngine.jsx Changes

### On init (when playbackState becomes "playing")

**Audio mode (audioAnchors provided and length >= 2):**

Build a segments array from the anchors. Each segment has:
```javascript
{
  startAudioMs,       // anchor A's audioMs
  endAudioMs,         // anchor B's audioMs
  startBeat,          // anchor A's cumulativeBeat
  endBeat,            // anchor B's cumulativeBeat
  startPx,            // pixel X of anchor A's first beat event
  endPx,              // pixel X of anchor B's first beat event
  pxPerMs,            // segmentPx / (segmentAudioMs / playbackRate)
}
```

Compute `targetTimeMs` per beat event. Instead of one global `pxPerMs`, find which segment each beat belongs to and compute its target time using that segment's speed.

**No-audio mode:**
Unchanged — single `pxPerMs` from BPM.

### In frame()

**Audio mode:**
```javascript
if (audioElement && !audioElement.paused) {
  const audioMs = audioElement.currentTime * 1000;
  // Find segment for current audio position
  // Interpolate scroll position within segment
  // Apply transform
} else if (audioElement && audioElement.paused && audioElement.currentTime > 0) {
  // Frozen at last audio position
} else {
  // Pre-approach: wall clock with first segment's pxPerMs
  elapsed = now - state.scrollStartT;
}
```

**No-audio mode:**
```javascript
elapsed = now - state.scrollStartT;
scrollOffset = originPx + elapsed * pxPerMs;
```

### Miss detection

With variable pxPerMs across segments, `targetTimeMs` per beat event must be precomputed during init using the per-segment speeds. The miss detection logic itself doesn't change — it still checks `elapsed > targetTimeMs + timingWindowMs`.

## Song Loading Changes

### SongLoader / handleSongLoaded

- Read `playback_speed` from the song record (default 100)
- Stop reading `playback_bpm` and `audio_lead_in_ms`
- `audio_offset_ms` values come through on the measures from the compiled blob (as `audioOffsetMs`)

### measureCompiler.js

Already includes `audio_offset_ms` in both fan-out and recompile. No changes needed.

## Migration

### Existing songs with audio_lead_in_ms set

Any song that had `audio_lead_in_ms = X` should have `audio_offset_ms = X` set on measure 1 of `sam_song_measures` before the column is dropped. Run this migration before dropping the column:

```sql
-- Migrate audio_lead_in_ms to audio_offset_ms on measure 1
UPDATE sam_song_measures sm
SET audio_offset_ms = s.audio_lead_in_ms
FROM sam_songs s
WHERE sm.song_id = s.id
  AND sm.number = 1
  AND s.audio_lead_in_ms IS NOT NULL
  AND s.audio_lead_in_ms != 0
  AND sm.audio_offset_ms IS NULL;
```

### Existing songs with playback_bpm set

The `playback_speed` equivalent of `playback_bpm = 50` with `default_bpm = 66` is `playback_speed = ROUND(50.0 / 66.0 * 100)` = 76.

```sql
-- Migrate playback_bpm to playback_speed
UPDATE sam_songs
SET playback_speed = ROUND(playback_bpm::numeric / default_bpm::numeric * 100)
WHERE playback_bpm IS NOT NULL
  AND default_bpm IS NOT NULL
  AND default_bpm > 0;
```

## Testing Checklist

- [ ] Song with audio, one anchor (measure 1 only) — scroll speed derived from anchor + audio duration
- [ ] Song with audio, multiple anchors — scroll speed varies per section
- [ ] Song with audio, no anchors at all — falls back to `default_bpm`
- [ ] Song without audio — BPM mode, unchanged behavior
- [ ] Playback speed at 100% — audio at 1.0x, scroll matches
- [ ] Playback speed at 75% — audio at 0.75x, scroll slows proportionally
- [ ] Playback speed at 50% — audio at 0.5x, scroll matches
- [ ] Snippet playback with audio — audio seeks to correct position using anchors
- [ ] Pause/resume — scroll position stays synced with audio position
- [ ] Miss detection — timing still correct with variable scroll speed
- [ ] Metronome — clicks align with beats at variable speed (or disable metronome in audio mode?)
