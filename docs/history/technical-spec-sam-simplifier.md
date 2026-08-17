# Technical Spec: SAM Song Simplifier (Phase 2)

**Status:** Ready for implementation
**Depends on:** Phase 0 (complete export format), Phase 1/1.5 (analyzer + calibrated thresholds)
**Scope:** A local Node CLI subcommand that reads an exported song JSON plus a plan JSON and writes a new song JSON. No database writes. No Edge Function. The user imports the output through the SAM UI.

---

## 1. Purpose

Take a song that is too hard and produce a version at the user's current playing level, by mechanically thinning the accompaniment while leaving the melody untouched.

The calibrated target band, derived from four real pieces at the user's working tempos (Phase 1.5):

| metric | comfortable |
|---|---|
| notes per second | under 5 |
| LH notes per beat | around 1, never above 3 |
| RH notes at once | 1 |
| rhythm variety | 2–3 distinct duration tokens |

**The safety property that governs the entire design:** Claude selects from a fixed enum of settings. The code writes every note. Claude never emits notation. Any feature that would let a language model specify pitches directly is out of scope and should be refused rather than implemented.

---

## 2. Command

```
npm run simplify -- <song.json> --plan <plan.json> -o <out.json>
```

Required flags:

- `--plan <file>` — the plan
- `-o <file>` — the output document
- `--bpm <n>` — quarter notes per minute, used for the before/after metrics (§8) and the regression check (§6). Deliberately NOT read from `defaultBpm`: stored tempos are unreliable (docs/song-export-format.md §7).

Optional flags:

- `--yes` — skip interactive confirmations (see §7)
- `--report <file>` — write the machine-readable run report separately from stdout

Reads two files, writes one. Never touches the network or the database.

Reuse `lib/durations.js` for all duration math and `lib/analyze.js` for the pre/post comparison (§8). Do not reimplement either.

---

## 3. Plan format

A plan is a complete description of the desired output, not a patch. Every version is generated from the ORIGINAL song, never from a previous version. This is what makes tweaks compose and prevents cumulative degradation.

```json
{
  "planVersion": 1,
  "sourceSongId": "030333d9-1b9f-4f74-80fb-7fbed587fda6",
  "label": "melody only · quarter chords",
  "default": {
    "lhGrid": "quarter",
    "lhFill": "onset",
    "lhCap": 2,
    "lhKeep": "root-third",
    "rhStack": "melody-only"
  },
  "ranges": [
    { "measures": "37,57-61,68,79-82", "settings": null },
    { "measures": "32", "settings": { "lhGrid": "half" } }
  ]
}
```

The `32` range is not decoration — without it the run fails the §6 regression
check. See §4.1's note on jump.

### 3.1 Field semantics

| field | required | meaning |
|---|---|---|
| `planVersion` | yes | integer, currently `1` |
| `sourceSongId` | **yes** | the parent song's id. Nothing is fetched with it — the simplifier never touches the database — but §9 emits `songType: "simplified"`, which requires a parent both there and in the database (`sam_songs_lineage_check`). A plan without one can only produce a document the UI rejects, so it is refused at write time rather than written. |
| `label` | no | free text. Used as the output song title suffix when present |
| `default` | yes | settings applied to every measure not covered by a range |
| `ranges` | no | array of overrides |

Each range entry:

