# Technical Spec: Difficulty Analyzer in Supabase (Phase 3)

**Status:** Ready for implementation
**Depends on:** the CLI analyzer (`tools/sam-tools/lib/analyze.js`), calibrated Phase 1.5, and the goal-tempo columns on `sam_songs`
**Scope:** Port the analyzer to a Deno Edge Function, store per-measure tempo-independent scores in a new table, expose a read-only MCP tool, and keep scores fresh automatically.

---

## 1. Purpose

Difficulty analysis currently requires exporting a song to a file and running a CLI. This puts it in the database so that any measure's difficulty is available to a conversation, to the practice-plan project, and eventually to the app — without a manual export.

**What this is not.** The simplifier stays local (Phase 4). This phase moves analysis only.

---

## 2. The governing distinction: tempo-independent vs tempo-dependent

Of the analyzer's metrics, **exactly one depends on tempo**: `notesPerSecond`. Everything else — stack, stretch, jump, notes-per-beat, rhythm variety, accidentals — is a pure function of the notes.

Consequences that shape the whole design:

- **Store tempo-independent facts only.** `notesPerSecond` is computed on read as
  `(rhOnsets + lhOnsets) / (beats * 60 / bpm)` — exact, not an approximation.
- **Never store flags.** One of the five thresholds gates a tempo-dependent metric, so a stored flag is only valid at the tempo it was computed at. Flags are derived on read against the current `THRESHOLDS`.
- **Thresholds stay in code.** They are calibration, not data. A stored flag set can disagree with current thresholds; a derived one cannot.

---

## 3. Which tempo

The analyzer takes one number. The caller resolves it. The resolution order is:

1. An explicit `bpm` argument
2. `sam_songs.goal_effective_bpm`
3. Error — never a silent fallback

**`goal_bpm` is never read directly, and neither is `default_bpm`.** This matters and needs a comment at the resolution site:

- `default_bpm` drifts. It is whatever the tempo box was last saved at, not a target.
- `goal_bpm` is misleading on audio-backed songs. There, `default_bpm` is a scroll-sync calibration and `goal_bpm` is forced equal to it, with the real goal expressed through `goal_playback_speed`. Reading `goal_bpm` on those songs yields a plausible number that is wrong — the worst failure mode, because nothing errors.
- `goal_effective_bpm` is `round(goal_bpm * goal_playback_speed / 100)` and is correct for both cases.

BPM throughout SAM means **quarter notes per minute**, verified against the playback clock and session durations. A 6/8 bar is 3.0 quarter beats. Do not introduce a second convention.

---

## 4. Milestones

### M1 — Port the analyzer to Deno

`supabase/functions/_shared/durations.ts` already exists as a partial TS port with `BASE`, `tokenToBeats` and `sumEvents`, but **no `measureBeats`**. Add it.

Then port `analyze.js` to `_shared/` alongside it. The Edge Function deploy bundles only `supabase/functions/**`, so `tools/sam-tools/lib/durations.js` cannot be imported — it must be vendored, as `durations.ts` already is.

**Parity is the exit criterion, and the existing parity test is too weak.** It compares only the `BASE` map across two copies. Extend it to cover every exported function across all four copies:

- `tools/sam-tools/lib/durations.js` (the original; nothing currently tests it)
- `src/sam/lib/durations.js` (superset, adds timeline helpers)
- `tools/sam-tools/vendor/durations.js` (synced copy of `src`)
- `supabase/functions/_shared/durations.ts`

**Exit criteria**
- [ ] The ported analyzer produces byte-identical output to the CLI on all four reference songs: Someone Like You (82 measures), Say It Ain't So (160), The Entertainer (152), The Scientist (73)
- [ ] Parity test covers every shared function, not just `BASE`
- [ ] Round-trip a document with tuplets and confirm beat math matches — Someone Like You has 22 tuplet groups

A rounding difference here costs a day of confusion later. Compare numerically, not by eye.

---

### M2 — Label unclosed tie starts as seam or orphan

Unmatched tie ENDS are already split into `seam` and `orphan`. Unclosed tie STARTS are not, and all six currently reported across the corpus are genuine volta seams — which means six legitimate ties would be stored looking like six defects.

The cause: `findSeams` does `parseInt(sourceMeasure)`, and MuseScore emits `X1`–`X4` for second-ending brackets, so `parseInt("X2")` → NaN and the pair is skipped.

**Preferred fix:** reuse `validate.js`'s `volta_seam_tie` classification rather than writing a second rule. It already identifies exactly these correctly. Same argument that made `verify.js` import `noteDuplicates.js` — two implementations of one rule will drift.

**Fallback if that rule isn't cleanly extractable:** treat a non-numeric `sourceMeasure` on either side of a measure pair as a seam. MuseScore only emits those for ending brackets, so the heuristic is tight.

