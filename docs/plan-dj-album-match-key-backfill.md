# Plan: re-key the album-written tracks (spec §4.1.2)

**Status: AWAITING APPROVAL. Nothing has been written. No backfill SQL exists yet —
this file and the read-only `073_verify_album_unsplit_match_keys.sql` are the whole
deliverable.** The code fix (commit `aeeb97e`) corrects NEW rows only.

## What is wrong

`record_dj_album` passed the whole joined byline as one artist
(`t.artist ? [t.artist] : []`), so `"Clifford Brown, Max Roach"` became the primary
and the row was keyed `clifford brown max roach|jordu`. The poll keys the same
recording `clifford brown|jordu`. Two rows for one recording that never group, so
"have I heard this" answers no when the answer is yes.

## ⚠️ AMENDED 2026-09-25 after 073 ran — SQL no longer decides anything

073 returned **94 rows to re-key, 0 merges, 88 album-written, 6 not**, and
**proposed two keys that were wrong**: `Earth, Wind & Fire` -> `earth` and
`Tyler, The Creator` -> `tyler`. Both names were already in `COMMA_ARTIST_NAMES`.
The query could not see that list because it lives in TypeScript, which is §14.6's
two-runtimes drift landing on a frozen key — the worst place it can land.

**So the pipeline changed shape.** `074_dump_rekey_candidates.sql` selects
candidates on a purely STRUCTURAL test (the byline contains a comma, plus the six
`072` video ids) and decides nothing. `scripts/dj-plan-rekey.mjs` imports the
DEPLOYED `splitArtistByline`, `canonicalArtist`, `normalisePart` and
`buildMatchKey`, computes every new key, works out the merges and the new group
leaders, and emits `075` with literal values. One implementation, the live one.

Proven on `scripts/fixtures/dj-rekey-074-sample.json`, which carries one row of
every class:

| input | outcome |
|---|---|
| `Clifford Brown, Max Roach` | re-keyed to `clifford brown\|jordu` |
| `Earth, Wind & Fire`, `Tyler, The Creator` | **no change** — the exception list holds |
| `Art Blakey & The Jazz Messengers, Lee Morgan` | `art blakey\|blues walk` — alias *and* split |
| `Dec 29, 2023`, `Oct 24, 2019`, `…, 1.2M views` | **excluded**, §14.9 |
| the six `Various Artists` | re-keyed from the byline **072** writes |

## Date-as-artist: where it came from, and yes it still happens

`Dec 29, 2023` is **§14.9 again, one field further along**. ytmusicapi returns a
video's subtitle runs as `artists`; for a Topic-channel song those runs are real
artists, and for an ordinary uploaded video they are `channel · views · upload
date`. §14.9 already records `"Jazz and Blues Experience, 1.7M views"` from the
same source.

**The writer is `record_dj_playlist`, via `workshop/scripts/dj_import_playlists.py`**,
which passes `[a["name"] for a in t["artists"]]` straight through;
`dj-playlists.ts:261` filters only by *type* (`typeof a === "string"`), never by
content. **Nothing has changed, so it still does it** — any playlist import
containing non-Topic videos will mint more. Not fixed here: it is neither of the
two things you asked for, and a guard on that path is its own decision. Say the
word and it is a small change.

**These rows are excluded from the backfill.** Re-keying `Dec 29, 2023` to
`dec 29` is meaningless — the *artist* is wrong, and repairing that is a
hand-built value table, the shape of 007, not this migration.

## How many rows, and which

**Unknown until you run 073.** I cannot read the database and will not guess a
number into a plan. 073 returns, in one cell:

| key | what it answers |
|---|---|
| `affected_count` | rows to re-key, distinct old keys, date range |
| `affected_rows` | each row with its old key and proposed new key (first 200) |
| `would_merge_into_existing_group` | the ones that join an existing group — the risk |
| `dependents` | plays, playlist rows, album rows, rows pointing at an affected leader |
| `artist_tag_rows_for_affected_bylines` | measures that `dj_artist_tags` is untouched |
| `album_written_cross_check` | the heuristic against the structural fact — see below |

