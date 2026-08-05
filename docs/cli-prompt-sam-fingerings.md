# Project Context

SAM is a React piano practice app (Vercel + Supabase, VexFlow for notation) used on a
Surface tablet at the piano. We're adding right-hand fingering cues: tap a note in the edit
screen, tap a number 1–5 in a docked bar, and a circled badge appears above the note with a
subtle ring on the notehead.

Usage is sparse — a handful of fingerings per piece — so legibility matters far more than
entry throughput.

# Reference Documents

- Technical spec: `docs/technical-spec-sam-fingerings.md`
- Progress tracking: `docs/progress-sam-fingerings.md`
- Migration (already applied manually): `docs/migration-sam-fingerings.sql`

# Prerequisite — already done

Step 0 (the SQL migration) has been run in the Supabase SQL editor and
`check_platform_conformance` returned CONFORMANT. Do not attempt to run migrations.
`sam_song_fingerings` and `sam_songs.show_imported_fingerings` exist.

# Your Task

1. Read the technical specification in full before writing any code.
2. Review the progress tracking file.
3. Execute the first incomplete step — Step 1, the geometry export from `scoreRender.js`.
4. Update `docs/progress-sam-fingerings.md` to mark the step complete and note any
   decisions made.
5. Give me explicit verification instructions.
6. Wait for my confirmation before starting the next step.

# Non-negotiable constraints from the spec

- Fingerings live ONLY in `sam_song_fingerings`. Never write them into
  `sam_song_measures.rh` event objects, and never touch `sam_songs.measures`.
- Never call `note.setStyle()` or mutate VexFlow notehead fill for fingering. Playback
  highlighting owns that property. Rings are drawn on the overlay layer.
- Do not use `VF.FretHandFinger` or `VF.Annotation`. Badges are overlay SVG.
- `scoreRender.js` is scheduled for a separate multi-voice and tuplet rewrite. Keep
  fingering logic out of it — its only new responsibility is publishing the geometry map.
- Tap zones are a Voronoi partition on x over RH events, not notehead bounding boxes. There
  must be no dead zones.

# Verification Pattern

After each step, ask me to verify by opening the app and performing specific actions — be
explicit about which song, which measure, and what I should see. The progress file lists a
verification block per step; use it as the baseline and add anything else that would catch a
regression.

Verification happens on the Surface for anything touching touch targets or legibility.

Only proceed to the next step after I confirm.

# Important

- Mark steps complete in the progress file as you finish them.
- Add notes about any decisions or issues encountered.
- If the spec is ambiguous or you find a conflict with existing code, stop and ask rather
  than picking an interpretation.