**Exit criteria**
- [ ] The Entertainer's 5 unclosed starts are all labelled `seam` (rh m67 E4/C5, rh m151 E4/G4/C5)
- [ ] Someone Like You's 1 unclosed start at rh m77 A3 is labelled `seam`
- [ ] A synthetic orphan away from any seam is still labelled `orphan`
- [ ] No song in the corpus reports an unexplained orphan

---

### M3 — The scores table

```sql
create table public.sam_song_scores (
  song_id               uuid not null references public.sam_songs(id) on delete cascade,
  measure_number        integer not null,
  ...
  primary key (song_id, measure_number)
);
```

**Key on `(song_id, measure_number)`, never on a `sam_song_measures.id`.** `fanOutMeasures` deletes every row for a song and reinserts on each import, so row ids change. A foreign key to rows with cascade would silently wipe the scores. `measure_number` is also what snippets and simplifier plans use.

Columns, all tempo-independent:

| column | meaning |
|---|---|
| `beats` | measure length in quarter-note beats |
| `rh_onsets`, `lh_onsets` | sounding events per hand (rests excluded) |
| `rh_stack`, `lh_stack` | max simultaneous notes in one hand |
| `rh_stretch`, `lh_stretch` | max semitone span within one chord event |
| `rh_jump`, `lh_jump` | max semitone move between consecutive events (top note RH, bottom note LH) |
| `rhythm_variety` | distinct duration tokens per hand, max of the two |
| `accidentals` | note occurrences outside the key; null when `fifths` is null |

Plus provenance:

| column | meaning |
|---|---|
| `scores_version` | integer. Bumped whenever the analyzer's metric definitions change. `rhythmVariety` has already changed once (pooled → per-hand); without this you cannot tell which rows predate a fix |
| `computed_from_edited_at` | the `sam_songs.measures_edited_at` value these scores were computed from |
| `computed_at` | timestamptz |

**Staleness is an equality check, not a timestamp comparison.** Store the `measures_edited_at` value the scores came from and compare it for equality with the current one. `isMeasuresStale` compares two timestamps, which are client clocks from different machines; equality avoids that entirely.

**Platform layer.** This table has no `user_id` — it reaches ownership through `sam_songs`. So:

```sql
select platform.register_table(
  'public.sam_song_scores',
  p_policy_mode => 'none',
  p_audited     => false,
  p_exempt      => false,
  p_notes       => 'SAM: per-measure difficulty metrics, tempo-independent. Derived — safe to delete and recompute.'
);

create policy sam_song_scores_owner on public.sam_song_scores for all to authenticated
  using (exists (
    select 1 from public.sam_songs s
     where s.id = sam_song_scores.song_id and s.user_id = auth.uid()
  ));
```

`p_audited => false` is deliberate and worth stating in the notes: these rows are **derived**, recomputed wholesale, and carry no user intent. Auditing them would log thousands of rows that say nothing a re-run could not reproduce. This is the "high-volume append-only telemetry" carve-out, and it should be justified rather than assumed.

Add column comments — conformance checks them.

**Exit criteria**
- [ ] `check_platform_conformance()` returns `CONFORMANT`
- [ ] Deleting a song cascades its scores away
- [ ] A second user's scores are invisible under RLS

---

### M4 — Compute and store

An Edge Function that, for a given song: reads its measures, runs the ported analyzer, replaces that song's score rows, and stamps `computed_from_edited_at`.

- **Replace wholesale, per song.** Delete then insert inside one transaction. Scores are derived; incremental updates buy nothing and add a way to be half-right.
- **Skip when fresh.** If `computed_from_edited_at` equals the song's current `measures_edited_at` and `scores_version` matches, do nothing.
- **Backfill** every non-archived song with measures.

**Exit criteria**
- [ ] All songs with measures have scores
- [ ] Recomputing an unchanged song is a no-op
- [ ] Stored values for the four reference songs match the CLI exactly — compare numerically, per measure, per column
- [ ] Editing a measure then recomputing produces different scores for that measure and identical scores for every other

---

### M5 — The read tool

Tier 1, per the platform rules. `ctx.db` only; no Supabase import in the tool file.

```
get_sam_song_scores(song_id, start_measure?, end_measure?, bpm?, limit?)
```

Returns per measure: the stored metrics, plus `notes_per_second` and `flags` computed at the resolved tempo. Plus a rollup over the returned range: median, p90 and max of every metric, and the flagged measure list.

Requirements:

