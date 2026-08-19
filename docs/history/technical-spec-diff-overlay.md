# Technical Spec: SAM Diff Overlay (Phase 6)

**Status:** Experimental — this spec deliberately does not commit to a final rendering approach
**Depends on:** Phase 2 (simplifier), the existing fingering overlay machinery
**Scope:** Show what changed between a simplified song and its parent, so a measure that sounds wrong can be found and targeted with a plan edit.

---

## 1. Purpose and method

Most of what the simplifier changes is the left hand, and the change is large — Someone Like You went from 866 LH events to 301. Seeing the original alongside the result is the point of the feature, not a nicety.

**This spec is a sequence of experiments, not a design.** Each milestone produces something on screen, the user screenshots it, and we decide together whether to keep it, adjust it, or move to the next approach. Do not optimise or generalise ahead of that conversation. The cost of trying an approach is low; the cost of building the wrong one thoroughly is not.

**Overlay only.** Stacked scores (rendering the parent as a second full score above the child) are explicitly out of scope for this phase. They remain the fallback if every overlay approach fails. Do not build toward them.

---

## 2. What is already true

Confirmed by research; do not re-derive.

- `ScoreRenderer` (stopped state) and `ScrollEngine` (playback) are mutually exclusive via a ternary in `SamPlayer`. Stopped state is total — nothing re-renders the score on transport changes while stopped.
- `drawFingeringOverlay` draws into its own `<g class="sam-fingering-overlay">` and never touches VexFlow elements. This isolation is a documented invariant and is the pattern to follow.
- `buildGeometry` emits per event: `{ measureNum, hand, index, x, staveTop, staveBottom, noteheadYs[], isRest }`, with `noteheadYs` ordered low pitch to high. Exposed via the `onGeometry` prop.
- `fingeringMode` is plain local state in `SamPlayer`, drives layer-only effects in `ScoreRenderer`, and its button lives in the stopped branch. Overlay mode follows this pattern exactly.
- `useSongLibrary` already groups songs into families by `coalesce(parent_song_id, id)`. Finding the parent is solved; fetching its notation is not.
- `generationNotes` survives import and is on the loaded song object, unnamespaced at the root.

---

## 3. Prerequisites

Three things before any rendering work. Each is small and each is needed by Phase 5 as well.

### 3.1 Resolved per-measure settings in the run report

`buildRunReport` in the simplifier currently stores the plan with ranges as strings (`"37,57-61,68"`). Resolving those to per-measure settings requires `parseMeasureList`, which lives in `tools/sam-tools` and is not in the app bundle.

Add a `resolvedSettings` array to the report: one entry per measure, carrying the effective settings for that measure and whether it was transformed, untouched, unneeded, or unable.

This avoids a second implementation of range parsing in the client. One-line change in Phase 2.

### 3.2 Shared read-only fetch-by-id

`handleLoadFromLibrary` does `select("*").eq("id", …).single()` plus an `isMeasuresStale` check that may trigger `recompileMeasures`. Extract this into a shared helper so a parent song's notation can be fetched without duplicating the staleness logic — skipping it would risk rendering a stale parent blob.

Phase 5 wants the same helper.

### 3.3 Unique note element ids

`ctx.openGroup("sam-note", \`t-${measIdx}-${i}\`)` has no per-instance prefix. Nothing breaks today, but it is invalid HTML and a trap. Add a prefix prop.

---

## 4. Data model

### 4.1 Loading the parent

The parent song is loaded read-only into a second `useState` in `SamPlayer`. The fingering and lyric hooks stay pointed at the primary song and must not be re-keyed.

**Snippet slicing.** `activeMeasures` applies snippet slicing and lyric injection before rendering. The parent's measures must have the identical slice applied or the overlay silently desynchronises. This is the single most likely source of a wrong-looking diff — assert measure numbers match between the two sliced arrays before drawing anything.

### 4.2 The comparison

Per measure, per hand, compute:

**Right hand — a true per-note diff.** Invariant 6 fixes event count and invariant 5 fixes the top note, and thinning only removes notes from within an event. Index alignment is exact and there are never added notes. For each event, compare the parent's note list to the child's; every parent note absent from the child is a removed note at a known event index and a known pitch.

