# sam-tools

Local CLI for SAM song data. Phase 0a: parser validation.

## Setup

Lives at `alfred-v5/tools/sam-tools/`. Standalone — its own package.json, its own
node_modules, not part of the app build. Requires Node 18+.

    cd tools/sam-tools
    npm install
    npm run validate     # should reproduce baseline-report.json

## Commands

    npm run validate     # whole corpus
    npm run sync         # copy src/sam/lib/songParser.js -> vendor/
    npm run check        # sync + validate  <- the loop, after every code change
    npm run baseline     # overwrite baseline-report.json (only when intended)

    node bin/sam.js validate fixtures/x.mxl -v   # one file, with detail
    node bin/sam.js validate fixtures --json     # machine-readable

No shell dependencies: .mxl unzipping is pure node:zlib, so `npm run check`
behaves identically in PowerShell, cmd, Git Bash and WSL.

## How it works

`vendor/songParser.js` is a **verbatim copy** of `src/sam/lib/songParser.js` —
the code under test. Do not edit it; sync it from the app when the app changes.

`lib/xmlTruth.js` independently computes what the MusicXML actually says:
voice-aware (groups by `staff:voice`), tuplet-aware (trusts `<duration>`, never
`<type>`), and navigation-aware (resolves repeats, voltas, D.S./coda into a
flattened playback order). It also contains `mergeStaff()`, the reference
implementation of the voice-merge fix.

`lib/validate.js` runs the parser under jsdom and diffs the two, classifying
every divergence. It is an oracle, not a rewrite.

## Using it as a regression suite

Record a baseline (`--json`), fix one defect class in `songParser.js`, re-sync
`vendor/`, re-run. The target class should drop to zero and nothing else should
move. Fixing five interacting bugs without this is guesswork.

## Defect classes

| Class | Blocking | Meaning |
|---|---|---|
| `voice_collision` | yes | Two voices on one staff flattened serially. May be SILENT (sums correct, pitches wrong). |
| `tuplet_scaling` | yes | `<type>` used instead of `<duration>`; triplets stored at face value. |
| `measure_overflow` / `underflow` | yes | Per-hand sum ≠ measure length for any other reason. |
| `unflattened_repeat` | warn | Repeats/voltas ignored; stored measures ≠ played measures. |
| `unresolved_navigation` | warn | Segno / To Coda / D.S. ignored. |
| `gap_fill_inexact` | warn | Rest gap snapped to one approximate token. |
| `orphan_tie` | warn | Tie start or end with no partner. |
| `cross_staff` | info | Voice number contradicts `<staff>`; trust `<staff>`. |
| `notes_unsorted` | info | `notes[]` not ascending by midi. In this corpus, always a symptom of voice collision. |
| `grace_dropped` | info | Grace notes skipped silently. |
| `key_mode_wrong` | info | Source declares major at negative fifths. `fifths` is reliable; `<mode>` is not. |
