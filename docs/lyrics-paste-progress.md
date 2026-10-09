# Lyrics Paste — progress

Lyrics are pasted into SAM itself, not loaded through MCP.

## Step 1 — plan (2026-10-09)
Read-only. `sam_song_lyrics` holds loaded and placed syllables as one row in two
states (`measure_num`/`rh_index` null = unplaced). No database change needed.

## Step 2 — built (2026-10-09)
- Player More drawer → Tools → Song → **Lyrics** opens `LyricsSheet`.
- Save: confirm if lyrics exist → split (`hyphen`, en-us) → Auto-Match with tied
  continuations skipped → replace every row → recompile → score redraws.
  Syllables past the last right-hand note are saved unplaced, with an alert.
- Delete lyrics: confirm → delete rows → recompile → score redraws.
- Auto-Match logic moved to `src/sam/lib/lyricsAutoMatch.js`, shared by the
  drawer button and Save.
- Tools tray: two-column grid in Practice / Song / Files groups; every button
  one style (`toolButton` in `AudioToolbar.jsx`) with an icon.

Known limit: TeX hyphenation leaves some short words whole ("every", "over",
"city"). Fixed in step 3.

## Step 3 — singing syllables (2026-10-09)
- Lookup list: Moby Hyphenator II (public domain by grant of the author, 2001;
  https://www.gutenberg.org/ebooks/3204), converted by
  `scripts/build-syllable-dict.mjs` to `public/sam-syllables.txt` (160,495
  words, ~1.9 MB, ~545 KB gzipped). Fetched when the Lyrics sheet opens.
- Duplicates keep the version with most breaks ("o|ver" over "over").
- Suffix rules for forms the list lacks: -s, -es, -ies, -'s, -ed, -ied, -ing,
  -in', and contractions.
- Fallback: hyphen, `minWordLength: 1`. Its left/right minimums are fixed at 2
  inside the library and cannot be relaxed.
- hyphen is now loaded lazily with the list, not bundled with SAM.

## Step 3b — "is" fix (2026-10-09)
- Cause: Moby has no lowercase "is" (nor "as", "us"); its only entry is "I|s".
  About 1,000 list entries have a vowel-less syllable.
- Splitter now merges any vowel-less syllable into its neighbour, whatever the
  source; "n't" is exempt (could-n't). -es adds a syllable only after s, x, z,
  ch, sh, or an -se/-ze/-ge/-ce stem.
