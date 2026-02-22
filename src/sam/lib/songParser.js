// MusicXML → Sam internal JSON parser

const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

function pitchToMidi(step, alter, octave) {
  return (parseInt(octave) + 1) * 12 + STEP_SEMITONES[step] + (parseInt(alter) || 0);
}

// MusicXML <type> → VexFlow duration
function xmlTypeToVex(type, dotCount) {
  const map = {
    whole: "w", half: "h", quarter: "q",
    eighth: "8", "16th": "16", "32nd": "32",
  };
  let dur = map[type] || "q";
  for (let i = 0; i < dotCount; i++) dur += "d";
  return dur;
}

// Convert duration in divisions to closest VexFlow duration
function divisionsToVex(dur, divisions) {
  const ratio = dur / divisions; // in quarter notes
  if (ratio >= 3.5) return "w";
  if (ratio >= 2.5) return "hd";
  if (ratio >= 1.75) return "h";
  if (ratio >= 1.25) return "qd";
  if (ratio >= 0.875) return "q";
  if (ratio >= 0.625) return "8d";
  if (ratio >= 0.375) return "8";
  if (ratio >= 0.1875) return "16";
  return "32";
}

// Parse note events from a single <measure> element
function parseNoteEvents(measEl, divisions) {
  const events = [];
  let position = 0;

  for (const el of Array.from(measEl.children)) {
    if (el.tagName === "note") {
      // Skip grace notes
      if (el.querySelector("grace")) continue;

      const isChord = el.querySelector("chord") !== null;
      const isRest = el.querySelector("rest") !== null;
      const duration = parseInt(el.querySelector("duration")?.textContent) || divisions;
      const staffEl = el.querySelector("staff");
      const staff = staffEl ? parseInt(staffEl.textContent) : 0; // 0 = unspecified
      const typeEl = el.querySelector("type");
      const type = typeEl?.textContent || null;
      const dots = el.querySelectorAll("dot").length;

      let midi = 0;
      let name = "";
      let lyric = undefined;
      let tie = undefined;

      if (!isRest) {
        const pitchEl = el.querySelector("pitch");
        if (pitchEl) {
          const step = pitchEl.querySelector("step")?.textContent || "C";
          const alterText = pitchEl.querySelector("alter")?.textContent || "0";
          const alter = parseInt(alterText);
          const octave = pitchEl.querySelector("octave")?.textContent || "4";
          midi = pitchToMidi(step, alterText, octave);

          // Build name from step + accidental + octave
          let accidental = "";
          if (alter === 1) accidental = "#";
          else if (alter === -1) accidental = "b";
          else if (alter === 2) accidental = "##";
          else if (alter === -2) accidental = "bb";
          name = step + accidental + octave;
        }
      }

      // Extract lyric if present
      const lyricEl = el.querySelector("lyric");
      if (lyricEl) {
        const syllabic = lyricEl.querySelector("syllabic")?.textContent;
        const text = lyricEl.querySelector("text")?.textContent || "";
        if (syllabic === "begin" || syllabic === "middle") {
          lyric = text + "-";
        } else {
          lyric = text;
        }
      }

      // Extract tie information
      const tieStart = el.querySelector('tie[type="start"]');
      const tieStop = el.querySelector('tie[type="stop"]');
      if (tieStart && tieStop) {
        tie = "both";
      } else if (tieStart) {
        tie = "start";
      } else if (tieStop) {
        tie = "end";
      }

      const notePos = isChord
        ? (events.length > 0 ? events[events.length - 1].position : position)
        : position;

      const event = {
        position: notePos,
        midi,
        name,
        duration,
        staff,
        isRest,
        vexDuration: type ? xmlTypeToVex(type, dots) : divisionsToVex(duration, divisions),
      };

      // Add optional fields only if defined
      if (lyric !== undefined) event.lyric = lyric;
      if (tie !== undefined) event.tie = tie;

      events.push(event);

      if (!isChord) {
        position += duration;
      }
    } else if (el.tagName === "forward") {
      position += parseInt(el.querySelector("duration")?.textContent) || 0;
    } else if (el.tagName === "backup") {
      position -= parseInt(el.querySelector("duration")?.textContent) || 0;
    }
  }

  return events;
}

const KEY_NAMES = {
  "-7": "Cb major", "-6": "Gb major", "-5": "Db major", "-4": "Ab major",
  "-3": "Eb major", "-2": "Bb major", "-1": "F major", "0": "C major",
  "1": "G major", "2": "D major", "3": "A major", "4": "E major",
  "5": "B major", "6": "F# major", "7": "C# major",
};

