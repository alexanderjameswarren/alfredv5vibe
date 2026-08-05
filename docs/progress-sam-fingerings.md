# Progress: RH Fingering Cues

## Status: Steps 1–4 verified. Step 5 complete (number bar + writes/undo) — awaiting verification

Spec: `docs/technical-spec-sam-fingerings.md`
Migration: `docs/migration-sam-fingerings.sql`

---

## Step 0 — Schema (MANUAL, not CLI) — ✅ COMPLETE

- [x] Run `docs/migration-sam-fingerings.sql` in the Supabase SQL editor
- [x] Run `check_platform_conformance` → CONFORMANT, 14 tables

Verified: table present with both check constraints, composite unique index including
`source`, FK cascade to `sam_songs`, registry `policy_mode: none` / `audited: true` /
notes `SAM: RLS via parent song`, RLS policy reaching through to `sam_songs.user_id`.
`sam_songs.show_imported_fingerings` present, `not null default false`.

Smoke test confirmed manual and musicxml rows coexist on one coordinate, duplicate
same-source insert rejected, out-of-range finger rejected.

**Note for Step 2:** `register_table`'s real signature is
`(p_table regclass, p_policy_mode, p_audited, p_exempt, p_notes)` — the `p_` prefix is not
optional and the table name must be schema-qualified. The `mcp-platform` skill and the
`platform` schema comment have been corrected.

---

## Step 1 — Geometry export (`buildGeometry` in `scoreRender.js`) — ✅ COMPLETE (a+b)

Decision (see spec §5): fingerings must render in BOTH views — entry in the edit screen,
cueing at the piano during playback — so the geometry lives in a pure shared helper, not
in either renderer. The edit screen ([`ScoreRenderer.jsx`](../src/sam/components/ScoreRenderer.jsx))
and the playback view (`renderCopy` in [`scoreRender.js`](../src/sam/lib/scoreRender.js))
each call it against their own formatted output. Only the edit-view call is wired now.

- [x] (a) `buildGeometry({ measureNum, hand, stave, notes })` in `scoreRender.js` — pure
      extraction, one entry per event: `{ measureNum, hand, index, x, staveTop,
      staveBottom, noteheadYs[], isRest }`. No drawing, no layout decisions, no side effects.
- [x] (b) `ScoreRenderer.jsx` (edit/stopped view) calls it per measure per hand and
      publishes the concatenated map (optional `onGeometry` callback + `window.__samGeometry`
      debug handle for verification).
- [x] (c) `renderCopy` (playback view) wiring — done in Step 3: `renderCopy` now returns
      `{ beatMeta, copyWidth, geometry, labelEls }` and `ScrollEngine` draws the overlay.
- [x] `noteheadYs` ordered low pitch → high (so `note_index` 0 is the lowest notehead)
- [x] No visual change to the score

**Verify:** open La Candeur in the stopped/edit view and inspect `window.__samGeometry`
in the browser console.
- Entry count for measure 1 is 9: 8 entries with `hand:"rh"` + 1 with `hand:"lh"`.
- The 8 rh entries are in event order — `index` 0..7 with monotonically increasing `x`.
- Single notes → `noteheadYs.length === 1`. Spot-check that a few `x` values and
  `noteheadYs[0]` land on the rendered noteheads **for this view** (compare against the SVG).

Note: the edit and playback views format at different widths, so once (c) lands the two
maps will **not** be numerically identical. What must match is STRUCTURE — same entry
count, same ordering, same `measureNum`/`hand`/`index`. The `x` and `y` values legitimately
differ per view and must each be validated against that view's own SVG.

### Step 2 decisions

- **Direct client import, not a `supabase` param.** `fingeringsApi.js` is frontend-only, so
  it imports the shared authenticated client (like `AudioToolbar`). `measureCompiler` takes
  `supabase` as a param only because `scripts/backfill-measures.mjs` reuses it server-side
  with a service-role client; there is no second caller here. This keeps the documented
  `loadFingerings(songId)` signatures intact.
- **`loadFingerings` holds both sources per coordinate** (`{ manual, musicxml }`) so a
  clear-then-reveal (spec §3) needs no refetch. `resolveFinger`/`resolveFingerings` are pure
  (no DB) and apply precedence given the `show_imported_fingerings` flag, which the caller
  supplies from the song row.