- **Resolve tempo per §3**, and return the tempo used and where it came from (`argument` / `goal`) so a reader can never mistake a default for a choice.
- **Recompute if stale**, or return what is stored with an explicit staleness marker. Pick one and document it; do not silently return stale numbers.
- **Push every filter into the query before `.limit()`.** A measure-range filter applied in memory after a cap returns a biased subset with no signal.
- `clampLimit` (default 20, cap 50). A 160-measure song will truncate — the `NOTE: results truncated` block is how the caller learns that, so do not suppress it. Consider whether the default limit should be higher for this tool given that whole-song reads are the normal case; if so, say why in the tool description.
- **Every param the handler reads must appear in the input JSON schema.**
- Return bare data via `envelope()`; the wrapper strips the envelope.

**As built (Alex's decisions, 2026-09-16; details in the progress file's M5 notes):**
- **Signature:** `get_sam_song_scores(song_id, start_measure?, end_measure?, bpm?, limit?, flagged_only?)`.
- **Staleness:** the tool **recomputes if stale**, inline, and reports `scores.status`. The description states plainly that this `get_*` tool writes derived, unaudited rows.
- **Limit:** not `clampLimit`. The default is the whole requested range, capped at 200. The reason is in the tool description: "a truncated list says it is partial; a rollup over a fragment does not." When a range is cut, the response reports it in `meta` and names the analyzed range. The rollup is labelled with the measures it covers, and the response gives the next `start_measure`.
- **`flagged_only`:** filters the returned rows only. The rollup still covers every analyzed measure, and the response says so.
- **Rows are lean:** `beats` and the onset counts are not returned.
- **The last exit criterion changes:** a whole-song read no longer exceeds the cap, so truncation is checked with an explicit `limit`.

**Exit criteria**
- [ ] `get_sam_song_scores` on Someone Like You at its goal tempo flags the same measures the CLI does
- [ ] Omitting `bpm` uses `goal_effective_bpm` and says so in the response
- [ ] A measure range returns only that range, with a rollup over that range
- [ ] A song with no goal and no `bpm` argument errors rather than guessing
- [ ] Truncation is reported when a whole-song read exceeds the cap

---

### M6 — Keep scores fresh

Hang recomputation off the existing write paths rather than adding a parallel mechanism.

#### Findings from the trigger investigation (2026-09-16) — read before building

**Triggers already stamp `measures_edited_at`. The earlier assumption that none
did was wrong.** Neither trigger nor function has ever been in this repo or its
git history — they were created by hand in the SQL editor (almost certainly
with the Feb 2026 data-layer schema) — so the database is the only record.

| trigger | on | fires | function | stamps |
|---|---|---|---|---|
| `bump_parent_edited_at` | `sam_song_measures` | AFTER UPDATE, per row | `bump_song_edited_at` | `UPDATE public.sam_songs SET measures_edited_at = now() WHERE id = NEW.song_id` |
| `trg_lyrics_stamp_edited` | `sam_song_lyrics` | AFTER INSERT OR UPDATE OR DELETE, per row | `stamp_song_edited` | the same statement, keyed on `COALESCE(NEW.song_id, OLD.song_id)` so it survives DELETE |

`stamp_song_edited` is therefore NOT dead code. It looked unattached only
because the first check listed triggers on `sam_songs` and `sam_song_measures`
alone.

What stamps `measures_edited_at`, path by path:

| path | what changes rows | who stamps |
|---|---|---|
| `commitImport` → `fanOutMeasures` | DELETE all measures, INSERT all | **app code only** — no trigger fires on measure INSERT/DELETE |
| `append_sam_measures` (MCP tier 3) | INSERT measures | **app code only** |
| `scripts/backfill-measures.mjs` | INSERT measures | **app code only** |
| `scripts/sam-repair-duplicates.js` | UPDATE `rh`/`lh` | **trigger, per row**, then app code |
| `update_sam_song_measures` (MCP tier 2) | UPDATE `chord`/`section`/`audio_offset_ms` | **trigger, per row** — although no notation changed |
| lyric placement, loading, clearing (app and MCP) | INSERT/UPDATE/DELETE `sam_song_lyrics` | **trigger, per row** — although no notation changed |
| any UPDATE of a measure row, from anywhere | UPDATE | **trigger, per row** |

Facts that follow:

- **Per row, no debounce.** Updating 160 measure rows stamps the song 160
  times. Placing Someone Like You's 371 syllables stamps it 371 times.
- **No no-op guard.** Every row UPDATE stamps, even one that changes nothing.
- **Non-notation writes invalidate scores.** Metadata edits and every lyric
  write move `measures_edited_at`, so the song's scores read as stale even
  though the notes are unchanged.