// Build an independent voice array from note events assigned to one hand.
// Returns [{ duration, notes: [{ midi, name }] }] — voice format.
function buildVoice(handEvents, divisions) {
  const posMap = new Map();
  for (const evt of handEvents) {
    if (!posMap.has(evt.position)) posMap.set(evt.position, []);
    posMap.get(evt.position).push(evt);
  }

  const positions = [...posMap.keys()].sort((a, b) => a - b);
  const voice = [];
  let cursor = 0;

  for (const pos of positions) {
    // Fill gap with rest
    if (pos > cursor) {
      voice.push({ duration: divisionsToVex(pos - cursor, divisions), notes: [] });
    }

    const events = posMap.get(pos);
    const primary = events[0];
    const dur = primary.vexDuration || divisionsToVex(primary.duration, divisions);

    const notes = events
      .filter((e) => !e.isRest)
      .map((e) => {
        const note = { midi: e.midi, name: e.name };
        if (e.tie !== undefined) note.tie = e.tie;
        return note;
      });

    const voiceEvent = { duration: dur, notes };
    if (primary.lyric !== undefined) voiceEvent.lyric = primary.lyric;

    voice.push(voiceEvent);
    cursor = pos + primary.duration;
  }

  // Empty voice → whole-note rest
  if (voice.length === 0) {
    voice.push({ duration: "w", notes: [] });
  }

  return voice;
}

export function parseMusicXML(xmlString) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlString, "text/xml");

  const parseError = doc.querySelector("parsererror");
  if (parseError) throw new Error("Invalid XML");

  // --- Metadata ---
  const title =
    doc.querySelector("work > work-title")?.textContent ||
    doc.querySelector("movement-title")?.textContent ||
    "Untitled";
  const artist =
    doc.querySelector('identification > creator[type="composer"]')?.textContent || null;

  // Tempo: find first <sound tempo="..."> anywhere
  let defaultBpm = 68;
  const allSounds = doc.querySelectorAll("sound[tempo]");
  if (allSounds.length > 0) {
    defaultBpm = Math.round(parseFloat(allSounds[0].getAttribute("tempo"))) || 68;
  }

  // --- Parts & staves ---
  const parts = doc.querySelectorAll("part");
  if (parts.length === 0) throw new Error("No parts found in MusicXML");

  const firstPart = parts[0];
  const stavesEl = firstPart.querySelector("attributes > staves");
  const numStaves = stavesEl ? parseInt(stavesEl.textContent) : 1;
  // If first part has only 1 staff and there's a second part, treat as RH + LH parts
  const useTwoParts = numStaves === 1 && parts.length >= 2;

  // --- Parse measures ---
  let divisions = 1;
  let keyFifths = 0;
  let timeBeats = 4;
  let beatType = 4;

  const measureEls = firstPart.querySelectorAll("measure");
  const secondPartMeasures = useTwoParts ? parts[1].querySelectorAll("measure") : null;

  const measures = [];

  measureEls.forEach((measEl, measIdx) => {
    // Update attributes if present in this measure
    const attrs = measEl.querySelector("attributes");
    if (attrs) {
      const d = attrs.querySelector("divisions");
      if (d) divisions = parseInt(d.textContent);
      const t = attrs.querySelector("time");
      if (t) {
        timeBeats = parseInt(t.querySelector("beats")?.textContent) || 4;
        beatType = parseInt(t.querySelector("beat-type")?.textContent) || 4;
      }
      const k = attrs.querySelector("key");
      if (k) keyFifths = parseInt(k.querySelector("fifths")?.textContent) || 0;
    }

    // Parse note events from this measure
    const noteEvents = parseNoteEvents(measEl, divisions);

    // If using two separate parts for RH/LH, merge second part as staff 2
    if (useTwoParts && secondPartMeasures && secondPartMeasures[measIdx]) {
      const part2Attrs = secondPartMeasures[measIdx].querySelector("attributes");
      // Second part might redefine divisions
      let div2 = divisions;
      if (part2Attrs) {
        const d2 = part2Attrs.querySelector("divisions");
        if (d2) div2 = parseInt(d2.textContent);
      }
      const part2Events = parseNoteEvents(secondPartMeasures[measIdx], div2);
      part2Events.forEach((evt) => { evt.staff = 2; });
      noteEvents.push(...part2Events);
    }

    // Separate note events by hand
    const rhEvents = [];
    const lhEvents = [];

    for (const evt of noteEvents) {
      if (evt.isRest) {
        // Assign rest to voice by staff; skip unspecified (gaps filled by buildVoice)
        if (evt.staff === 2) lhEvents.push(evt);
        else if (evt.staff === 1) rhEvents.push(evt);
      } else if (evt.staff === 2 || (evt.staff === 0 && evt.midi < 60)) {
        lhEvents.push(evt);
      } else {
        rhEvents.push(evt);
      }
    }

    const rh = buildVoice(rhEvents, divisions);
    const lh = buildVoice(lhEvents, divisions);

    measures.push({ number: measIdx + 1, rh, lh });
  });

  return {
    title,
    artist,
    defaultBpm,
    key: KEY_NAMES[String(keyFifths)] || "C major",
    timeSignature: `${timeBeats}/${beatType}`,
    measures,
  };
}