**Read `album_written_cross_check` before anything else.** `affected` infers the
defect from the SHAPE of the stored key; this asks whether the album path wrote the
row at all. `affected_and_album_written` is the confident population.
`affected_not_album_written` is rows the heuristic caught that no album wrote —
either another writer shares the defect or the SQL approximation over-matches, and
**those do not get re-keyed until we know which.** `album_written_not_affected` is
album rows already keyed right, which is what a single-artist album looks like.

⚠️ 073's primary-artist derivation is an SQL APPROXIMATION of `normalisePart`. It is
for SIZING only. The backfill itself must compute every new key with the real
TypeScript function — a second normaliser in SQL is the §14.6 drift, and the
`Earth, Wind & Fire` exception list lives in TypeScript and has no SQL equivalent.

## Which tables

- **`dj_tracks`** — the only table written. `match_key` on the affected rows, and
  `canonical_track_id` on every row in an affected group.
- **`dj_plays`, `dj_playlist_tracks`** — hold `track_id`, never `match_key`.
  **Not rewritten.** Still affected in MEANING: regrouping changes what a
  familiarity read returns for them, which is the point.
- **`dj_album_tracks`** — holds `video_id`, **not** `track_id` (023), and joins to
  `dj_tracks` through it. Not rewritten either. ⚠️ I asserted `track_id` here in
  the first draft and 073 failed on it in the SQL editor; the corrected query uses
  `video_id`, and that same column now gives the backfill a STRUCTURAL way to
  identify album-written rows rather than inferring them from key shape — see
  `album_written_cross_check`.
- **`dj_artist_tags`** — joins on the artist STRING. Untouched, and 073 measures it.
- **`dj_albums`** — no artist text column at all (023). Untouched.
- **`dj_known_disagreements`** — untouched. Its rows are decided verdicts, not keys.

## Merges and collisions

**There is no unique index on `match_key`** (only `(user_id, video_id)`), so a
re-key cannot fail on a constraint. "Collision" here means a semantic MERGE: the
affected row's new key already belongs to a group. **That merge is the goal**, not
an accident — it is the poll's row for the same recording.

Resolution is `dj-tracks.ts`'s own rule, applied exactly as migration 007 applied
it: within a `match_key`, the **earliest-created row leads** (`canonical_track_id`
null) and every other points directly at it, `id` breaking a `created_at` tie. The
rebuild is scoped to the keys being joined **and** the keys being vacated — a
vacated key can lose its leader, and rebuilding around a stale leader is how 007's
Deck the Halls split would have gone wrong.

⚠️ **A merge changes play history.** Two rows becoming one group means their plays
count as one track's. `days_since_last` for the merged group becomes the MORE
RECENT of the two. That is correct and it will change numbers you have seen.

## Rollback

Same shape as 007: a `create temporary table … as select id, match_key,
canonical_track_id from dj_tracks where <affected>` snapshot taken as **step 1,
before any write**, and written out to the migration file as literal VALUES so it
survives the session. Reversal is an `update … from` off that snapshot, then the
same canonical rebuild over the same key set. Nothing is deleted at any point, so
rollback is always available.

## Gate

After running it: `node scripts/dj-grouping-check.js`. **CROSS_KEY must be 0.** 007
treats that as a gate rather than a formality, and this backfill merges groups,
which is precisely the operation that can produce a CROSS_KEY violation.

## Sequence

1. **072** — repairs the six `Various Artists` bylines. **Must precede 075**, which
   takes their keys from the byline 072 writes.
2. **074** — read-only dump. Paste the single result cell back.
3. I run `scripts/dj-plan-rekey.mjs` on it. It writes **075** and prints exactly
   which rows re-key, which are already correct, which are excluded and why, and
   which merge. You see that list before anything runs.
4. You run 075's four steps in order: snapshot, re-key, canonical rebuild, verify.
   I run nothing.
5. `node scripts/dj-grouping-check.js`, CROSS_KEY = 0.
6. Spec §4.1.2 gets the entry saying what moved and why.

## The residual this does not fix

An act whose name contains a comma and is **not** in `COMMA_ARTIST_NAMES` still
gets a truncated primary from the album path and a whole one from the poll. The
list holds the six known cases. This is narrower than the bug being fixed, not a
new kind of one, and 073's `affected_rows` is where a seventh would show up.
