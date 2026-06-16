// Centralized SAM constants — single source of truth for default settings,
// scroll geometry, and metronome gain. Importing from one place makes the
// implicit coupling between ScrollEngine and useAudioSync explicit (see
// SCROLL_GEOMETRY) and keeps default settings from drifting across files.

// Default settings applied when a song doesn't specify them.
export const DEFAULTS = {
  bpm: 68,
  timingWindowMs: 300,
  chordMs: 80,
  measureWidth: 300,
  playbackSpeed: 100,
};

// Geometry shared between ScrollEngine and useAudioSync.
// targetLinePct and leadInPct determine where notes appear and when they
// cross the target line; both files MUST use the same values or audio will
// desync from visual scroll.
export const SCROLL_GEOMETRY = {
  targetLinePct: 0.15,         // 15% from left edge
  leadInPct: 0.25,             // 25% of viewport for first-note approach
  staffHeight: 350,
  fallbackViewportWidth: 800,
};

// Metronome click gain for on-beat vs off-beat ticks.
export const METRONOME_GAIN = {
  onBeat: 0.3,
  offBeat: 0.15,
};

// Visual scale factor for rendered score output. Multiplies every VexFlow-drawn
// dimension (notehead, stave height, clef, lyrics) without affecting SAM's
// measure-width logic, which operates in render-space pre-scale. The scroll
// layer and audio-sync also need to cross from render-space to display pixels
// using this factor at their consumer-side boundaries (see ScrollEngine's
// animation effect, useAudioSync.getApproachMs).
export const SCORE_SCALE = 1.25;
