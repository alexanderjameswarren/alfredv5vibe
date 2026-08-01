# Initial CLI Prompt — SAM Landing Page Redesign

Copy the block below into Claude Code.

---

```
# Project Context

SAM is my React piano practice app — VexFlow notation, Tone.js audio, Supabase
backend, static bundle on Vercel with no server compute. I use it on a Surface
tablet.

The landing page is currently optimised for uploading songs (rare) and badly
optimised for resuming practice (constant). We are rebuilding it so that opening
the app and resuming the most recent piece is two taps with no scrolling.

# Reference Documents

- Technical spec: docs/technical-spec-sam-landing-redesign.md
- Progress tracking: docs/progress-sam-landing-redesign.md

# There is no database work in this project

No migration, no view, no SQL, no ALTER TABLE. sam_songs.song_type already has
the three values we need (original | simplified | drill) with a lineage check
constraint, and practice time already comes from a working client-side hook. If
a step appears to need schema work, you have misread the spec — stop and ask.

# Your Task

1. Read the technical specification in full before writing any code.
2. Review the progress tracking file.
3. Execute Milestone 1 (extend the practice-stats hook) only.
4. Start by locating the current landing page component and recording its path
   in the Notes section of the progress file.
5. Update progress-sam-landing-redesign.md to mark completed items.
6. Give me explicit verification steps and stop.

# Constraints that matter

- hooks/usePracticeStats.js is working code that produces the practice numbers
  currently on screen. EXTEND it — add the two maps described in the spec to its
  existing useMemo pass. Do not fork it, do not add a second sam_sessions fetch,
  and do not change how it derives duration.
- Duration is ended_at - started_at. Do NOT switch to duration_seconds. The
  existing hook bypasses that column deliberately and I want to know why before
  anything relies on it — if you can work out the reason from the codebase or
  git history, note it in the progress file.
- Day boundaries come from ptDateKey in practiceTimeFormat.js (Pacific Time).
  Any "today" / "yesterday" logic in lib/samFormat.js must delegate to it. A
  hand-rolled Date comparison is a bug, not a shortcut — it will disagree with
  the week strip around midnight.
- NEVER select the sam_songs.measures column in a list query. It is a heavy
  compiled JSONB blob and the table comment says so explicitly. Enumerate the
  columns you need.
- Group families by coalesce(parent_song_id, id). A drill with a null parent is
  its own family root — valid, not an error.
- Put all date and duration formatting in lib/samFormat.js. An inline toFixed or
  hand-rolled "today" check in a component is a bug.
- Do not touch SamPlayer.jsx or any playback behaviour.

# Verification Pattern

After each milestone, ask me to verify by:
- Running the app
- Performing the specific actions listed under that milestone's Verification
  section in the progress file
- Confirming the expected result

Be explicit about what to click and what I should see. Wait for me to confirm
before starting the next milestone.

# Important

- One milestone per turn. Do not run ahead.
- Mark items complete in the progress file as you finish them.
- Record decisions and surprises in the Notes section.
- If the spec is ambiguous or the codebase contradicts it, stop and ask rather
  than guessing.
```
