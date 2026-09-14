# Runbook — DJ Phase 3b: the Weezer rebuild

**Paste this whole file into a FRESH conversation.** It is self-contained; you do not need
prior context. Reference docs are `docs/technical-spec-dj.md` and `docs/progress-dj.md`.

---

## What you are doing

The "Weezer Concert" playlist in YouTube Music is broken: **160 entries but only 50 distinct
songs.** It is a 49-song block repeated three times with a 13-song head — a discography dump,
not a setlist. You are building a correct 12-song concert setlist alongside it and recording
it in Supabase.

**This is the first time this system writes to YouTube Music.** It was chosen as the first
write target because there is nothing to lose.

## Rules

1. **Do NOT delete or modify the old playlist.** It stays as a lookup table of 50
   already-resolved video ids. Its id is `PLV2XoCH1Pv5yDqInwdzIcBZgbVjNkrfzU`.
2. **Nothing is created until Alex approves the twelve resolutions.** Steps 1–3 are reads.
   Step 4 is a full stop.
3. **Follow steps in order. Stop at the first failure and report it.**
4. **Every acceptance criterion below is literal.** Compare against the quoted value; do not
   paraphrase a criterion and then judge yourself against the paraphrase.
5. **Do not mark Phase 3b complete.** Report and wait.

---

## The target setlist — body zone, in this order

From the 2026 promo run (the same set played at Allegiant Stadium, Las Vegas, April 2026).

```
1.  My Name Is Jonas
2.  Undone - The Sweater Song
3.  Pork and Beans
4.  Beverly Hills
5.  Hash Pipe
6.  Island in the Sun
7.  Happy Together
8.  Shine Again
9.  Go Away
10. I Just Threw Out the Love of My Dreams
11. Say It Ain't So
12. Buddy Holly
```

**Twelve is knowingly short** — a touring Weezer show runs ~90 minutes and 18–22 songs.
WEEZER: The Gathering opens 8 September 2026, so no real tour setlist exists yet. **Do not
search the web for one.** Phase 7 fills the gap from setlist.fm once real shows have
happened; the Vegas date is late in the run, which is what makes that work.

### Four titles are already resolved — verified against the catalogue 2026-08-28

Use these directly. Do **not** re-search them.

| # | Title | video_id | Album |
|---|---|---|---|
| 7 | Happy Together | `_PYx8y5QMA4` | Weezer (Teal Album) |
| 8 | Shine Again | `xgtGpafvvcs` | Shine Again |
| 9 | Go Away | `6pMf91N1tNU` | Everything Will Be Alright In The End |
| 10 | I Just Threw Out the Love of My Dreams | `r2dosVRzLSM` | Pinkerton - Deluxe Edition |

⚠️ These four are the traps, which is why they are pre-resolved:

- **Happy Together** is a Turtles song. **Six** distinct recordings share that exact title —
  Weezer, The Turtles, Gerard Way, Filter, Johnny Cash, King Princess w/ Mark Ronson.
- **Go Away** is credited **`feat. Best Coast`**, not "with Bethany Cosentino". Same person;
  searching her name misses it.
- **I Just Threw Out the Love of My Dreams** is a Pinkerton deluxe B-side, and
  ASIAN KUNG-FU GENERATION have a track under the same title.
- **Shine Again** is current material on an album of the same name.

---

## Step 0 — Confirm the host

```
get_workshop_status   (no arguments)
```

**Acceptance:** `host` is `"desktop"`; the tool list includes `search_dj_music`,
`create_dj_playlist`, `edit_dj_playlist`, `remove_from_dj_playlist`;
`dependencies.ytmusicapi.credential_readable` is `true`.

---

## Step 1 — Read the old playlist (read-only)

```
get_dj_playlists
  mode: "contents"
  playlist_id: "PLV2XoCH1Pv5yDqInwdzIcBZgbVjNkrfzU"
  limit: 200
```

**Acceptance:** `track_count` is `160`, `returned` is `160`, no truncation NOTE.

⚠️ **Those 160 entries are only 50 distinct songs.** Deduplicate by `video_id` before
using them for anything. Treating the list as 160 songs is wrong by a factor of three.

---

## Step 2 — Mine the twelve from what you just read

For each of the eight titles not already resolved above, look for a match among the 50
distinct entries.

**Match on artist AND title, never title alone.** Every entry here should be Weezer, but
check rather than assume — these ids were resolved by an unknown earlier process.

Record for each: title, artist, album, `video_id`, `duration_seconds`, and **where it came
from** (`old_playlist` or `pre_resolved`).

---

## Step 3 — Search only for what is still missing

For any title Step 2 did not find:

```
search_dj_music
  query: "Weezer <title>"
  filter: "songs"
  limit: 10
```

