import React, { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import SegmentedControl from "../../sam/components/SegmentedControl";
import { accuracyOf, formatAccuracy } from "../../sam/lib/practiceScoring";
import { clearSave, readSave, writeSave } from "../gameStorage";
import BareStave from "../sightReader/BareStave";
import {
  chordName,
  chordNotes,
  describeChordDifference,
  makePrompt,
  pitchClassName,
} from "../sightReader/music";
import { CHORD_TYPES, chordTypeOf } from "../sightReader/chordTypes";

// Sight Reader — the screen.
//
// NO MUSIC LOGIC LIVES HERE. Which pitch to draw, how a chord is spelled, what
// the wrong answers are, what a chord is called and why the one you picked is
// not the one on the staff are all decided in ../sightReader/music.js and its
// tests. This file draws what it is handed, takes a tap, and keeps count.
//
// TWO LIFETIMES, and mixing them up is the failure mode:
//
//   The SESSION — correct, asked, streak. In memory, gone on reload. It
//   describes this sitting and nothing else.
//
//   The MISS TALLY — how many times each prompt label has been missed, ever.
//   Persisted, because it is what feeds music.js's difficulty weighting, and a
//   drill that forgets what you are bad at every time you close the tab is a
//   drill that never improves.
//
// Both are labelled with their scope on screen. PracticeFigures.jsx records
// what happens when they are not: SAM once showed "Today:" beside "Total:"
// where one was every song and the other was this song, and nobody could read
// either. Accuracy here says "this session" and the missed list says "all
// time", because they sit four lines apart and mean different spans.

const VARIANT_ID = "sight-reader";

// Bump when the stored shape changes. `isValidSave` rejects anything that does
// not match, so an older save is discarded and the weighting starts cold rather
// than a future build crashing on a shape it has never seen.
const SAVE_VERSION = 1;

// How long the answer stays on screen before the next prompt.
//
// A correct answer only has to register, so it is brief. A wrong NOTE has to be
// read — which tile was right, and where it sat — so it lingers. A wrong CHORD
// has an explanation to read and gets no timer at all: the whole point is
// reading it, and any duration would either rush that or stall the drill for
// somebody who has already finished.
const CORRECT_MS = 550;
const WRONG_NOTE_MS = 1500;

// Reset throws away every miss ever recorded, so it asks twice. A second tap
// rather than a modal, because this is a phone and a confirm() dialog for a
// practice game is heavier than the thing it guards.
const RESET_ARM_MS = 4000;

const MOST_MISSED_SHOWN = 6;

// The stave never shrinks on a phone — 360px is wider than the content column
// on any handset, so the cap only bites on a tablet or a desktop, where an
// uncapped SVG would scale to the full 896px of the app's column and stand
// about 580px tall for a single notehead.
const STAVE_MAX_WIDTH = "max-w-[360px]";

const DRILL_OPTIONS = [
  ["notes", "Notes", "Single notes only"],
  ["chords", "Chords", "Chords only"],
  ["mix", "Mix", "An even split of notes and chords"],
];

const CLEF_OPTIONS = [
  ["treble", "Treble", "Treble clef only"],
  ["bass", "Bass", "Bass clef only"],
  ["both", "Both", "An even split of treble and bass"],
];

/**
 * Is this parsed JSON a save this build understands?
 *
 * Handed arbitrary content from any past build — or from a hand-edited
 * localStorage — so it assumes nothing. `gameStorage.readSave` calls it inside
 * its own try, so a throw here would be caught anyway; it is written not to
 * throw regardless, because relying on somebody else's catch is how a validator
 * ends up being the thing that breaks.
 */
function isValidSave(saved) {
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) return false;
  if (saved.version !== SAVE_VERSION) return false;
  const tally = saved.missTally;
  return Boolean(tally) && typeof tally === "object" && !Array.isArray(tally);
}

/**
 * Drop anything in a stored tally that is not a positive whole count.
 *
 * Deliberately per-entry rather than all-or-nothing. `gameStorage`'s own
 * doctrine is that a half-trusted BOARD is worse than no board — a half-drawn
 * position would be unplayable. A tally is not like that: one corrupt entry
 * costs one label's weighting, and throwing away months of accumulated misses
 * over it would be the larger loss. The envelope is still checked whole.
 */
function sanitiseTally(tally) {
  const clean = {};
  for (const [label, count] of Object.entries(tally)) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) {
      clean[label] = Math.floor(count);
    }
  }
  return clean;
}