- `measures` — a string of comma-separated played measure numbers and inclusive ranges, e.g. `"37,57-61,68"`. **Played** numbers (SAM's `number`), not printed (`sourceMeasure`).
- `settings` — either `null` (meaning **leave these measures untouched**) or a partial settings object that overrides `default` for those measures only.

### 3.2 Validation

Write `plan.schema.json` next to the code and validate every plan before running. An unknown setting key or an unknown enum value is a **hard error**, not a warning. This is the primary defence against vocabulary drift.

Additional checks, all hard errors:

- A measure number appearing in more than one range (overlaps are rejected; do not resolve by order)
- A measure number outside the song's range
- A malformed range string

---

## 4. Settings vocabulary

This is the fixed enum. Adding a value later is additive and safe; the schema must reject anything not listed.

| setting | values | default | kind | meaning |
|---|---|---|---|---|
| `lhGrid` | `none`, `whole`, `half`, `quarter`, `eighth` | `none` | gating | Cell size for LH quantization |
| `lhFill` | `onset`, `union` | `onset` | modifier (`lhGrid`) | Which pitches fill a cell |
| `lhCap` | integer 1–4 | `2` | modifier (`lhGrid`) | Max notes per LH event after fill |
| `lhKeep` | `root-third`, `root-fifth` | `root-third` | modifier (`lhGrid`) | Which notes survive the cap |
| `rhStack` | `all`, `melody-plus-one`, `melody-only` | `all` | gating | RH thinning |

**Gating vs modifier settings.** The vocabulary splits in two, and the split
determines what an omitted key means.

*Gating* settings decide WHETHER a transform runs. **Absent means off** —
`lhGrid` defaults to `none` and `rhStack` to `all`.

*Modifier* settings decide HOW an already-active transform behaves. They keep
their defaults, but take effect only when their parent gating setting is
active. A modifier present without its parent active is **inert, not an
error**: `{"lhFill": "union"}` with no `lhGrid` is accepted and simply does
nothing.

The consequence is that `default: {}` is a true identity transform.

The reason to prefer this over "absent takes the value in the table" is
asymmetry of failure. Under the other reading, a plan that omits `rhStack`
would strip the right hand to melody-only without being asked — silently
applying the one transform that touches the melody. Under this reading the
failure mode is a version that is not simplified enough, which shows up
immediately in the metrics and costs one edit to fix. Under-transforming is
visible; over-transforming silently is not.

This does not weaken §3's "a plan is a complete description" principle. That
principle is about plans being regenerated from the original rather than
chained onto a previous version; it is not a requirement that every key be
spelled out.

### 4.1 `lhGrid` — quantization

Divide the measure into cells of the given size. Emit one event per cell. This is grid quantization, **not** event merging: the duration vocabulary is not closed under addition, so merging can produce unwritable durations. Cells are always representable and always sum correctly.

**Density floor (non-negotiable).** The grid may only ever REDUCE the number of LH events in a measure. If a measure's LH already has fewer onsets than the grid would produce, leave that hand untouched for that measure. A sustained whole-note bar must not become four repeated quarter chords.

**Reducing LH event count can RAISE max jump, even where the music becomes easier.** This is a property of the transform, not a defect. Someone Like You m32 is the worked example: the original arpeggio climbs D2 → A2 → D3 → F#3 in steps of at most 7, but at quarter grid only four events remain and the bottom-note line steps D2 → F#3 directly — 16 semitones.

The cause is NOT that the cell start lands on a passing note; cells 1–3 land correctly on the root D2, and F#3 genuinely is the pitch sounding at beat 3, tied over from 2.75. What happens is that thinning removes the INTERMEDIATE RUNGS of the arpeggio ladder. Both fills behave identically here, so it is not a `union` problem.

The metric is honest: that leap is real and the player has to make it. The remedy is a coarser grid on that measure, per §11 — a setting, not an escape hatch. At `half` grid m32 becomes two cells, both D2, so jump is 0 and the measure still drops from 13 events to 2.

**Why the rung was lost decides the remedy, and the obvious symmetry is wrong.**

**Coarser can fix it, when the surviving cells land on a repeated root.** Someone Like You m32: at `half` grid both cells are D2, so the leap disappears entirely and the measure still drops from 13 events to 2.

**Finer usually cannot, even when the line is walking — and this is the case to read carefully, because it looks like it should work.** The Entertainer's stride bass steps downward every eighth; in 2/4 a `quarter` grid gives only two cells and drops every second eighth, so m36's `48 → 43 → 36` (max step 7) becomes `48 → 36` (12), and fifteen measures regressed this way. The diagnosis is right and the inference from it is not: **a finer grid only helps if the grid still has something to remove.** The stride bass is *already written in eighths*, so an `eighth` grid hits the density floor on **147 of 152 measures**, and every LH difficulty metric comes out identical to the original. The §6 confirmation prompt says so directly:

```
song-level, the same metrics:
  LH jump        median 12 → 12   p90 17 → 17   max 24 → 24   (worse on 2 measures)
```

It cleared 11 of the 15 regressions by not transforming. LH sounding events fell only 592 → 580; five measures moved. Measured against `quarter` at 90 BPM:

| grid | regressions | LH jump med/p90/max | LH notes/beat | flagged |
|---|---|---|---|---|
| original | — | 12/17/24 | 2/2/4 | 146/152 |
| `quarter` | 15 | **5/12/15** | **1/1/1** | **122/152** |
| `eighth` | 4 | 12/17/24 | 2/2/2 | 141/152 |

**A low regression count is not the objective.** `quarter` is better on every LH metric and on flag count; it simply reports what it cost. `eighth` buys its clean-looking report by declining to act. Prefer the grid with the better metrics and read its regression list, over the grid with the shorter list and no effect.

So: reaching for `half` on The Entertainer would be wrong, and reaching for `eighth` does nothing. When a walking line regresses on jump, the honest options are to accept it against the song-level figures, or to narrow that measure with a range — not to refine the grid.

**`lhCap` and `lhKeep` do not apply when the density floor declines a measure.** They run on the output of fill, so a measure the grid left alone keeps its original stacks — that is why the `eighth` run left LH stack at **4** despite `lhCap: 2`. The cap is not an independent setting today; it is a stage of quantization.

**Candidate setting, not built.** A plan that wants to cap chord size WITHOUT quantizing rhythm cannot express it. The Entertainer is the live case: its LH rhythm is fine and its chords are not. Recorded so the gap is known — do not add it without a song that needs it and a measurement showing the cap alone helps.

**Tuplets.** If a cell boundary would fall inside a tuplet group, leave that group's span unquantized and grid around it. On the current corpus this never fires for LH — all 22 tuplet groups in Someone Like You are RH, one beat long, starting on a beat — but the guard must exist.

### 4.2 `lhFill` — which pitches go in a cell

- `onset` (default): the pitches sounding at the START of the cell. If nothing sounds at the cell start (the cell begins mid-note or on a rest), fall back to the pitches of the nearest preceding onset that is still sounding; if there are none, emit a rest.
- `union`: all distinct pitches sounding anywhere in the cell.

`onset` is the default because `union` emits chords that never sounded together in the original. **Settled by measurement, not provisional.** On Someone Like You with the reference plan, measured through the real engine by the §6 regression check:

| fill | regressions | breakdown |
|---|---|---|
| `onset` | **1** | LH jump, m32 |
| `union` | **95** | LH stack ×47, LH stretch ×47, LH jump ×1 |

`union` raises LH stack from 1 to 2 and LH stretch from 0 to 4–7 across 47 measures — it is putting a second note under the hand where there was one. An earlier draft of this section recorded the harm as "LH jump worse, 16 vs 12"; that came from hand-prototyping and was wrong in both magnitude and kind. The m32 jump regression is shared by BOTH fills and is not `union`'s fault (see §4.1).

### 4.3 `lhCap` and `lhKeep`

After fill, if an event has more notes than `lhCap`, drop notes until it fits:

- `root-third`: keep the lowest `lhCap` notes
- `root-fifth`: keep the lowest note and the highest note (only meaningful at `lhCap: 2`; at higher caps, keep lowest, highest, then fill inward from the bottom)

### 4.4 `rhStack` — RH thinning

- `all`: no change
- `melody-plus-one`: keep the highest note and the next highest
- `melody-only`: keep the highest note only

**The melody rule (invariant).** The highest-pitched note of every RH event is ALWAYS retained. Determine it by `max(midi)`, never by array position — assert that the array is pitch-ascending and hard-error if it is not.

**Melody blips.** The analyzer detects RH events where the top note dips 5+ semitones below both neighbours and returns — voice-merge artefacts where the highest note briefly is not the tune. The simplifier does NOT correct these. It takes the top note as always, and reports every blip in the run report so the user knows where to listen.

**Event count is never changed.** RH thinning removes notes from within an event; it never removes an event. This is what keeps `rh_index` stable and lyrics intact.

---

## 5. Invariants

Assert all of these on output. A violation is a hard error, not a warning.

1. Measure count identical to input
2. Every measure's `timeSignature` identical
3. Every measure's `audioOffsetMs` identical, including nulls preserved as nulls
4. Per-hand summed duration per measure identical to input (tuplet-scaled via `durations.js`)
5. Every RH event's highest note identical to input (melody rule)
6. RH event count per measure identical to input
7. No tie chain left with an unmatched start or end, EXCEPT at a seam (a `sourceMeasure` discontinuity), which is legitimate
8. `chord`, `section`, `sourceMeasure`, `carriedTags` passed through verbatim

### 5.1 Ties

Where a transform removes a note that participates in a tie chain, **the whole chain is removed** — never half a chain. Quantized hands do not have this problem: cell-fill discards old events entirely, so in practice this applies to RH thinning only.

**Mixed chains: the melody rule wins.** Where a chain is *mixed* — the tied pitch is the top note of one event and an inner voice of another — keep the note and drop the **tie marker**, producing a re-articulation. A tie is a rendering instruction, "hold rather than re-strike", not a note. Dropping the marker means the pitch still sounds, just articulated again; dropping the note would remove melody, which violates the invariant that actually matters. Every stripped tie is reported in `strippedTies`.

> This was a genuine conflict between §4.4 (the melody rule: the highest note of every RH event is always retained) and §5.1 as originally written (a chain is removed whole). Both cannot hold when a chain is mixed. **Resolved in favour of §4.4** — settled 2026-08-13, and recorded here so it is not re-litigated. Someone Like You has four such chains, at m22, m27, m46 and m69.

Ties are handled as **links** rather than whole chains: a note marked `both` is the end of one link and the start of the next, so breaking one side leaves the other intact (`both` becomes `start` or `end`). This is what makes a dangling marker structurally impossible, which is the property this section is really asking for.

### 5.2 Lyrics and fingerings

Both are keyed on `rh_index`. Because RH event count is invariant (§4.4), indices are stable and both pass through unchanged.

If a future transform is added that changes RH event count, it must hard-error when applied to a measure carrying lyrics or fingerings.

---

## 6. Regression check

After transforming, run `lib/analyze.js` on both input and output at the same tempo and compare per measure.

**If any metric is worse in the output than in the input for any measure, report the measure, the metric, and both values.** A transform that fixes three metrics while degrading a fourth is not acceptable silently.

This is not theoretical — it was caught in prototyping, where `union` fill raised LH jump above the original.

**The detection is absolute; the consequence is a confirmation, not a refusal.** An earlier draft made this a hard error that exited without writing. That was wrong for the same reason §7 settled the `unable` case: a bad result that can be heard and archived beats a result the tool refuses to produce. Print every regression, print the song-level context below, ask once, write on approval. `--yes` bypasses. The `unable` prompt and this one share a single question — being asked twice about one run is worse than being asked once about two things.

Two findings forced the change, both from The Entertainer at `quarter` grid:

**The check is per-measure and absolute, so it cannot see the song.** It fired on fifteen bars for LH jump while the song's LH jump median fell from 12 to 5, p90 from 17 to 12, and max from 24 to 15. The list said "fifteen measures got worse"; the truth was "the median measure's worst leap halved". **The summary printed alongside the regression list must therefore include before/after median, p90 and max for each affected metric**, so the local damage can be weighed against the global result. `formatRegressionContext` reads these from the run report's existing metrics block rather than re-analysing.

**`lhJump` gates writes but has no flag threshold.** `THRESHOLDS` has no entry for it, so no measure is ever flagged for jump — yet a jump regression blocked an entire song. m1 going 4 → 5 is noise by any standard. A metric absolute enough to refuse a run should be one the analyzer is willing to call difficult in the first place; until jump has a threshold, it has no business being a hard error.

The check itself is unchanged and stays deliberately sensitive — it is finding real things, and every regression is recorded in the run report as well as printed, so an approved-anyway run still carries its own evidence.

---

## 7. Skip-and-flag, and confirmation

When a transform does not run on a measure, **leave that measure at original difficulty and record why.** Do not fail the run. Do not skip silently.

There are two distinct reasons, tracked in two separate counters. Conflating them was a mistake in an earlier draft of this spec.

**`unable`** — the transform could not run cleanly: a tuplet in an awkward position, a tie that will not resolve, an unexpected shape. The measure stays harder than the plan asked for. This is the counter that matters, because something the user wanted did not happen.

**`unneeded`** — a guard correctly declined to act because the measure did not need the transform. The density floor (§4.1) refusing to turn a sustained whole-note bar into four repeated quarter chords is the canonical case. Nothing was left too hard and nothing went wrong.

**Confirmation threshold.** If more than 25% of measures are **`unable`**, print the list and ask for confirmation before writing the output. The user explicitly wants to be able to hear a bad result rather than be blocked by it. `--yes` bypasses the prompt. Never hard-fail on either count. §6's regression check now shares this prompt on the same reasoning.

`unneeded` is reported and never gates anything. On the reference plan the density floor accounts for 23 of 82 measures — 28% — and prompting for that would be asking the user to confirm that the tool worked.

**`unable` and `unneeded` are PER-HAND lists; the terminal tally is PER-MEASURE, and there is only one place it is computed.** The two answer different questions and must not be derived from each other. A measure whose LH hits the density floor is `unneeded` in that list while the measure as a whole is `transformed`, because its RH was still thinned — on The Entertainer at `eighth` grid that is 147 LH declines against 119 measures that changed.

Deriving the tally arithmetically, as `total − untouched − unable − unneeded`, was wrong in both directions and shipped that way:

| run | derived (wrong) | actual |
|---|---|---|
| The Scientist, `default: {}` | transformed 73 | **transformed 5**, unneeded 68 |
| The Entertainer, `eighth` | transformed 5 | **transformed 119**, unneeded 33 |

The cause is that `simplifyMeasures` only pushes to those arrays when a transform actively declines. A plan with an empty default reaches neither branch, so nothing is recorded and the subtraction reports the whole song as transformed; conversely an LH-only decline was subtracted from a total that RH thinning had already changed. `statusCounts(resolvedSettings)` is now the only accounting path, and its four buckets are exclusive and sum to the measure count — because `resolvedSettings` decides each status by comparing the actual output rather than by inferring from counters. §6's confirmation threshold reads the same tally, so the number on screen and the number in the prompt cannot disagree.

---

## 8. Run report

Written into the output document's `generationNotes` as **structured JSON**, not prose, so a future UI can read it without parsing English. Also printed to stdout in human-readable form.

```json
{
  "plan": { ...the full plan as applied... },
  "analyzerTempo": 67,
  "unable": [ { "measure": 44, "hand": "lh", "reason": "tuplet crosses cell boundary" } ],
  "unneeded": [ { "measure": 79, "hand": "lh", "reason": "density floor: grid would not reduce LH event count" } ],
  "melodyBlips": [ { "measure": 47, "rhIndex": 6, "semitones": -11 } ],
  "shortUntouchedRuns": [ { "measures": [37], "length": 1 } ],
  "repeatedRanges": [ { "range": "22-32", "alsoAppearsAt": ["46-55", "69-78"] } ],
  "metrics": { "before": { ... }, "after": { ... } }
}
```

### 8.1 Advisory reports

Three things are reported but never acted on automatically:

- **Short untouched runs** — an untouched stretch shorter than 3 measures creates a texture jump. m37 in Someone Like You is the canonical case. Report it; the user decides.
- **Repeated ranges** — when a plan range covers measures whose `sourceMeasure` values also appear elsewhere in the song, report the other locations. Ranges are applied LITERALLY; this is information, not expansion. In Someone Like You the only repeat is printed 46–54, played at **46–54 and again at 69–77** (the D.S.; played 78 is printed 69). Note that identical *metric* rows are not evidence of repetition — only `sourceMeasure` is.
- **Melody blips** — as §4.4.

---

## 9. Output document

A valid song export document per `docs/song-export-format.md`, ready to import through the SAM UI unmodified.

- `title`: original title, plus the plan's `label` in parentheses when present
- `songType`: set to indicate a generated version
- `parentSongId`: the source song's id
- `generationNotes`: the run report (§8)
- `sourceXmlPath`: inherited from the source
- `key`, `fifths`, `defaultBpm`, `artist`: inherited unchanged

---

## 10. Success criteria

The user imports the output into SAM and plays it. Their ear is the final oracle; no automated check substitutes for it.

Mechanical criteria for Someone Like You (`030333d9-1b9f-4f74-80fb-7fbed587fda6`) at 67 BPM with the reference plan (§3):

- All §5 invariants hold
- The regression check is clean
- Post-transform metrics: notes/sec median around 3.6 and max around 5.3; LH notes/beat median 1.0; RH stack 1 in every transformed measure (untouched measures keep their original chords by definition)
- **Every remaining flag is on the melody, and no setting in the vocabulary could reduce it.** On the reference plan that is 25 measures: six flagging notes-per-second (m17, 18, 19, 41, 42, 43) and nineteen flagging RH rhythm variety. RH rhythmic variety is untouchable by design — `rhStack` removes notes from within an event and never changes a duration. A flag on anything OTHER than the melody is a defect.
- The **eleven** measures the plan leaves untouched (37, 57, 58, 59, 60, 61, 68, 79, 80, 81, 82) are bit-identical to the original. m58 is in the set by range membership — `57-61` covers it — not because it is comfortable; it flags VAR. Harmless, and the plan is correct as written.

**Expected residual:** measures 17, 18, 19, 41, 42, 43 will still flag on notes-per-second. Their LH is already at 1 note per beat and their RH is a fast single-note melody — that is the tune itself, and no transform in the vocabulary can reduce it without breaking the melody rule. This is correct behaviour, not a defect.

---

## 11. Out of scope

- Database writes of any kind. Output is a file; the user imports it.
- Edge Function port (Phase 3/4)
- Any UI (Phases 5–7)
- Per-note or per-chord manual overrides. Requested and deliberately declined: it would break the safety property in §1 and the regeneration model in §3. The correct answer to "I want one chord changed" is a one-measure range. If that proves insufficient in practice, the response is to add a SETTING, not a notation escape hatch.
- Automatic smoothing of melody blips, texture jumps, or short untouched runs. All three are reported only.
