import { SCROLL_GEOMETRY } from "./samConstants";

// How far right of the play line the first note starts (display px), shared by
// ScrollEngine (where the score starts) and useAudioSync (when audio starts) so
// the two cannot disagree.
//
// The base is the fixed `leadInPct` of the viewport. Whole beats are added on top
// until the approach lasts at least `minMs` of WALL time at the real scroll
// speed; `rate` is the audio playbackRate when audio drives the clock, else 1.
// Whole beats keep the metronome grid where it was.
export function leadInPx({
  viewportWidth,
  pxPerBeat,
  msPerBeat,
  rate = 1,
  minMs = SCROLL_GEOMETRY.leadInMinMs,
}) {
  const basePx = viewportWidth * SCROLL_GEOMETRY.leadInPct;
  const r = rate > 0 ? rate : 1;
  if (!(pxPerBeat > 0) || !(msPerBeat > 0)) return { px: basePx, extraBeats: 0, wallMs: 0 };
  const wallMsPerBeat = msPerBeat / r;
  const baseWallMs = (basePx / pxPerBeat) * wallMsPerBeat;
  // The epsilon stops float noise turning an exact fit into one beat too many.
  const extraBeats = Math.max(0, Math.ceil((minMs - baseWallMs) / wallMsPerBeat - 1e-9));
  return {
    px: basePx + extraBeats * pxPerBeat,
    extraBeats,
    wallMs: baseWallMs + extraBeats * wallMsPerBeat,
  };
}
