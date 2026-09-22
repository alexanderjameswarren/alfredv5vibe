import { useState, useEffect, useRef, useCallback } from "react";

// Filter out virtual / loopback ports
function isVirtualPort(name) {
  const lower = (name || "").toLowerCase();
  return lower.includes("midi through") || lower.includes("thru");
}

// `onHeldKeys` is practice mode's resume signal, and the ONLY reason Note Off
// is looked at anywhere in SAM. It is called with the live Set of keys
// currently down, after every press and every release, but ONLY while a
// listener is attached — which is only while a Practice run is in flight. With
// no listener this file behaves exactly as it did: Play's path through the
// handler is unchanged.
//
// The Set is the live one, not a copy: the consumer reads it and must not keep
// it. Copying it on every key of a fast run would be pure garbage.
export default function useMIDI({ onChord, chordGroupMs = 80, onHeldKeys } = {}) {
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState(null);
  const [lastNote, setLastNote] = useState(null);

  const onChordRef = useRef(onChord);
  onChordRef.current = onChord;

  const chordGroupMsRef = useRef(chordGroupMs);
  chordGroupMsRef.current = chordGroupMs;

  const onHeldKeysRef = useRef(onHeldKeys);
  onHeldKeysRef.current = onHeldKeys;

  // Which keys are down right now. Only ever written while a listener is
  // attached, so it stays empty for the whole of a normal Play sitting.
  const heldRef = useRef(new Set());

  const inputBufferRef = useRef([]);
  const flushTimerRef = useRef(null);

  // WHEN THE CHORD WAS STRUCK, not when it was flushed (2026-09-19).
  //
  // A chord is buffered and delivered on a setTimeout `chordGroupMs` (80 ms by
  // default) after its LAST key. Scoring used to measure the offset at that
  // moment, so every event carried ~80 ms of built-in lateness — more whenever
  // the main thread was busy, which is worst at a loop restart. The press time
  // is now carried through the buffer and handed to the matcher.
  //
  // `performance.now()` at handler entry, NOT `e.timeStamp`: the two share an
  // origin in every browser that implements Web MIDI, but `e.timeStamp` is 0
  // on some drivers and the handler runs within a millisecond of the event, so
  // this is the safer reading of the same instant.
  const firstPressAtRef = useRef(null);

  const flushChord = useCallback(() => {
    const buffer = inputBufferRef.current;
    if (buffer.length === 0) return;
    // Deduplicate and sort ascending
    const sorted = [...new Set(buffer)].sort((a, b) => a - b);
    // The FIRST key of the chord is when the chord was struck. Rolling the
    // notes is a performance choice, not lateness.
    const pressedAtMs = firstPressAtRef.current;
    inputBufferRef.current = [];
    firstPressAtRef.current = null;
    if (onChordRef.current) {
      onChordRef.current(sorted, pressedAtMs);
    }
  }, []);

  const handleMIDIMessage = useCallback((e) => {
    const at = performance.now();
    const [status, note, velocity] = e.data;

    // Ignore system messages
    if (status >= 0xF0) return;

    const kind = status & 0xF0;
    // A Note On with velocity 0 IS a Note Off — plenty of keyboards send
    // nothing else — which is why the original scoring filter tested velocity
    // as well as status, and why the release test has to do the same.
    const isNoteOn = kind === 0x90 && velocity > 0;
    const isNoteOff = kind === 0x80 || (kind === 0x90 && velocity === 0);
    const notifyHeld = onHeldKeysRef.current;

    // The held set. CC64 is deliberately absent: "held" means fingers, so the
    // sustain pedal cannot satisfy a chord it is not holding down.
    if (notifyHeld && (isNoteOn || isNoteOff)) {
      if (isNoteOn) heldRef.current.add(note);
      else heldRef.current.delete(note);
    }

    // Everything that is not a struck key scores nothing — the pre-existing
    // filter, unchanged. A release only ever updates the held set.
    if (!isNoteOn) {
      if (notifyHeld && isNoteOff) notifyHeld(heldRef.current);
      return;
    }

    setLastNote(note);

    // Chord buffering: accumulate notes, flush after chordGroupMs
    if (inputBufferRef.current.length === 0) firstPressAtRef.current = at;
    inputBufferRef.current.push(note);
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(flushChord, chordGroupMsRef.current);

    // NOTIFIED AFTER THE BUFFER, NOT BEFORE. The press that completes a stuck
    // chord resumes the run from inside this call, and the resume drops the
    // pending chord group — which is what stops the keys held to satisfy that
    // beat being graded as a press at the beat the run has just moved on to.
    // Notifying first would let this very note be re-buffered afterwards and
    // land on the next beat anyway.
    if (notifyHeld) notifyHeld(heldRef.current);
  }, [flushChord]);

  // Drop the chord group waiting to flush. Used by the practice resume, above.
  const cancelPendingChord = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    inputBufferRef.current = [];
    firstPressAtRef.current = null;
  }, []);

  // Start a practice run from a clean slate: a key whose Note Off was lost to a
  // hot-plug would otherwise stay "held" for the rest of the sitting and make
  // every chord containing it resume for free.
  const resetHeldKeys = useCallback(() => {
    heldRef.current.clear();
  }, []);

  useEffect(() => {
    if (!navigator.requestMIDIAccess) {
      console.warn("[Sam] Web MIDI not supported in this browser");
      return;
    }

    let midiAccess = null;
    let pollInterval = null;
    let cancelled = false;
    // Captured, not read through the ref in the cleanup below: the Set is never
    // reassigned — only mutated and cleared — so this is the same object, and
    // the lint rule is right that reading `.current` at teardown is a trap.
    const held = heldRef.current;

    function bindInputs(access) {
      if (cancelled) return;

      let boundDevice = null;
      for (const input of access.inputs.values()) {
        if (isVirtualPort(input.name)) continue;
        input.onmidimessage = handleMIDIMessage;
        if (!boundDevice) boundDevice = input.name;
      }

      if (boundDevice) {
        setConnected(true);
        setDeviceName(boundDevice);
      } else {
        setConnected(false);
        setDeviceName(null);
      }
    }

    navigator.requestMIDIAccess({ sysex: false }).then((access) => {
      if (cancelled) return;
      midiAccess = access;

      // Initial bind
      bindInputs(access);

      // Listen for hot-plug events
      access.onstatechange = () => bindInputs(access);

      // Poll every 3s as ChromeOS workaround
      pollInterval = setInterval(() => bindInputs(access), 3000);
    }).catch((err) => {
      console.error("[Sam] MIDI access denied:", err);
    });

    return () => {
      cancelled = true;
      if (pollInterval) clearInterval(pollInterval);
      if (midiAccess) {
        midiAccess.onstatechange = null;
        for (const input of midiAccess.inputs.values()) {
          input.onmidimessage = null;
        }
      }
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      held.clear();
    };
  }, [handleMIDIMessage]);

  return { connected, deviceName, lastNote, cancelPendingChord, resetHeldKeys };
}
