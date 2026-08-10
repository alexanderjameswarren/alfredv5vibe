// Synth voice + shared master bus — spec §"New files" of
// docs/technical-spec-full-playback.md.
//
// Raw Web Audio, no Tone.js (spec D1). Same fire-and-forget shape as playClick
// (scoreRender.js): create oscillator + gain per event, schedule against
// audioCtx.currentTime, let it collect itself when it finishes. A note voice is
// just that with a MIDI-derived frequency and a real envelope.
//
// Everything routes through one master bus rather than straight to
// destination, so full playback (which can stack 8+ simultaneous notes across
// both hands) has a single summing point and one place to set level. playClick
// migrates onto the same bus so click and synth share it.

// Peak gain of a velocity-1.0 note, before the master bus. Chosen so a dense
// chord stays musical rather than merely safe — the limiter below catches the
// rare all-notes-attack-together case that pure gain staging cannot.
const NOTE_PEAK_GAIN = 0.22;

// Fraction of peak the note decays to and holds. Low sustain = percussive
// attack, which is what makes it possible to hear whether a melody line
// survived a simplifier transform (spec: timbre fidelity is not a goal).
const SUSTAIN_RATIO = 0.3;

const ATTACK_S = 0.005;
const DECAY_S = 0.12;
const RELEASE_S = 0.08;

// Floor for exponentialRampToValueAtTime, which cannot reach or start from 0.
const GAIN_EPS = 0.0001;

// Shortest note we will articulate. Below this the envelope has no room for
// attack + release and degenerates into a click.
const MIN_NOTE_S = 0.03;

// Master bus level. Unity by default: the M2 contract is that the metronome
// clicks at UNCHANGED volume after migrating onto the bus, which any value
// below 1.0 would break. Headroom therefore comes from the limiter, not from
// turning the bus down. This is the one knob to turn if a master volume
// control is ever wanted.
const MASTER_GAIN = 1.0;

// Soft limiter downstream of the master gain. A plain gain bus at unity gives
// no protection, and a gain bus below unity would quieten the click — the spec
// asks for both, so the headroom lives here instead.
//
// With knee 0, gain reduction below the threshold is exactly zero, so the
// metronome click (peak 0.3 / 0.15, i.e. -10.5 / -16.5 dBFS) passes through
// bit-identical. Only a genuinely dense stack reaches -6 dBFS and gets caught.
const LIMITER_THRESHOLD_DB = -6;
const LIMITER_RATIO = 20;
const LIMITER_ATTACK_S = 0.003;
const LIMITER_RELEASE_S = 0.25;

// Keyed by AudioContext so a recreated context gets a fresh bus and the old
// one is collectable. SamPlayer holds a single long-lived context
// (ensureAudioContext), so in practice this has one entry.
const busCache = new WeakMap();

/** Equal-temperament MIDI note number → frequency in Hz. A4 (69) = 440. */
export function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/**
 * The shared master bus for this AudioContext, created on first use.
 *
 * Returns the input GainNode — connect sources to it, and set its `.gain` to
 * change master level. The limiter behind it is an implementation detail.
 *
 * @param {AudioContext} audioCtx
 * @returns {GainNode|null} null when no context was supplied
 */
export function getMasterBus(audioCtx) {
  if (!audioCtx) return null;

  const cached = busCache.get(audioCtx);
  if (cached) return cached;

  const bus = audioCtx.createGain();
  bus.gain.value = MASTER_GAIN;

  const limiter = audioCtx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER_THRESHOLD_DB;
  limiter.knee.value = 0; // hard knee — exact transparency below threshold
  limiter.ratio.value = LIMITER_RATIO;
  limiter.attack.value = LIMITER_ATTACK_S;
  limiter.release.value = LIMITER_RELEASE_S;

  bus.connect(limiter).connect(audioCtx.destination);
  busCache.set(audioCtx, bus);
  return bus;
}