- **`updated_at` set explicitly on every upsert.** Confirmed the spec's concern is real:
  `register_table` attaches the platform audit trigger, but that writes the audit log — it
  does not bump a row's own `updated_at` on UPDATE. Without setting it, re-setting a finger
  would leave `updated_at` at its insert value.
- **`window.__samFingerings` is a temporary verification handle** set in `SamPlayer` (bound
  to the authenticated client, with the current `songId` preloaded). Remove once
  `FingeringBar` imports the API directly (Step 5).

### Step 3 decisions

- **One shared overlay function, both views.** `drawFingeringOverlay(svgRoot, entries,
  resolvedByKey, opts)` draws into a dedicated `<g class="sam-fingering-overlay">`. The edit
  view (`ScoreRenderer`) and playback view (`ScrollEngine`, geometry concatenated across the
  1/3 scroll copies) both call it. `renderCopy` now returns `geometry` + `labelEls`.
- **Ring immunity to playback recolor (criterion 5).** The ring/badge live on their own SVG
  layer, never inside the VexFlow note groups, so `colorBeatEls` (which recolors note-group
  fills every animation frame) cannot touch them. No `setStyle`, no notehead-fill mutation —
  confirmed by construction.
- **Render-space coordinates, viewBox does the scaling.** `SVGContext.scale` sets a viewBox
  (verified in the vexflow 4.2.2 build), so the whole SVG coordinate system is render-space
  and the browser scales it to display px. The overlay draws the spec's literal px (badge r=9,
  font 12, ring r=7, stroke 1.5) and they scale with `SCORE_SCALE` for free — same mechanism
  that keeps measure numbers/section labels aligned.
- **Collision nudge via live `getBBox`.** Each renderer passes its measure-number/chord
  `<text>` nodes as `collisionEls`; the overlay measures their x-extent and nudges a badge up
  16px when it overlaps (near beat 1). DOM measurement avoids font-metric guesswork and works
  identically in both views.
- **Color: violet `#7c3aed`, not amber.** The spec floated amber, but amber `#d97706` is the
  partial-hit highlight. Violet is absent from the score palette and the brown UI. Spec's
  color-token section updated to record this.
- **Redraw strategy.** `ScoreRenderer` reads `fingerings` via a ref for its render-time draw
  (so a fingering-only change does NOT rebuild the whole score) and has a second effect keyed
  on `fingerings` that redraws just the overlay. `ScrollEngine` redraws the overlay on
  `[fingerings, svgReady]`. This keeps Step 5's optimistic writes cheap.
- **Known limitation (resume-from-measure):** in the playback view the overlay is a single
  layer, not grouped per measure, so on resume-from-measure the blanked lead-in measures
  would still show their badges. Cosmetic, not on any Step 3 verify path; revisit if it
  matters once entry lands.
- **`show_imported_fingerings`** defaults to `false` and is read from `song`; irrelevant in
  Step 3 (no musicxml rows until Step 6), so all manual fingerings render now.

### Step 4 decisions