**⚠️ Search cannot fail, only be wrong.** It always returns something. Title collisions are
routine, not an edge case.

**THE ARTIST MUST BE MATCHED, NOT MERELY NOTICED.** A result whose `artists` are not Weezer
is a NON-match however well the title fits.

**Where the top results disagree on artist, record the alternatives you rejected**, not just
the one you picked. Alex has asked to see them — a pick presented alone hides that it was
chosen from six plausible candidates.

---

## Step 4 — 🛑 FULL STOP. Present all twelve for approval.

**Create nothing yet.** Present a table of all twelve in setlist order:

| # | Title | Artist | Album | video_id | Duration | Source | Alternatives rejected |
|---|---|---|---|---|---|---|---|

- **Source** is `pre_resolved`, `old_playlist`, or `search`.
- **Alternatives rejected** matters most for anything from `search`. Say "none — only Weezer
  results" where that is true.
- Flag any title you are less than confident about, explicitly.

**Two checks to run and report before Alex reads the table:**
- **No duplicate `video_id`s across the twelve.** Two setlist entries resolving to the same
  id means one is wrong.
- **All twelve resolved.** If any is unresolved, say so — do not substitute something close.

**Then wait.** Do not proceed to Step 5 without explicit approval.

---

## Step 5 — Create the playlist (only after approval)

```
create_dj_playlist
  title: "Weezer Concert 2026"
  description: "WEEZER: The Gathering — Las Vegas, 15 Oct 2026. Body zone, setlist order."
  privacy: "UNLISTED"
  video_ids: [<the twelve, in setlist order>]
```

⚠️ **`privacy` must be `"UNLISTED"`.** The tool defaults to PRIVATE; the original playlist
and the other concert playlists are UNLISTED.

**Acceptance:** a `playlist_id` comes back and `tracks_added` is `12`.

---

## Step 6 — Verify order in the data, then capture the handles

```
get_dj_playlists
  mode: "contents"
  playlist_id: "<the new playlist_id>"
  limit: 200
```

**Acceptance, all four:**
- `track_count` is `12`
- The twelve `video_id`s appear in **exactly the setlist order above** — check position by
  position, do not skim
- Every entry has a non-null `set_video_id`
- No `video_id` appears twice

⚠️ If the order is wrong, **do not delete and retry.** Report it — `create_dj_playlist`
adding in order is a property worth knowing the truth about, and `edit_dj_playlist`
mode `move` can fix ordering without a rebuild.

---

## Step 7 — Record it in Supabase

The concert row **already exists** — do not create another:
`c3085a27-6b73-4dd4-b24b-06412526c168` (Weezer, WEEZER: The Gathering, 2026-10-15,
`committed`).

```
record_dj_playlist
  yt_playlist_id: "<the new playlist_id>"
  name: "Weezer Concert 2026"
  kind: "concert"
  concert_id: "c3085a27-6b73-4dd4-b24b-06412526c168"
  description: "WEEZER: The Gathering — Las Vegas, 15 Oct 2026."
  tracks: [
    { video_id, title, artists: [...], album, duration_seconds,
      role: "body", position: <1..12>, yt_set_video_id: <from step 6>,
      added_reason: "import" },
    ...
  ]
```

**All twelve are `role: "body"`. Positions are 1 to 12.** There is no cram zone yet — cram
is phase 7's job.

**Acceptance, all four:**
- `playlist_created` is `true`
- `by_role` is `{ "body": 12, "cram": 0 }`
- `membership_rows_written` is `12`
- `tracks_created` + tracks already known equals `12`

**Report `canonical_links_made` and the contents of `canonical_links`.** If it is `0`, say
**"canonical linking NOT EXERCISED — no variant pair among the twelve"** rather than calling
it passed. A gate that passes because it was never triggered is worse than one openly
deferred.

---

## Step 8 — Verify in the YouTube Music app

Ask Alex to open YouTube Music and confirm the playlist appears with the twelve songs in the
right order. **The data being right and the app showing it right are different claims.**

---

## Step 9 — Report

1. **Step-by-step pass/fail** against the literal criteria above.
2. **The twelve as written**, with sources.
3. **`canonical_links_made`** as EXERCISED or NOT EXERCISED, with the reason.
4. **Confirm the old playlist is untouched** — still 160 entries, still named
   "Weezer Concert".
5. **Anything that surprised you.** Every phase so far has turned up something only live
   data showed: `limit` being a fetch hint, `count` arriving as a string, a run that
   finished before it started, one entry per track per bucket, a six-way title collision.
   Assume there is one here and go looking.

Then propose the `progress-dj.md` edits and **wait for Alex to confirm.**