function loadMissTally() {
  const saved = readSave(VARIANT_ID, isValidSave);
  return saved ? sanitiseTally(saved.missTally) : {};
}

export default function SightReader() {
  const [mode, setMode] = useState("mix");
  const [clefMode, setClefMode] = useState("both");

  // Read once, on the first render of the mount. Any failure — private
  // browsing, cleared cache, corrupt JSON, a save from a future build — comes
  // back as {} and the drill starts with cold weighting, which is a worse drill
  // but still a drill.
  const [missTally, setMissTally] = useState(loadMissTally);

  // Declared after the tally so the very first prompt is already weighted by
  // what was loaded — the drill picks up where the last sitting left off rather
  // than asking one unweighted question first. The lazy initialiser runs only
  // on the first render, when `missTally` is exactly what came off disk.
  const [prompt, setPrompt] = useState(() =>
    makePrompt({ mode: "mix", clefMode: "both", missTally })
  );

  // "asking" until a tile is pressed, then "correct" or "wrong" until the next
  // prompt is drawn. Tiles are inert in anything but "asking", which is what
  // stops a second tap landing on the prompt that has not appeared yet.
  const [status, setStatus] = useState("asking");
  const [picked, setPicked] = useState(null);

  const [asked, setAsked] = useState(0);
  const [correct, setCorrect] = useState(0);
  const [streak, setStreak] = useState(0);

  const [guideOpen, setGuideOpen] = useState(false);
  const [resetArmed, setResetArmed] = useState(false);

  const timerRef = useRef(null);
  const resetTimerRef = useRef(null);

  function clearPending() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }
  function disarmReset() {
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    setResetArmed(false);
  }

  // Neither timer may fire into an unmounted tree, and leaving the Games tab
  // mid-answer is the ordinary way that happens.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (resetTimerRef.current) clearTimeout(resetTimerRef.current);
    },
    []
  );

  // Saved from one place on any change to the tally, rather than from inside
  // each of answer() and reset() — the same reasoning drop.jsx gives for its
  // own save effect: one place cannot fall out of step with the mutators, and a
  // future way of changing the tally is persisted without anyone remembering to
  // add a call.
  //
  // An empty tally is stored as the ABSENCE of a save rather than as an empty
  // object, so Reset genuinely removes the key instead of leaving a husk behind
  // that means the same thing.
  useEffect(() => {
    if (Object.keys(missTally).length === 0) {
      clearSave(VARIANT_ID);
      return;
    }
    // writeSave swallows its own failures, so this catch is a guard against it
    // one day not doing so rather than a live path. Play continues either way;
    // the cost of a failed write is weighting that forgets this session.
    try {
      writeSave(VARIANT_ID, { version: SAVE_VERSION, missTally });
    } catch (e) {
      console.error("[SightReader] Miss tally not saved (play continues):", e);
    }
  }, [missTally]);

  function drawNext() {
    clearPending();
    setPrompt(makePrompt({ mode, clefMode, missTally }));
    setPicked(null);
    setStatus("asking");
  }

  // Reassigned every render so a timer set 1500ms ago draws with the toggles
  // and the tally as they stand when it fires, not as they stood when it was
  // armed. Same "always fresh" idiom as ScoreRenderer's lyricEditRef.
  const drawNextRef = useRef(null);
  drawNextRef.current = drawNext;

  function answer(label) {
    if (status !== "asking") return;
    disarmReset();

    setPicked(label);
    setAsked((n) => n + 1);

    if (label === prompt.label) {
      setCorrect((n) => n + 1);
      setStreak((n) => n + 1);
      setStatus("correct");
      timerRef.current = setTimeout(() => drawNextRef.current(), CORRECT_MS);
      return;
    }

    setStreak(0);
    setStatus("wrong");
    setMissTally((tally) => ({
      ...tally,
      [prompt.label]: (tally[prompt.label] || 0) + 1,
    }));

    // A wrong chord waits for a press. A wrong note moves on by itself.
    if (!prompt.chord) {
      timerRef.current = setTimeout(() => drawNextRef.current(), WRONG_NOTE_MS);
    }
  }

  // Number keys 1-4, for a desktop keyboard. Read through a ref so the listener
  // is attached once for the life of the component rather than re-bound on
  // every prompt. Modified presses are left alone — Cmd-1 switches browser tabs
  // and is not ours to take.
  const liveRef = useRef(null);
  liveRef.current = { prompt, answer };
  useEffect(() => {
    function onKeyDown(e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const slot = Number(e.key);
      if (!Number.isInteger(slot) || slot < 1 || slot > 4) return;
      const live = liveRef.current;
      const label = live.prompt.options[slot - 1];
      if (label) live.answer(label);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Changing either toggle draws a fresh prompt rather than leaving the old one
  // on screen with tiles that no longer match what was asked for. The new value
  // is passed explicitly because the state setter has not flushed yet.
  function changeMode(next) {
    clearPending();
    disarmReset();
    setMode(next);
    setPrompt(makePrompt({ mode: next, clefMode, missTally }));
    setPicked(null);
    setStatus("asking");
  }

  function changeClef(next) {
    clearPending();
    disarmReset();
    setClefMode(next);
    setPrompt(makePrompt({ mode, clefMode: next, missTally }));
    setPicked(null);
    setStatus("asking");
  }

  function onResetPress() {
    if (!resetArmed) {
      setResetArmed(true);
      resetTimerRef.current = setTimeout(() => setResetArmed(false), RESET_ARM_MS);
      return;
    }
    clearPending();
    disarmReset();
    setAsked(0);
    setCorrect(0);
    setStreak(0);
    // The save effect turns an empty tally into a cleared key.
    setMissTally({});
    // Drawn with no tally at all, so the very next prompt is already unweighted
    // rather than still leaning on the counts being thrown away.
    setPrompt(makePrompt({ mode, clefMode }));
    setPicked(null);
    setStatus("asking");
  }

  // SAM's own rule, not a local copy of it: null rather than zero when nothing
  // has been measured, and hits × 100 before the divide so it rounds the way
  // the sam_passes.accuracy_percent column does. `notesPlayed` is SAM's guard
  // for "did anything actually arrive to be scored" — here that is whether a
  // tile has been pressed at all.
  const accuracy = accuracyOf({
    hits: correct,
    misses: asked - correct,
    notesPlayed: asked,
  });

  const mostMissed = Object.entries(missTally)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MOST_MISSED_SHOWN);

  function tileTone(label) {
    if (status === "asking") return "bg-card border-border text-foreground";
    if (label === prompt.label) {
      // Filled when you found it; outlined when you did not, so "this was the
      // answer" never looks like "you got it".
      return picked === label
        ? "bg-success border-success text-success-foreground"
        : "bg-card border-success text-foreground ring-2 ring-success";
    }
    if (label === picked) {
      return "bg-destructive border-destructive text-destructive-foreground";
    }
    return "bg-card border-border text-muted-foreground";
  }

  const wrongChord = status === "wrong" && prompt.chord;
  const chordType = prompt.chord ? chordTypeOf(prompt.chord.quality) : null;
  // Computed by music.js, never written here. Null when there is nothing to say
  // — which the distractor rules make unreachable, since no two of the
  // eighty-four labels describe the same notes, but the panel copes either way.
  const difference = wrongChord ? describeChordDifference(prompt.chord, picked) : null;

  return (
    <div>
      {/* 1. The two toggles. SegmentedControl hides its own text label below
          1280px, which is why each group's options are self-describing. */}
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <SegmentedControl
          label="Drill"
          value={mode}
          options={DRILL_OPTIONS}
          onChange={changeMode}
        />
        <SegmentedControl
          label="Clef"
          value={clefMode}
          options={CLEF_OPTIONS}
          onChange={changeClef}
        />
      </div>

      {/* 2. The stave. White card behind it, because notation is drawn in black
          and the app background is a warm off-white. */}
      <div className="bg-card border border-border rounded-lg p-3 mb-4">
        <div className={`mx-auto ${STAVE_MAX_WIDTH}`}>
          <BareStave clef={prompt.clef} event={prompt.event} />
        </div>
      </div>

      {/* 3. The answer tiles. Two by two, tall enough to hit with a thumb
          without looking, and sitting directly under the stave so reading the
          note and answering it never needs a scroll. */}
      <div className="grid grid-cols-2 gap-2 mb-4">
        {prompt.options.map((label, i) => (
          <button
            key={label}
            type="button"
            disabled={status !== "asking"}
            onClick={() => answer(label)}
            className={`relative min-h-[64px] px-3 py-3 rounded-lg border text-lg font-medium transition-colors ${tileTone(
              label
            )}`}
          >
            {/* The keyboard shortcut, shown only where there is a keyboard. */}
            <span className="hidden sm:block absolute top-1 left-2 text-xs opacity-60">
              {i + 1}
            </span>
            {label}
          </button>
        ))}
      </div>

      {/* The explanation panel. Wrong chords only, and it owns the control that
          moves the drill on — nothing else advances while it is open. */}
      {wrongChord && (
        <div className="bg-card border border-border rounded-lg p-4 mb-4">
          <div className="font-medium text-foreground">
            {prompt.label} — {chordType.name}
          </div>
          <div className="text-sm text-muted-foreground mt-1">
            On the staff: {prompt.event.notes.map((n) => n.name).join(" · ")}
          </div>
          <p className="text-sm text-foreground mt-3">{chordType.description}</p>
          {difference && (
            <p className="text-sm text-destructive mt-3">{difference}</p>
          )}
          <button
            type="button"
            onClick={drawNext}
            className="w-full min-h-[44px] mt-4 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium"
          >
            Next chord
          </button>
        </div>
      )}

      {/* 4. The scoreboard. One line, in the wording StatsBar already uses for
          the same kind of figures — and naming its own scope, because the
          missed list below it spans something different. */}
      <div className="flex items-center justify-center gap-4 flex-wrap text-sm text-muted-foreground mb-4">
        <span className="font-medium text-foreground">This session</span>
        <span>
          Accuracy{" "}
          <strong className="text-foreground">{formatAccuracy(accuracy)}</strong>
        </span>
        <span>
          Correct{" "}
          <strong className="text-foreground">
            {correct}/{asked}
          </strong>
        </span>
        <span>
          Streak <strong className="text-foreground">{streak}</strong>
        </span>
      </div>

      {/* 5. What is being missed — the PERSISTED tally, not this sitting's.
          This is the list the weighting acts on, so showing anything else would
          put a list on screen that disagrees with which prompts keep coming
          back. Chips rather than rows, so six cost one or two lines. */}
      {mostMissed.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-medium text-foreground mb-2">
            Most missed{" "}
            <span className="font-normal text-muted-foreground">
              — all time, and asked more often
            </span>
          </h3>
          <div className="flex flex-wrap gap-2">
            {mostMissed.map(([label, count]) => (
              <span
                key={label}
                className="px-2 py-1 rounded bg-card border border-border text-sm text-foreground"
              >
                {label} <span className="text-muted-foreground">×{count}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* 6. The chord guide. Collapsed by default and last on the page — it is
          reference, not part of the loop. Same disclosure pattern as the Games
          tab's "Earlier versions". */}
      <div>
        <button
          type="button"
          onClick={() => setGuideOpen((open) => !open)}
          aria-expanded={guideOpen}
          className="w-full text-left px-1 py-2 min-h-[44px] flex items-center justify-between gap-3 text-sm text-muted-foreground"
        >
          <span>Chord guide ({CHORD_TYPES.length} types)</span>
          <ChevronDown
            className={`w-4 h-4 shrink-0 transition-transform ${
              guideOpen ? "rotate-180" : ""
            }`}
          />
        </button>

        {guideOpen && (
          <div className="space-y-2 mt-2">
            {CHORD_TYPES.map((type) => (
              <div
                key={type.id}
                className="p-3 bg-card border border-border rounded-lg"
              >
                <div className="font-medium text-foreground">
                  {type.name}
                  {/* Written on C, spelled by the same function that spells a
                      real prompt — so the guide cannot drift from the game. */}
                  <span className="text-muted-foreground font-normal">
                    {" "}
                    — {chordName("C", type.id)}:{" "}
                    {chordNotes("C", type.id, 4)
                      .map((n) => pitchClassName(n.name))
                      .join(" ")}
                  </span>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  {type.description}
                </p>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Reset, last of all. It throws away every miss ever recorded, so it is
          out of the way of a thumb working the tiles, and it asks twice. */}
      <div className="mt-6 pt-4 border-t border-border">
        <button
          type="button"
          onClick={onResetPress}
          className={`w-full min-h-[44px] px-4 py-2 rounded-lg border text-sm font-medium transition-colors ${
            resetArmed
              ? "bg-destructive border-destructive text-destructive-foreground"
              : "bg-card border-border text-muted-foreground"
          }`}
        >
          {resetArmed ? "Tap again to clear everything" : "Reset"}
        </button>
        <p className="text-xs text-muted-foreground mt-2 text-center">
          Clears this session and the all-time miss tally, on this device.
        </p>
      </div>
    </div>
  );
}
