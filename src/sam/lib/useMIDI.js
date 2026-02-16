import { useState, useEffect, useRef, useCallback } from "react";

// Filter out virtual / loopback ports
function isVirtualPort(name) {
  const lower = (name || "").toLowerCase();
  return lower.includes("midi through") || lower.includes("thru");
}

export default function useMIDI({ onChord, chordGroupMs = 80 } = {}) {
  const [connected, setConnected] = useState(false);
  const [deviceName, setDeviceName] = useState(null);
  const [lastNote, setLastNote] = useState(null);

  const onChordRef = useRef(onChord);
  onChordRef.current = onChord;

  const chordGroupMsRef = useRef(chordGroupMs);
  chordGroupMsRef.current = chordGroupMs;

  const inputBufferRef = useRef([]);
  const flushTimerRef = useRef(null);

  const flushChord = useCallback(() => {
    const buffer = inputBufferRef.current;
    if (buffer.length === 0) return;
    // Deduplicate and sort ascending
    const sorted = [...new Set(buffer)].sort((a, b) => a - b);
    inputBufferRef.current = [];
    if (onChordRef.current) {
      onChordRef.current(sorted);
    }
  }, []);

  const handleMIDIMessage = useCallback((e) => {
    const [status, note, velocity] = e.data;

    // Ignore system messages
    if (status >= 0xF0) return;

    // Only process Note On with velocity > 0
    if ((status & 0xF0) !== 0x90 || velocity === 0) return;

    setLastNote(note);

    // Chord buffering: accumulate notes, flush after chordGroupMs
    inputBufferRef.current.push(note);
    if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    flushTimerRef.current = setTimeout(flushChord, chordGroupMsRef.current);
  }, [flushChord]);

  useEffect(() => {
    if (!navigator.requestMIDIAccess) {
      console.warn("[Sam] Web MIDI not supported in this browser");
      return;
    }

    let midiAccess = null;
    let pollInterval = null;
    let cancelled = false;

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
    };
  }, [handleMIDIMessage]);

  return { connected, deviceName, lastNote };
}