- **Two clocks.** The triggers stamp with `now()`, the DATABASE clock. App code
  stamps with the CLIENT's (`new Date()`). The compiled-blob check
  (`isMeasuresStale`: `edited_at > compiled_at`) compares values from the two
  and can be wrong in either direction. **This is why M3 stores the stamp and
  checks EQUALITY** (`computed_from_edited_at IS NOT DISTINCT FROM
  measures_edited_at`): equality never compares two clocks, so the scores
  table is immune — the reason that choice was right, not just tidy.
- The delete-and-reinsert path (import) is covered only because its app code
  remembers to stamp. A future writer that forgets leaves scores and the blob
  silently stale.
- Unrelated, noted, not acted on: `update_modified_column` and
  `update_updated_at` are byte-identical duplicate functions under two names.

#### Decision (Alex, 2026-09-16): accept non-notation invalidation

Lyric and metadata writes will keep invalidating scores. A recompute is fast
and produces the correct (identical) result, whereas a second staleness
mechanism that tried to tell notation edits apart would be one more thing to
keep in sync.

**That puts the weight on M4 being cheap when nothing changed.** The freshness
check is the FIRST thing a compute does — `sam_song_scores_freshness`, one call
reading `sam_songs` and `sam_song_scores` — and it returns without reading a
single measure row when the stored rows match. A 371-syllable lyric session
must cost 371 cheap no-ops, not 371 full recomputes. Built that way in M4
(`supabase/functions/_shared/samScores.ts`).

Whatever M6 hangs recomputation on must work **per song**, never per row event:
a trigger-driven recompute would run 160 or 371 times for one edit.

#### Option under consideration — do not change yet: extend the measures trigger to INSERT and DELETE

What it would buy: every writer stamps, including future writers and raw SQL,
with nothing to remember. Import, append and backfill would no longer depend
on app code.

What it would cost, if done by extending the existing per-row trigger:

- **Write amplification.** A 160-measure import (DELETE 160 + INSERT 160) would
  UPDATE the parent 320 times instead of once.
- **Audit volume — the real cost.** `sam_songs` is audited, and the audit
  trigger stores before AND after images of the whole row, **including the
  heavy `measures` blob**. 320 parent updates would write 320 audit rows, each
  carrying the full blob twice: megabytes of audit log per import recording a
  timestamp moving. The existing per-row triggers already pay this for every
  measure UPDATE and every lyric write — 371 blob-carrying audit rows for one
  lyric placement session.
- **Cascade deletes.** Deleting a song cascades to its measure rows; a DELETE
  trigger would UPDATE the parent being deleted. Expected to affect zero rows;
  unverified. (`stamp_song_edited` already does exactly this for lyrics.)
- **More clock mixing:** the database clock would stamp every import just
  before the app stamps with the client's.

A cheaper shape, if the gap is closed: **statement-level** triggers (one per
event — INSERT, UPDATE, DELETE — sharing one function) using transition tables
(`REFERENCING NEW TABLE` / `OLD TABLE`), stamping each affected song ONCE per
statement and only when the value would change. An import would stamp about
twice regardless of measure count, and it could replace both per-row triggers.
The audit cost per stamp remains while `sam_songs` carries the blob.

Not decided. M6 chooses.

**Exit criteria**
- [ ] Importing a song leaves it with scores present and fresh
- [ ] Appending measures via MCP invalidates and recomputes
- [ ] Running the repair script invalidates
- [ ] A song whose measures did not change is not recomputed

---

## 5. Out of scope

- The simplifier. Stays local; that is Phase 4.
- Storing tie, tuplet, blip or seam data. These cross measure boundaries and do not fit a per-measure row. M2 makes them trustworthy; where they live is a later decision.
- Any UI.
- Re-baselining `baseline-report.json`. It is stale and provides no regression protection, but it is a local test-harness concern and not part of this port.

---

## 6. Known hazards

- **Repeated measures.** Flattening duplicates printed bars — Pastorale's played m11–18 are printed m3–10. Per-played-measure scores are correct for snippets and plans. A whole-song aggregate double-counts repeats; decide explicitly whether that is wanted before any aggregate is exposed.
- **Backfilled goal tempos.** Most `goal_bpm` values were backfilled from `default_bpm`. The songs being analyzed have had real goals set, but others still carry placeholders — Clementi 200, Minuet 126, Moonlight 44. A difficulty reading at a placeholder tempo looks authoritative and reflects nothing.
- **`rhThin.js` has the same one-slot-per-pitch tie tracking** that M2 fixes in `analyzeTies`. A unison passage could strip or keep the wrong tie marker during RH thinning. Out of scope here; note it so Phase 4 does not rediscover it.
- **Compound meter.** Numbers are consistent at quarter = BPM, but SAM's metronome clicks quarters in 6/8 and offers no dotted-quarter option. Nothing here is wrong; it is a UX gap that will confuse anyone reading a target tempo for Pastorale or Für Elise.