/**
 * Schedule one note on the shared bus.
 *
 * Triangle oscillator with a percussive AD-S-R: fast attack, decay to a low
 * sustain, short release. The whole envelope is scheduled up front against
 * `when` — nothing here depends on wall-clock time, so a note scheduled inside
 * the rAF lookahead sounds at exactly the right moment.
 *
 * `durationS` is the SOUNDING length, release included; the oscillator is
 * explicitly stopped just past the end of the release. Callers running at a
 * reduced playback speed must pre-divide by `rate` (spec D3) — this function
 * has no notion of tempo.
 *
 * @param {AudioContext} audioCtx
 * @param {number} when      - audioCtx-clock time to begin, in seconds
 * @param {number} midi      - MIDI note number
 * @param {number} durationS - sounding duration in seconds
 * @param {number} [velocity=1] - 0..1, scales peak gain
 * @returns {{osc: OscillatorNode, gain: GainNode}|null} the created nodes, so
 *   the caller can track them and stop them early on pause / teleport. null if
 *   the note was not schedulable.
 */
export function playNote(audioCtx, when, midi, durationS, velocity = 1) {
  if (!audioCtx || typeof midi !== "number") return null;

  const bus = getMasterBus(audioCtx);
  if (!bus) return null;

  const peak = Math.max(0, Math.min(1, velocity)) * NOTE_PEAK_GAIN;
  if (peak <= 0) return null;

  // A note scheduled in the past would otherwise anchor its envelope behind
  // the clock and play back mid-decay. The M3 scheduler's lookahead should
  // make this unreachable; clamping keeps a late frame from sounding wrong.
  const t0 = Math.max(when, audioCtx.currentTime);
  const dur = Math.max(durationS, MIN_NOTE_S);

  // Short notes get a proportionally shorter release. With a fixed release a
  // 60ms sixteenth would sound for 85ms and bleed into the next one, undoing
  // the articulation gap the timeline just applied. Scaling it means `end`
  // lands exactly on t0 + dur for every note above MIN_NOTE_S, so a note's
  // sounding length is precisely what the caller asked for — which is what
  // makes tie durations and reduced-speed stretching audible rather than
  // approximate.
  const release = Math.min(RELEASE_S, dur * 0.4);

  const attackEnd = t0 + ATTACK_S;
  // Release must not eat the attack: on a very short note the sustain phase
  // vanishes but the attack still resolves.
  const releaseStart = Math.max(t0 + dur - release, attackEnd);
  const decayEnd = Math.min(attackEnd + DECAY_S, releaseStart);
  const end = releaseStart + release;

  const osc = audioCtx.createOscillator();
  osc.type = "triangle";
  osc.frequency.value = midiToFreq(midi);

  const gain = audioCtx.createGain();
  const sustain = Math.max(peak * SUSTAIN_RATIO, GAIN_EPS);

  // linearRamp for the attack because exponentialRamp cannot start from 0.
  gain.gain.setValueAtTime(0, t0);
  gain.gain.linearRampToValueAtTime(peak, attackEnd);
  gain.gain.exponentialRampToValueAtTime(sustain, decayEnd);
  // Anchor the sustain level at the release point. Without this the release
  // ramp would interpolate from decayEnd and start falling immediately,
  // collapsing the held portion of every long note.
  gain.gain.setValueAtTime(sustain, releaseStart);
  gain.gain.exponentialRampToValueAtTime(GAIN_EPS, end);

  osc.connect(gain).connect(bus);
  osc.start(t0);
  osc.stop(end + 0.01); // small tail so the release completes before the stop

  // A long piece schedules thousands of notes; releasing each GainNode as its
  // oscillator finishes keeps them from accumulating on the bus. playClick
  // predates this and fires rarely enough not to need it.
  osc.onended = () => {
    try {
      gain.disconnect();
    } catch {
      // already torn down (context closed, or stopped early) — nothing to do
    }
  };

  return { osc, gain };
}