- **New file `fingeringZones.js`** (per the spec's component table): `buildZones`,
  `syncZoneLayer`, `drawSelectionRing`, and an internal `shakeNoNote`.
- **Zones live in the SVG (render-space), not an HTML overlay.** The browser then does all
  hit-testing and coordinate mapping — including the edit view's horizontal scroll — so
  there is no fragile clientX→render-space math. The Voronoi partition (midpoints between
  adjacent RH x, first/last zone out to the system edges) guarantees every in-band tap
  resolves to the nearest note: no horizontal dead zones.
- **Interpretation of "zones scale with interface scale, not score scale."** Zone *positions*
  necessarily track the score-scaled notes. The line is about touch-target sizing; since the
  spec itself allows sub-44px zones under density (the Voronoi still resolves), no minimum
  width is enforced — for La Candeur the 8-note zones are far wider than 44px anyway. The
  band offsets (24/12) are drawn in render-space. Flagged here in case a stricter reading is
  wanted; it would not change the Step 4 verify outcome.
- **`handleScoreTap` is already a no-op in the stopped view**, so suppression is mostly moot,
  but the zone rects `stopPropagation` and the container tap is gated on `fingeringMode`
  anyway. Zone rects carry a faint violet wash (5%) so the active band is visible.
- **Selection ring** is dashed/bold/larger to distinguish it from the solid faint fingering
  ring; both can show on one note. Selection state lives in `SamPlayer`
  (`fingeringSelection`), cleared when the mode turns off or the song changes. Step 5's
  number bar will consume it.
- **Redraw wiring mirrors Step 3:** zones/selection are (re)drawn in the main render effect
  (via refs, so a score rebuild restores them) and by dedicated `[fingeringMode]` /
  `[fingeringSelection, fingeringMode]` effects for live toggles — no full score rebuild.
- **Known minor leak:** lyric-edit arrows sit below the RH band, so they remain tappable
  during fingering mode. Outside every Step 4 verify path; revisit only if it bites.

### Step 5 decisions

- **New hook `useFingeringEditor` + component `FingeringBar.jsx`.** The hook owns `byCoord`
  (source of truth), the resolved render map, optimistic set/clear with rollback, the
  20-deep undo stack, and a transient error string. `FingeringBar` is purely presentational.
  Replaced the ad-hoc `fingerings` state + load effect that Step 3 put in `SamPlayer`.
- **Optimistic + rollback.** `applyManual(coord, finger|null)` updates `byCoord` immediately,
  then persists; on failure it restores the exact prior coordinate entry (including any
  imported row) and flashes a toast. Manual-only: clearing removes just the `manual` row.
- **Undo model.** Each op stores `{ op, coord, prevFinger, nextFinger }`; undo restores
  `prevFinger` via `applyManual` (set if non-null, clear if null) and is not itself pushed.
  Uniform for set and clear. Undo also writes through to the DB.
- **Advance (`›`)** walks a flat non-rest RH-note sequence derived from `activeMeasures`;
  rests are skipped (can't finger a rest). Advancing and tapping both default the selection
  to the **top** notehead (melody) for chords, matching the picker default.
- **Toast** reuses the `importError` banner styling (no formal toast system exists); auto-
  dismisses after 4s, also dismissable. Shown only in fingering mode.
- **Placement (per request):** the number bar renders inline in the toolbar row ABOVE the
  score, on the same line as the Undo and Fingering-mode buttons (number bar left, Undo +
  toggle right via `ml-auto`). This overrides the spec's "docked at the bottom of the score
  pane." Still not a floating popover.
- **`window.__samFingerings`** is now redundant for wiring (the hook imports the API) but
  retained as a console aid through verification; remove in the Step 7 cleanup pass.

---

## Step 2 — Data layer (`fingeringsApi.js`) — ✅ COMPLETE

- [x] `loadFingerings(songId)` → keyed lookup `${measure}:${rhIndex}:${noteIndex}` →
      `{ manual, musicxml }` (both sources held per coordinate)
- [x] `setFingering(songId, coord, finger)` → upsert with `source: 'manual'`,
      `onConflict: song_id,measure_num,rh_index,note_index,source`
- [x] `clearFingering(songId, coord)` → delete `source = 'manual'` only
- [x] Resolution helper applying render precedence (`resolveFinger` / `resolveFingerings`;
      manual wins; musicxml only when `show_imported_fingerings`)
- [x] `updated_at` set explicitly on upsert

**Verify:** from the **browser console with the authenticated client** — not the SQL editor,
which runs as `postgres` with a null `auth.uid()` and bypasses RLS entirely. Set a fingering
on La Candeur measure 1 rh_index 0, reload the page, confirm it loads back. Set it again to
a different finger and confirm `updated_at` moved. Clear it, confirm it is gone. Confirm a
select returns only your own rows.

---

## Step 3 — Overlay rendering (`fingeringOverlay.js`) — ✅ COMPLETE

- [x] Badges drawn from geometry + resolved fingerings
- [x] Notehead rings drawn on the overlay, no `setStyle()` on VexFlow notes
- [x] Collision nudge for badges near the measure number / chord symbol
- [x] Scales with the score scale factor (via the SVG viewBox — draws render-space px)
- [x] Rendered in BOTH views: `ScoreRenderer.jsx` (edit) and `ScrollEngine.jsx` (playback)
- [x] `--fingering-accent` chosen (violet `#7c3aed`) after palette check; loaded + resolved
      in `SamPlayer` and passed to both renderers

**Verify:** with three fingerings seeded manually (one on beat 1 to test the nudge, one
mid-measure, one on a measure that has a chord symbol), open the song on the Surface. Badges
are legible at arm's length, none overlap a measure number or chord symbol, and starting
playback moves the highlight across a fingered note without the ring flickering or the badge
disappearing.

---

## Step 4 — Tap zones + fingering mode — ✅ COMPLETE

- [x] Fingering mode toggle in the edit screen toolbar, off by default
- [x] Zone layer built from geometry, Voronoi split on x, RH only
- [x] Rest zones are a no-op with a shake ("no note here")
- [x] Other score gestures suppressed while mode is on
- [x] Selection ring on the tapped note (dashed violet, distinct from the solid
      faint fingering ring) — feedback that a tap resolved

**Verify:** on the Surface, turn on fingering mode and tap 20 times at random across a
system. Every tap selects a note — none are ignored. Tap between two eighths and confirm
selection lands on the nearer one. Turn the mode off and confirm normal gestures return.

---

## Step 5 — Number bar (`FingeringBar.jsx`) — ✅ COMPLETE

- [x] Docked bar with `1 2 3 4 5`, `✕`, `›`, 56px buttons (`w-14 h-14`, 8px gap)
- [x] Tap note → tap number writes immediately, no save button
- [x] `›` advances selection to the next RH note (rests skipped; defaults to top notehead)
- [x] Notehead picker appears for multi-notehead events, defaults to top
- [x] Undo stack, last 20 ops (`↺ Undo` button in the fingering-mode toolbar row)
- [x] Optimistic update with rollback + toast on write failure

**Verify:** on the Surface, enter fingerings on 5 consecutive notes using
note→number→›→number. Time it — should be under 15 seconds. Undo three times and confirm
the score matches. Reload and confirm what remains is what you expect.

---

## Step 6 — MusicXML import

- [ ] `songParser.js` reads `<notations><technical><fingering>` on RH notes
- [ ] Emits a parallel `fingerings[]`, NOT inside event objects
- [ ] Import path writes rows with `source: 'musicxml'`
- [ ] `show_imported_fingerings` checkbox in song settings

**Verify:** re-import a Burgmüller MXL that carries editorial fingering. With the toggle
off, no imported badges appear. Turn it on, they appear. Set a manual fingering over one of
them and confirm the manual value wins. Clear the manual one and confirm the imported value
returns.

---

## Step 7 — MCP read (optional, do last)

- [ ] `get_sam_song_measures` returns `placed_fingerings` alongside `placed_lyrics`
- [ ] Tier 1, `ctx.db` only, bare-data payload

**Verify:** call `get_sam_song_measures` on a song with fingerings and confirm they appear
in the response.

---

## Notes

### Step 1 decisions

- **Spec/code conflict resolved (see spec §5 rewrite).** The spec named `scoreRender.js`,
  but that file's `renderCopy` only drives the *playback* view (ScrollEngine). The
  edit/stopped view — where entry happens and what Step 1 verifies — is the separate
  `ScoreRenderer.jsx`, which has its own duplicated render loop. Resolution: a pure
  `buildGeometry()` helper in `scoreRender.js`, called by each renderer against its own
  output. Only the edit-view call is wired now; `renderCopy` deferred to Step 3.
- **`x` = notehead center** via `getNoteHeadBeginX/EndX` (they already include the
  time-proportional `x_shift`, per the existing `drawStaveTies` logic). Rests have no
  notehead, so they use `getAbsoluteX() + getXShift()`.
- **`noteheadYs` sorted descending by y** = ascending by pitch, since SVG y grows
  downward. So `noteheadYs[0]` is the lowest notehead = `note_index` 0. Matches the spec's
  "default selection is the top notehead" (highest index).
- **`index` = position in the hand's `notes` array**, which is 1:1 with the padded event
  array. `padVoice` only *appends* rests, so real events keep their original indices →
  `index` equals `rh_index`/`lh_index` for anything fingerable. Padding rests occupy the
  tail indices and are marked `isRest`.
- **`getYs()` with a key-line fallback.** `buildGeometry` is called after the note draw
  loops, so `getYs()` is populated; the `getKeyProps()`+`stave.getYForNote()` fallback
  keeps the helper safe to call straight after `format()` (which is how `renderCopy` will
  use it in Step 3).
- **Legacy `beats` format:** treble→`rh`, bass→`lh` by stave. The pitch-split legacy path
  does not give a clean `rh_index`, but per spec §2 legacy songs get no fingerings until
  they are re-imported under the parser rewrite, so this is not exercised.
- **`window.__samGeometry`** is a temporary Step-1 verification handle; the durable
  interface is the `onGeometry` callback prop. Remove the window handle once the overlay
  consumes `onGeometry` (Step 3).

