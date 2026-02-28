# Progress: Sam UI Layout Changes

## Status: Not Started

---

## Changes

- [x] Change 1: Relocate Export, Audio, Change Song buttons to top row
- [x] Change 2: Full Song button — visible only when snippet selected, hides when clicked
- [x] Change 3: Snippet save behavior — Save (update) + Save New (insert) when snippet selected, Save New only when none selected
- [x] Change 4: Settings row — add Audio Lead-In and Default BPM as session overrides
- [x] Change 5: Snippet label spacing bug fix (done in previous session)

---

## Notes

**Change 1** — Restructured `SettingsBar.jsx` from a single `<div>` wrapper to a `<>` fragment with two rows. Top row: playback controls (left) + utility buttons (right, always visible). Settings row: BPM/Timing/Chord/Measure W inputs, hidden during play. Export, Audio upload, and Change Song buttons are now always visible regardless of playback state. Also fixed `text-muted-foregroundfont-normal` CSS bug (missing space) on the song title span. Note: Could not find a "Move" button in the codebase — only relocated Export, Audio, and Change Song.

**Change 2** — Moved the "Full Song" button from SnippetPanel to the top row in SettingsBar, next to the playback controls. Visible only when `snippet` is truthy. Clicking calls `onFullSong` which sets snippet to `null` in SamPlayer. Removed the button and `handleFullSong` function from SnippetPanel, and removed the unused `Disc` import.

**Change 3** — Split `handleSave` into `handleSaveUpdate` (UPDATE existing row by `snippet.dbId`) and `handleSaveNew` (INSERT new row with title prompt). When a snippet is selected (`snippet?.dbId`), both "Save" and "Save New" buttons are shown. When no snippet is selected, only "Save New" is shown. Both functions also include `handMode` and `title` in the `onSnippetChange` call.

**Change 4** — Added `audioLeadInMs`/`audioLeadInMsInput` and `defaultBpm`/`defaultBpmInput` session state to SamPlayer. Initialized from song values in `handleSongLoaded`. Replaced `song.audioLeadInMs` and `song.defaultBpm` references with session state in playback rate effect, `getSnippetAudioSeekMs()`, and ScrollEngine prop. Added "Lead-In ms" and "Default BPM" input fields to the settings row in SettingsBar. Also syncs these values when the Edit modal saves.

**Change 5** — Already fixed in previous session (8 CSS class concatenation bugs in SnippetPanel.jsx).