**Left hand — no index correspondence.** Quantization replaces the array wholesale. A pitch present in both is a different event at a different onset with a different duration. Do not fabricate per-note provenance. The comparison here is positional only: every parent LH note has a beat offset and a pitch, and that is all that can be truthfully said about it.

### 4.3 Beat offsets

Ghost positions derive from beat offset, not event index. Walk the parent hand's event array accumulating durations, exactly as the analyzer does. Tuplet events scale by `normal/actual`.

**Open question for M1:** whether `buildGeometry` can expose an x position for an arbitrary beat offset, or whether the layout pass (`applyTimeProportionalLayout`) makes it derivable. Resolve this first — everything downstream depends on it.

---

## 5. Milestones — the experiments

Each produces something on screen. Stop after each and wait for the user's screenshot and verdict.

### M1 — Positioning proof

The narrowest possible test that beat-offset-to-x works.

Draw a faint notehead for every parent LH note in the first four measures of Someone Like You, at its computed x and pitch y. Nothing else — no RH, no annotations, no toggle, no styling beyond a fixed opacity.

**Exit:** the user screenshots measures 1–4. The ghosts should trace the original sixteenth-note arpeggio under the four simplified quarter chords, at visibly correct beat positions.

If x positions are wrong or underivable, stop and report. This is the load-bearing assumption of the whole approach.

### M2 — Full ghost layer, both hands

Extend to the whole song and both hands, in the isolated overlay `<g>`, following `drawFingeringOverlay`.

- Bare noteheads only — no stems, no beams, no flags. There is no rhythm to draw for LH ghosts and drawing one would be a fabrication.
- RH ghosts sit at the same x as their real event, since index alignment is exact.
- An **opacity control** (slider or dial) in the stopped-state UI. This is the primary knob for readability and the user asked for it explicitly.
- **Per-hand toggles**: RH ghosts, LH ghosts, or both. If LH proves too busy at sixteenths while RH stays useful, the user needs to keep one without the other.

**Exit:** screenshots at several opacity levels and hand combinations. The question being answered is whether bare noteheads read as a trace of the original contour or as noise.

### M3 — Annotations

From `generationNotes`, on the same layer:

- `melodyBlips[]` — mark the specific notehead. `{measure, eventIndex, top, drop}` addresses it directly.
- `strippedTies[]` — mark the four re-articulated notes. `{measure, eventIndex, midi, side}`.
- `resolvedSettings` (§3.1) — tint or label measures that ran non-default settings, and measures that were untouched.

These are cheap and independently useful — the blips in particular are the most likely explanation for a measure that sounds off.

**Exit:** the user can find m32 (half grid), m37 and m68 (untouched islands), and the m47 blips without being told where they are.

### M4 — Two-voice experiment

Only if M2 reads poorly, and only after discussion.

Render the parent's hand as a second VexFlow voice in the same stave, drawn faintly, rather than as computed noteheads.

**What this buys:** real rhythm — stems, beams, note values. The original is readable as notation rather than as a contour.

**What it risks:** VexFlow's formatter nudges simultaneous notes apart to avoid collisions, which would displace the real simplified notes to make room for the ghosts. The overlay's value depends on real positions being truthful. It may also fight `applyTimeProportionalLayout`.

Build it on one measure first — Someone Like You m1 — and screenshot before extending. If the real notes visibly shift, the approach is dead and we say so.

---

## 6. Constraints

- **Stopped state only.** No overlay during playback. No scroll sync, no playhead across layers, no re-layout while playing.
- **Never touch VexFlow elements.** All drawing goes into an isolated `<g>`, following the fingering overlay's documented invariant. Playback recolouring must not be able to interfere.
- **Mode toggle follows `fingeringMode`.** Local state in `SamPlayer`, layer-only effects in `ScoreRenderer`, button in the stopped branch. Do not invent a new pattern.
- **No stacking.** Out of scope this phase.
- **No optimisation ahead of the screenshots.** Virtualisation, caching, and generalisation all wait until an approach has been chosen.

---

## 7. What success looks like

The user opens a simplified song, turns on the overlay, and can see what the simplifier removed — well enough that when a measure sounds wrong, they can tell whether the cause is the left hand being thinned too far, a melody blip, a re-articulated tie, or a texture jump at an untouched measure.

The judgement is visual and belongs to the user. No automated criterion substitutes for the screenshot.
