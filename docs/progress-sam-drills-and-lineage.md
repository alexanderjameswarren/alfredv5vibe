# Progress: SAM — Drills, Song Lineage, and Notation Authoring

## Status: Complete

Reference: `docs/technical-spec-sam-drills-and-lineage.md`

---

### Step 0 — SQL migration (MANUAL, human runs in Supabase SQL editor)

- [x] Run `migration-sam-lineage.sql`
- [x] `select * from platform.conformance_failures;` returns zero rows
- [x] `check_platform_conformance` returns CONFORMANT
- [x] (optional) Reclassify the three known drills
- [ ] (optional) Delete test rows

**The CLI does not run this.** Do not start Step 1 until the human confirms CONFORMANT.

---

### Step 1 — Fix the fan-out null bug and surface failures

- [x] `measureCompiler.js`: `rh: m.rh ?? []`, `lh: m.lh ?? []`
- [x] `measureCompiler.js`: `time_signature` falls back to `{ beats: 4, beatType: 4 }`
- [x] `SongLoader.jsx`: fan-out failure surfaces via `setError`, both file and paste paths

**Verify:** import a JSON document with `rh: [{"duration":"w","notes":[]}]` and real
`lh` content. Song appears in the library AND `sam_song_measures` has rows for it.
Then break it deliberately (bad column) and confirm the error reaches the UI.

