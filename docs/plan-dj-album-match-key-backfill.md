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

⚠️ 073's primary-artist derivation is an SQL APPROXIMATION of `normalisePart`. It is
for SIZING only. The backfill itself must compute every new key with the real
TypeScript function — a second normaliser in SQL is the §14.6 drift, and the
`Earth, Wind & Fire` exception list lives in TypeScript and has no SQL equivalent.

## Which tables

- **`dj_tracks`** — the only table written. `match_key` on the affected rows, and
  `canonical_track_id` on every row in an affected group.
- **`dj_plays`, `dj_playlist_tracks`, `dj_album_tracks`** — hold `track_id`, never
  `match_key`. **Not rewritten.** They are still affected in MEANING: regrouping
  changes what a familiarity read returns for them, which is the point.
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

## Sequence, once approved

1. Run 073. Paste the result back.
2. I write the backfill as numbered migrations: snapshot, re-key, canonical
   rebuild, verify — **one statement per step**.
3. You run them in order, in the SQL editor. I run nothing.
4. `dj-grouping-check.js`, CROSS_KEY = 0.
5. Spec §4.1.2 gets the entry saying what moved and why.

## The residual this does not fix

An act whose name contains a comma and is **not** in `COMMA_ARTIST_NAMES` still
gets a truncated primary from the album path and a whole one from the poll. The
list holds the six known cases. This is narrower than the bug being fixed, not a
new kind of one, and 073's `affected_rows` is where a seventh would show up.
