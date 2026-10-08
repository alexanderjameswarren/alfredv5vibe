# SAM song page — left rail (layout "D")

Layout only: every control keeps its logic. Target: Surface Go, Edge, ~1024 x 640,
touch targets ≥ 44px. The playing screen (FocusedPlaybackBar / PracticeBar) is
unchanged throughout. No database work.

Decisions (2026-10-07): snippet row's left icon loads only; Start/End clip on
blur and on Enter; audio songs show Speed % in the rail, BPM + edit-sync in More;
the tray pushes the score down and the snippet list keeps NO height cap (page
scrolls); fit-to-height applies to the stopped, tray-closed score only.

## Steps

- [x] **1. Shell and rail.** Two columns; rail with Play / Resume / Restart / Stop,
  Practice, Warm up (under Practice), tempo box (BPM, or Speed % on audio songs),
  Goal, Save (when dirty), Snippets and More (disabled placeholders), Back. Old
  rows stay below in the right column.
  *Check:* Play, Practice, Pause, Resume, Restart, Stop and Back all work; the
  tempo box, Goal and Save behave as before; the playing screen is identical.
- [x] **2. Title row and plan bar.** Title, range, artist, pencil, then Practiced
  today and MIDI on the right; plan bar with Set tempo and Next on the right,
  warm-up summary line kept under it.
  *Check:* pencil opens Edit song; Next opens the next item; Set tempo works.
- [x] **3. Snippet tray.** Snippets toggles the existing panel, attached under the
  plan bar, pushing the score down. Whole song (existing Full Song), left load
  icon on each row, Enter commits Start/End. No list height cap.
  *Check:* tapping a row and committing Start/End both clip the score at once;
  Save New, Archive, Restore, View archived work; Whole song clears the range.
- [ ] **4. More drawer.** Slides from the left beside the rail over a dimmed
  score; dim area or Close shuts it. Audio, Metronome, Score playback, Tuning,
  Loop (Repeat + rest), Fingering mode, Diff, Show Imported, Export, Refresh,
  Stats (incl. song goal).
  *Check:* every drawer control works; nothing remains below the score but the
  conditional fingering / ghost / lyrics rows.
- [ ] **5. Score fit-to-height.** Stopped score, tray closed: CSS scale only.
  Paused score (ScrollEngine) not scaled.
  *Check:* at 1024 x 640 with the tray closed both staves show and the page does
  not scroll; scoring unchanged.
- [ ] **6. Tests.** Selector updates, MoreDrawer tests, both suites.
  *Check:* both suites green.

## Log

- Step 1 done 2026-10-07. Tempo, Goal and Save moved from NumericSettings into
  an exported `TempoControls`; `showBpmEdit` lifted to SamPlayer. The right
  column is the same element in every state so ScrollEngine survives a pause.
- Step 2 done 2026-10-08. Practiced today moved from NumericSettings to the
  title row; PlanLine renders in SettingsBar's `children` slot under it, one
  line per row with Next at the right. Export / Audio / Refresh / Auto-Match and
  Full Song stay in the title row until steps 4 and 3. The song goal line moved
  up with the plan block (it is part of PlanLine) until step 4.
- Step 3 done 2026-10-08. Plan bar: Next leads the line, outlined in the
  primary colour (styled from PlanLine via `[&_[data-next-box]]`, so
  PlanNextButton.jsx is unchanged). SnippetPanel's `open` is now controlled by
  the rail's Snippets toggle; the old collapsible row is gone; Full Song became
  the tray's Whole song (FullSongButton removed); left load icon per saved row;
  Enter blurs Start/End to commit. Fingering mode / Diff / Show Imported, which
  rode on the old Snippet row, sit on their own row above the score until step 4.