**Step 1 notes**
- **File paths.** Spec uses `src/lib/measureCompiler.js` and `src/components/SongLoader.jsx` as shorthand; actual paths in this repo are `src/sam/lib/measureCompiler.js` and `src/sam/components/SongLoader.jsx`.
- **`??` not `||`** in measureCompiler — the spec called for `?? []`. `||` would have coerced an intentional empty-array silent hand into `[]` too (same result today), but `??` correctly leaves `[]` alone and only substitutes on null/undefined. Preserves the "silent hand is `[]`" contract from spec §4.
- **`time_signature` fallback**: `{ beats: 4, beatType: 4 }` when `m.timeSignature` is missing entirely. Matches spec's "a real fallback" phrasing. Kept the existing symbol-passthrough branch intact when timeSignature is present.
- **SongLoader — three silent-fail paths surfaced, not just fan-out.** The spec's Fix 5.2 called out fan-out specifically, but the same pattern silently swallowed (a) the outer supabase `.catch` and (b) the `dbError` branch of the insert `.then`. All three now call `setError`; the fan-out message notes the song saved but rows didn't and suggests re-import. Both file-import and paste paths edited identically.
- **Build interlude.** `npm run build` initially failed with an eslint config conflict because I had a leftover `node_modules/.deno/` cache from prior `deno check` runs pointing at a duplicate `eslint-config-react-app`. Deleting `.deno/` unlinked pnpm-style symlinks (this project uses pnpm-through-Deno's `node_modules_dir`), which then broke `react-scripts` resolution. `npm install` restored the tree and `npm run build` succeeds clean. Note for future: `deno check` mutates `node_modules/.deno/`; avoid running it in this project or clean up via `npm install`, not `rm -rf`.
- **Follow-up bug found in verification: `setError` on an unmounted `SongLoader`.** First verification pass showed the fan-out error was reaching the catch block (console had `[Sam] Measure fan-out failed`) but no red banner appeared. Cause: `onSongLoaded(song)` fires synchronously before the async fan-out resolves; `SamPlayer` swaps to the song view; `SongLoader` unmounts; the subsequent `setError(...)` targets a dead component (React's silent no-op). Same class of bug as the original silent fan-out — the error was reaching a surface that no longer existed.
- **Fix: import-error banner hoisted to `SamPlayer`.** New `importError` state in SamPlayer, red banner with dismiss (×) rendered above whichever child is active. New `onImportError` prop threaded into SongLoader; a `report(msg)` helper calls both the local `setError` (for the pre-load window when SongLoader is still mounted) AND `onImportError` (for the post-load window when only SamPlayer is). All three async surfacing sites (dbError, fan-out catch, outer .catch) in both file-import and paste paths now go through `report`. Banner clears automatically when a new song loads successfully.

---

### Step 2 — Shared schema, real validator, wire new fields

- [x] `sam-drill-format.schema.json` at repo root
- [x] `src/sam/lib/songSchema.js` — schema validation plus `midi`/`name` agreement and
      duration-sum checks; returns an array of errors
- [x] `beats[]` rejected with a clear message
- [x] Inline `lyric` rejected in authored documents
- [x] `SongLoader.jsx` uses the new validator; shows first ~5 errors
- [x] Both insert paths pass `song_type`, `parent_song_id`, `difficulty_tier`,
      `generation_notes`

**Verify:** paste the Am↔F drill from the spec — lands with `song_type='drill'`.
Change one note to `midi: 69, name: "Bb4"` and confirm rejection naming the measure
and hand. Paste a measure whose durations sum to 5 beats in 4/4 and confirm rejection.

**Step 2 notes**
- **Schema location.** Master lives at `sam-drill-format.schema.json` (repo root) per spec §6, but CRA's ModuleScopePlugin refuses imports outside `src/`. Resolution: `scripts/prebuild.js` copies the master into `src/sam/lib/sam-drill-format.schema.json` on every build/start. Added a `prestart` npm hook so `npm start` (dev) triggers the copy the same way `npm run build` does. Copy is `.gitignore`'d; single source of truth is preserved. Step 4 will extend the prebuild to also copy into `supabase/functions/_shared/` for the Deno-side validator.
- **Ajv added as direct dependency** (`ajv@^8.20.0`). Was a transitive of workbox/schema-utils; making it direct pins the version and clarifies intent. Options `{ allErrors: true, strict: false }` — allErrors so users see every problem in one pass instead of iterating; strict:false because the schema uses `not: { required: [...] }` for the beats/lyric rejections, which Ajv strict mode flags as "unknown patterns" even though they're valid draft-07.
- **Two error surfaces intentional.**
  - **Structural**: Ajv errors, path-anchored (`/measures/2/rh/0/notes/1: …`).
  - **Semantic**: hand-rolled per-measure/per-hand messages naming the measure number, hand, event index, note index (`measure 3 rh[0].notes[1]: midi=69 does not agree with name="Bb4" (expected midi=70)`).
  Both routed through the same `validateSongDocument` return value; SongLoader shows the first 5 with `+N more` if truncated.
- **`not: { required: [beats] }` and `not: { required: [lyric] }`** get reworded by `formatStructuralError` — Ajv's default message for a `not` violation is uninformative ("must NOT be valid"); the intercept surfaces the actual intent ("must not include `beats[]` — use rh[]/lh[] instead").
- **Route split by input type.** JSON path (file `.json` or paste that parses as JSON) → strict `validateSongDocument`. MusicXML path → new lightweight `validateMusicXmlSong` sanity check only. Rationale: `parseMusicXML` legitimately emits inline `lyric` fields (from `<lyric>` in the source) that the strict schema forbids; forcing MusicXML through strict validation would break every re-import. `parseMusicXML` is our own code and is trusted.
- **Semantic — duration-sum edge case.** A tuplet in EITHER hand exempts BOTH hands on that measure. Under-checking is safer than false-positives under fractional-beat tuplet arithmetic (1/3 + 1/3 + 1/3 in IEEE-754 doesn't equal 1). Spec §4 explicitly exempts tuplet measures.
- **Semantic — dotted-note math.** `q` = 1.0, `qd` = 1.5, `hd` = 3.0, `8d` = 0.75, etc. Each dot adds half of the previously added value (base, base/2, base/4…). Tolerance `0.001` for the sum check — absorbs any legit dotted arithmetic drift while still catching a genuine 5-in-4/4 error.
- **`lineageFields(doc)` helper** centralizes the four new columns (`song_type`, `parent_song_id`, `difficulty_tier`, `generation_notes`) so file/paste paths can't drift. Applied via `...lineageFields(song)` spread in both inserts. MusicXML output has no lineage fields; helper returns `{song_type: "original", ...nulls}` — same behavior as before this step for the MusicXML path.
- **Multi-line error rendering.** Both banners (SongLoader local, SamPlayer hoisted) gained `whitespace-pre-wrap` so the formatter's `\n`-joined error list renders as separate lines rather than a wall of text.
- **Post-verification fix: Ajv `verbose: true`.** Test C surfaced the raw Ajv message `must NOT be valid` instead of my reworded `measure must not include beats[]`. Cause: `formatStructuralError` inspects `error.schema` to identify which `not: { required: [...] }` clause tripped, but Ajv only populates that field when `verbose: true`. Default is off. Added the option; reworded messages now fire for both the `beats[]` and inline-`lyric` rejections.
- **Scope reminder confirmed by Alex.** The strict validator is an import-time gate on the SongLoader paste/file paths — it does NOT run on direct DB edits (`update sam_songs set measures=...`) or on rows already in `sam_song_measures`. That's by design; the validator's job is guarding the authored-input boundary, not the persisted state. Direct-DB manipulation still needs a human eye.

---

### Step 3 — Backfill measure rows

- [x] `scripts/backfill-measures.mjs`, dry-run by default, `--apply` to write
- [x] Reports every song with a non-empty `measures` blob and zero measure rows
- [x] Idempotent; safe to re-run

**Verify:** dry run lists the affected songs (expect *Someone Like You — Arpeggios*
among them). Apply. Re-run dry: zero affected. Open a backfilled song in SAM and
confirm it plays.

**Step 3 notes**
- **fanOutMeasures inlined into the script.** The app module `src/sam/lib/measureCompiler.js` uses ESM `export` syntax but the project's `package.json` has no `"type": "module"`, so Node treats `.js` files as CommonJS and refuses to parse `export`. A `.mjs` script can't cleanly import from that `.js` file without either renaming the source (invasive; CRA relies on the current setup) or setting up a transpile step (over-engineering for a one-off). Inlined the ~40-line fan-out; noted at the top of the script that if the app-side version changes in load-bearing ways, mirror the change here.
- **Uses the service-role key intentionally.** Backfill spans all users' songs; RLS-scoped access via the anon key would filter to the caller's rows only. Script prints an actionable error if either env var is missing rather than picking up a fallback silently.
- **Three-way classification, not just two.** Spec says "songs with zero measure rows" — the script matches that exactly for the backfill set, but ALSO reports `partial` (0 < rows < blob-length) as diagnostic info without touching them. Rationale: partial rows might be intentional direct-SQL state; safer to surface than to blindly overwrite. `ok` (rows == blob-length) is just a headline count.
- **Idempotent by design.** `fanOutMeasures` deletes existing rows for the song before inserting, so re-running the script on an already-backfilled song produces the same result. Combined with the "backfill only when count == 0" filter, safe re-runs are a two-line guarantee.
- **Import doesn't hit deploy/edge concerns.** Script runs locally against the Supabase REST API; no bundling, no Deno.
- **Not run by the CLI.** Alex runs this from their shell against production with the service-role key.

---

### Step 4 — MCP authoring tools

- [x] `supabase/functions/_shared/tools/sam-authoring.ts`
- [x] `create_sam_song` — tier 3, inserts `measures: []`
- [x] `append_sam_measures` — tier 3, validates, continues numbering, sets
      `measures_edited_at`, leaves `measures_compiled_at` null
- [x] Both use `ctx.db` only; no Supabase import in the tool file
- [x] Descriptions state what each tool does NOT do
- [x] Every param the handlers read appears in the input JSON schema
- [x] Registered in `supabase/functions/mcp/index.ts`
- [x] Deployed; confirm `--no-verify-jwt` survived the redeploy (v25, verify_jwt=False)

**Verify:** settings panel shows the tool count risen by 2. Start a **fresh
conversation**, have Claude create a two-measure drill, open it in SAM, confirm it
renders and plays.

**Step 4 notes**
- **Deploy sequence.** Ran `node scripts/prebuild.js` first (extended it in Step 2 to copy the schema; extended again this step to also copy to `supabase/functions/_shared/sam-drill-format.schema.json`). Then `npx supabase functions deploy mcp --no-verify-jwt`. Deploy uploads seven assets now (added `_shared/tools/sam-authoring.ts` and `_shared/sam-drill-format.schema.json`). If future deploys skip prebuild, the tool's `import schema from "../sam-drill-format.schema.json"` will 404 at runtime.
- **Tool count confirmed by direct probe.** Curled `tools/list` on the live endpoint with the anon key; got 24 tools (was 22 in v24), both new names present. Alex's settings-panel check is the client-side counterpart — same shape, different observer.
- **Ajv sub-schema compile.** `append_sam_measures` validates individual measures against the `#/definitions/Measure` sub-schema. Registered the full document with `ajv.addSchema(schema, schema.$id)` then compiled `{$ref: schema.$id + "#/definitions/Measure"}` — Ajv resolves the internal `$ref` chain (Measure → TimeSignature → VoiceEvent → Note) automatically. Same `verbose: true` option so the beats[]/lyric reword works.
- **Semantic helpers duplicated.** `nameToMidi`, `eventBeats`, and the STEP/ACCIDENTAL/DURATION tables mirror `src/sam/lib/songSchema.js`. ~30 lines. Deno cannot cleanly import from `src/` at runtime (Supabase deploy only bundles `supabase/functions/**`) and the app-side is ESM inside a CRA build tree, so runtime sharing is not on offer. If either helper changes in the app, mirror it here — noted at the top of the tool file.
- **`create_sam_song` extra guardrails.** Rejects missing `title` / `songType` with actionable messages before hitting Postgres. Enforces "simplified ⇒ parentSongId required" application-side too (the DB CHECK will also catch it, but the app-side error is more diagnostic). `source: "mcp_create"` distinguishes MCP-authored songs from paste/import.
- **`append_sam_measures` batch-atomic validation.** ALL measures validate before ANY writes. Reports every error in one shot (`allErrors: true`), capped at 20 lines in the message with `+N more` if truncated. Ensures a single call to fix everything the model got wrong.
- **Continues numbering server-side via `max(number)` per song.** Doesn't trust caller-supplied `number` — spec §4 says "number is advisory; array order wins" for fanOutMeasures, so this mirrors that: array order + max()+1 base. Prevents accidental gaps or collisions.
- **`measures_compiled_at` intentionally untouched.** The `measures_edited_at`-set-but-compiled_at-null state is what triggers `isMeasuresStale()` in the React app, which recompiles the blob from rows on next `handleLoadFromLibrary`. The tool never writes the blob directly — the React app self-heals on next open. This is the whole integration story per spec §7.
- **Truncation surfaced via envelope.** Per-call cap of 100 measures. Larger batches: first 100 written, `meta.truncated=true`, `meta.total=<caller's length>`, and `runToolForMcp` prepends the "NOTE: results truncated to 100 of M" block. Never silently drops.
- **Tier 3 by design (spec §2 + §7).** Both tools reject calls without `args.confirmed === true` and return a proposal envelope. Every tool description says so explicitly. The `confirmed` param is declared in the zod input schema so the model knows how to promote a proposal to a real call.
- **No Supabase client import in the tool file.** Verified — the only imports are `ajv`, `defineTool`, `envelope`, and the JSON schema. Handlers reach the DB only via `ctx.db` handed by `defineTool`. Rule 1 of the mcp-platform skill holds.
- **End-to-end verification (Alex-side):** create + append + open in SAM produced the expected four audit rows attributed to `actor='claude'` (INSERT sam_songs · INSERT sam_song_measures ×2 · UPDATE sam_songs.measures_edited_at) plus a fifth UPDATE on sam_songs from the React recompile correctly attributed to `actor='ui'`. Song rendered and played.
- **Diagnostic-query gotcha, banked for future reference.** `platform.registry.table_name` AND `platform.audit_log.table_name` both store **schema-qualified** names (`public.sam_songs`), not bare (`sam_songs`). Any filter query needs the schema prefix. Bit me twice this session — once on the registry check, once on the audit-log check. Not a spec change, just a convention to remember.

---

### Step 5 — Drills section and tree UI

- [x] Library query selects `song_type`, `parent_song_id`, `difficulty_tier`
- [x] Originals render with their variants and drills nested beneath
- [x] Parentless drills get their own "Drills" section
- [x] Orphans (parent deleted OR archived) render as roots, not hidden
- [x] Manual drill entry documented in the paste area

**Verify:** the Someone Like You family nests correctly. Create a parentless drill and
confirm it appears under Drills. Delete a test original and confirm its drill survives
and re-roots.

**Step 5 notes**
- **Tree builder:** `buildLibraryTree(visibleSongs)` returns `{ roots, childrenByParent, parentlessDrills }`. Called at render time from the library block. "Visible parent" is the key check: a child whose `parent_song_id` points at a song currently in the fetched (non-archived) library nests under that song; a child whose parent isn't visible falls through to a root (or the Drills section for `song_type='drill'`).
- **Orphan-treatment covers TWO cases with one rule.** Spec says "orphans (parent deleted) render as roots" — `ON DELETE SET NULL` on the FK means deletes actually null out the child's `parent_song_id` server-side, so from the client's view they look like parentless. Same logic also covers archived parents (the archive filter removes them from the visible library map; children look parentless client-side). Both behave identically: originals/simplified-orphans render as roots, drill-orphans go to the Drills section. Behavior matches the spec's stated intent without a separate orphan detector.
- **Single-level nesting only.** Spec architecture table: "Tree depth arbitrary in data, flat in UI." My renderer walks one level of `childrenByParent` under each root — grandchildren aren't shown as such (they'd render alone as roots or in Drills). Practically drills/variants don't have children of their own; if that ever changes, escalate to recursive rendering.
- **Child badges:** small pill next to child titles disambiguates without a full column. `variant · tier N` for `song_type='simplified'` (or plain `variant` when tier is null), `drill` for `song_type='drill'`. Originals only appear as roots so they never carry a badge.
- **Row renderer extracted** into a local `renderSongRow(row, { indent, badge })`. Preserves hover-shown edit/archive buttons, session-stats caption, click-to-load behavior — identical to the pre-Step-5 flat row for root songs; children get `ml-6` indentation.
- **Section headers:** "Your songs" (existing) and "Drills" (new). Both suppressed when empty — a user with only originals sees no Drills section; a user with only drills sees no Your songs section.
- **Paste-area tip** added above the textarea, one-liner: mentions `"songType": "drill"` and the optional `"parentSongId"` field. Formatted with `<code>` tags for the field names.
- **`React.Fragment` used for root+children grouping.** The map produces roots + descendants inline; a Fragment keeps them siblings in the DOM without an extra wrapping div that would break the `flex flex-col gap-1` layout.
- **No behavior change for existing flat-library users.** A user whose library is all `song_type='original'` sees exactly the current layout — same row, same click behavior, same edit/archive buttons. New sections only appear when new data exists.
- **Build:** `npm run build` succeeds clean.

---

### Notes

_Space for decisions and issues found during execution._

---

### Final Sign-Off

**Success criteria (spec §9) — all met:**
- [x] `check_platform_conformance` returns CONFORMANT after the migration (Step 0)
- [x] An LH-only JSON document imports and produces measure rows (Step 1)
- [x] A document with `midi: 69, name: "Bb4"` is rejected with a specific message (Step 2)
- [x] A pasted drill lands with `song_type='drill'` and the correct `parent_song_id` (Step 2)
- [x] No song with a non-empty `measures` blob has zero `sam_song_measures` rows (Step 3 — 49 songs backfilled, 0 remaining)
- [x] Claude can create a drill end to end over MCP, and it opens and plays in SAM (Step 4)
- [x] Deleting an original leaves its drills intact, re-rooted in the library tree (Step 5, `ON DELETE SET NULL`)
- [x] The library shows families as trees and parentless drills in their own section (Step 5)

**Cross-cutting patterns banked for future work**

- **Async errors need a hoisted surface.** `setState` on an unmounted component is a silent React no-op. Any error path that fires AFTER a mount/unmount boundary crossing (in this project: `onSongLoaded(...)` swaps SamPlayer's child) needs its surface at the parent's level, not the child's. Step 1's `importError` state on SamPlayer + `report(msg)` helper on SongLoader is the shape.
- **Schema-qualified naming in `platform.*`.** Both `platform.registry.table_name` and `platform.audit_log.table_name` use `public.<table>`, not bare `<table>`. Any diagnostic query needs the schema prefix. Bit me twice this project (registry check, audit-log check).
- **Deno + CRA cannot share a JS module.** Deploy boundaries are strict. `sam-drill-format.schema.json` at repo root + prebuild copies into `src/sam/lib/` (CRA) AND `supabase/functions/_shared/` (Deno) is the shape. Both copies are `.gitignore`d; master is the only tracked version. If a deploy skips prebuild, the Deno import 404s at runtime — noted at the top of `sam-authoring.ts`.
- **Semantic checks are duplicated JS.** `nameToMidi` / `eventBeats` / STEP + ACCIDENTAL + DURATION tables live in both `src/sam/lib/songSchema.js` and `supabase/functions/_shared/tools/sam-authoring.ts`. ~30 lines. Runtime sharing isn't on offer across the CRA/Deno boundary. If either changes, mirror it.
- **Ajv `verbose: true` is required** for `error.schema` inspection. Without it the `not: { required: [beats] }` / `not: { required: [lyric] }` reworders can't distinguish which not-clause tripped and fall through to Ajv's generic "must NOT be valid".
- **fanOutMeasures is intentionally duplicated in `scripts/backfill-measures.mjs`.** Node CJS-vs-ESM boundary again. If measureCompiler.js's fan-out changes in load-bearing ways, mirror it in the script.
- **Tier 3 tools require `confirmed: true`** to actually write. `defineTool` intercepts and returns a proposal envelope when it's absent — Claude then re-invokes with `confirmed: true`. Both `create_sam_song` and `append_sam_measures` follow this dance, and their zod input schemas declare the param.
- **`measures_edited_at` set / `measures_compiled_at` untouched** is the whole self-healing story. `isMeasuresStale()` returns true when edited > compiled or compiled is null; `handleLoadFromLibrary` recompiles the blob from rows on next open. The tool never touches the blob.

**Governing principle held:** snapshot semantics preserved. No live derived-song regeneration, no staleness detection on lineage, no read-only enforcement on children. `generation_notes` is a receipt, not build input. Editing a parent doesn't propagate. Deleting a parent (ON DELETE SET NULL) leaves children intact and re-roots them in the library tree.

**Live tool count:** MCP now serves 24 tools (was 22 before Step 4). All routed through `defineTool`; no raw Supabase client imported outside `_shared/platform.ts`. `check_platform_conformance` continues to return CONFORMANT.
